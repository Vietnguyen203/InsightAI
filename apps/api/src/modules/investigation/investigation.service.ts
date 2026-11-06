import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import {
  analysisPlanSchema,
  ErrorCode,
  type InvestigationDetail,
  type InvestigationStatus,
  type InvestigationSummary,
  TERMINAL_INVESTIGATION_STATUSES,
} from '@insightai/contracts';
import type { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.module';
import { uuidv7 } from '../../platform/crypto/ids';
import { AppError, ConflictError, NotFoundError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { type DbTransaction, PrismaService } from '../../platform/prisma/prisma.service';
import {
  type InvestigationJobData,
  InvestigationJobName,
  investigationJobId,
  QueueName,
} from '../../platform/queue/queues';
import type { Investigation, InvestigationStep } from '../../generated/prisma/client';
import { InvestigationEventsService } from './investigation-events.service';
import { DEFAULT_BUDGET } from './plan-validator';
import { PlannerService } from './planner.service';

export class InvestigationUnavailableError extends AppError {
  readonly status = 503;
  readonly code = ErrorCode.AI_UNAVAILABLE;
}
export class InvestigationLimitError extends AppError {
  readonly status = 429;
  readonly code = ErrorCode.RATE_LIMITED;
}

const ACTIVE: InvestigationStatus[] = ['QUEUED', 'PLANNING', 'AWAITING_APPROVAL', 'RUNNING'];

/** API side of investigations: create, read, approve, cancel, delete (private to the author). */
@Injectable()
export class InvestigationService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly planner: PlannerService,
    private readonly events: InvestigationEventsService,
    @InjectQueue(QueueName.INVESTIGATION) private readonly queue: Queue<InvestigationJobData>,
  ) {}

  private db(ctx: TenantContext) {
    return { organizationId: ctx.organizationId, userId: ctx.userId };
  }

  async create(
    ctx: TenantContext,
    input: { model: string; goal: string; requireApproval: boolean },
  ): Promise<InvestigationDetail> {
    if (!this.planner.available) {
      throw new InvestigationUnavailableError('AI is not configured on this server');
    }
    const id = uuidv7();
    await this.prisma.runInContext(this.db(ctx), async (tx) => {
      // Serialized per user: concurrent requests cannot pass the limits together.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`investigation:${ctx.userId}`}, 0))`;
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      if (
        (await tx.investigation.count({ where: { createdAt: { gte: start } } })) >=
        this.config.INVESTIGATION_DAILY_LIMIT
      ) {
        throw new InvestigationLimitError('The daily investigation limit is reached');
      }
      if (
        (await tx.investigation.count({ where: { status: { in: ACTIVE } } })) >=
        this.config.INVESTIGATION_MAX_ACTIVE
      ) {
        throw new InvestigationLimitError('Too many investigations are running');
      }
      const model = await tx.semanticModel.findUnique({
        where: { organizationId_key: { organizationId: ctx.organizationId, key: input.model } },
      });
      if (!model?.publishedSnapshot) {
        throw new NotFoundError(`No published semantic model "${input.model}"`);
      }
      await tx.investigation.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          semanticModelId: model.id,
          goal: input.goal,
          requireApproval: input.requireApproval,
          budget: DEFAULT_BUDGET,
          usage: { steps: 0, queries: 0, tokens: 0, durationMs: 0 },
        },
      });
    });
    await this.events.emit(this.db(ctx), id, { type: 'status', status: 'QUEUED' });
    await this.enqueue(ctx, id, 'plan');
    return this.get(ctx, id);
  }

  async list(ctx: TenantContext): Promise<InvestigationSummary[]> {
    return this.prisma.runInContext(this.db(ctx), async (tx) => {
      const rows = await tx.investigation.findMany({
        include: { model: { select: { key: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return rows.map(toSummary);
    });
  }

  async get(ctx: TenantContext, id: string): Promise<InvestigationDetail> {
    return this.prisma.runInContext(this.db(ctx), async (tx) => toDetail(await this.find(tx, id)));
  }

  /** Starts the steps of a plan that waits for approval. */
  async approve(ctx: TenantContext, id: string): Promise<InvestigationDetail> {
    await this.prisma.runInContext(this.db(ctx), async (tx) => {
      await this.find(tx, id);
      const { count } = await tx.investigation.updateMany({
        where: { id, status: 'AWAITING_APPROVAL' },
        data: { status: 'RUNNING' },
      });
      if (count === 0) throw new ConflictError('The plan is not waiting for approval');
    });
    await this.events.emit(this.db(ctx), id, { type: 'status', status: 'RUNNING' });
    await this.enqueue(ctx, id, 'run');
    return this.get(ctx, id);
  }

  async cancel(ctx: TenantContext, id: string): Promise<InvestigationDetail> {
    const stoppedNow = await this.prisma.runInContext(this.db(ctx), async (tx) => {
      const inv = await this.find(tx, id);
      if (TERMINAL_INVESTIGATION_STATUSES.includes(inv.status)) {
        throw new ConflictError('The investigation has already ended');
      }
      // Not running anywhere: stop at once. Running: the worker stops before the next step.
      const idle = inv.status === 'QUEUED' || inv.status === 'AWAITING_APPROVAL';
      await tx.investigation.update({
        where: { id },
        data: idle
          ? { status: 'CANCELLED', cancelRequested: true, finishedAt: new Date() }
          : { cancelRequested: true },
      });
      if (idle) {
        await tx.investigationStep.updateMany({
          where: { investigationId: id, status: 'PENDING' },
          data: { status: 'SKIPPED', errorCode: 'CANCELLED' },
        });
      }
      return idle;
    });
    if (stoppedNow) {
      await this.events.emit(this.db(ctx), id, { type: 'status', status: 'CANCELLED' });
      await this.events.emit(this.db(ctx), id, { type: 'done', status: 'CANCELLED' });
    }
    return this.get(ctx, id);
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    await this.prisma.runInContext(this.db(ctx), async (tx) => {
      const inv = await this.find(tx, id);
      if (!TERMINAL_INVESTIGATION_STATUSES.includes(inv.status)) {
        throw new ConflictError('Cancel the investigation before deleting it');
      }
      await tx.investigation.delete({ where: { id } });
    });
  }

  /** Throws 404 for investigations of other users or organizations (RLS hides them). */
  async assertVisible(ctx: TenantContext, id: string): Promise<InvestigationStatus> {
    return this.prisma.runInContext(this.db(ctx), async (tx) => (await this.find(tx, id)).status);
  }

  private async find(tx: DbTransaction, id: string) {
    const inv = await tx.investigation.findUnique({
      where: { id },
      include: { model: { select: { key: true } }, steps: { orderBy: { position: 'asc' } } },
    });
    if (!inv) throw new NotFoundError('Investigation not found');
    return inv;
  }

  private async enqueue(ctx: TenantContext, id: string, phase: 'plan' | 'run') {
    await this.queue.add(
      InvestigationJobName.RUN,
      { organizationId: ctx.organizationId, userId: ctx.userId, investigationId: id },
      { jobId: investigationJobId(id, phase) },
    );
  }
}

type Row = Investigation & { model: { key: string } };

function toSummary(i: Row): InvestigationSummary {
  return {
    id: i.id,
    model: i.model.key,
    goal: i.goal,
    status: i.status,
    errorCode: i.errorCode,
    createdAt: i.createdAt.toISOString(),
    finishedAt: i.finishedAt?.toISOString() ?? null,
  };
}

function toDetail(i: Row & { steps: InvestigationStep[] }): InvestigationDetail {
  const plan = i.plan ? analysisPlanSchema.safeParse(i.plan) : null;
  return {
    ...toSummary(i),
    requireApproval: i.requireApproval,
    plan: plan?.success ? plan.data : null,
    pinned: (i.pinned as InvestigationDetail['pinned']) ?? null,
    budget: i.budget as InvestigationDetail['budget'],
    usage: i.usage as InvestigationDetail['usage'],
    cancelRequested: i.cancelRequested,
    errorMessage: i.errorMessage,
    startedAt: i.startedAt?.toISOString() ?? null,
    steps: i.steps.map((s) => ({
      id: s.id,
      stepKey: s.stepKey,
      tool: s.tool,
      purpose: s.purpose,
      status: s.status,
      attempt: s.attempt,
      output: s.output ?? null,
      queryHistoryIds: s.queryHistoryIds,
      errorCode: s.errorCode,
      startedAt: s.startedAt?.toISOString() ?? null,
      finishedAt: s.finishedAt?.toISOString() ?? null,
    })),
  };
}
