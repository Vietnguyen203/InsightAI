import { Injectable, Logger } from '@nestjs/common';
import {
  analysisPlanSchema,
  type InvestigationStatus,
  Permission,
  TERMINAL_INVESTIGATION_STATUSES,
} from '@insightai/contracts';
import { uuidv7 } from '../../platform/crypto/ids';
import { AppError, QueryRejectedError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { PrismaService } from '../../platform/prisma/prisma.service';
import type { InvestigationJobData } from '../../platform/queue/queues';
import type { Prisma } from '../../generated/prisma/client';
import { LlmError } from '../ai/llm-provider';
import { MembershipService } from '../iam/membership.service';
import { SemanticMetricService } from '../semantic/semantic-metric.service';
import { AnalysisToolsService, type ToolOutput } from './analysis-tools.service';
import { InvestigationEventsService } from './investigation-events.service';
import { estimatedQueries, toolInput } from './plan-validator';
import { PlannerService } from './planner.service';

export interface Budget {
  maxSteps: number;
  maxQueries: number;
  maxTokens: number;
  maxDurationMs: number;
}
export interface Usage {
  steps: number;
  queries: number;
  tokens: number;
  durationMs: number;
}
export interface Pinned {
  modelRevision: number;
  metrics: Record<string, number>;
}

const MAX_STEP_ATTEMPTS = 3;
const ACTIVE: InvestigationStatus[] = ['QUEUED', 'PLANNING', 'AWAITING_APPROVAL', 'RUNNING'];

/** A stop condition reached between steps: the run ends with this status and code. */
class Stop extends Error {
  constructor(
    readonly status: 'CANCELLED' | 'PARTIAL' | 'FAILED',
    readonly code: string | null,
    readonly detail: string | null = null,
  ) {
    super(code ?? status);
    this.name = 'Stop';
  }
}

/**
 * Runs an investigation as its author (docs/PHASE6_AI_ANALYST_DESIGN.md §2.5, §2.11): plan →
 * (approval) → steps. Every transition is persisted, so a job retried after a worker restart
 * resumes where it stopped and never repeats a finished step. Permissions, the model revision
 * and metric versions are checked again before every step.
 */
@Injectable()
export class InvestigationOrchestrator {
  private readonly logger = new Logger(InvestigationOrchestrator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memberships: MembershipService,
    private readonly metrics: SemanticMetricService,
    private readonly planner: PlannerService,
    private readonly tools: AnalysisToolsService,
    private readonly events: InvestigationEventsService,
  ) {}

  async run(
    job: InvestigationJobData,
    isFinalAttempt: boolean,
  ): Promise<InvestigationStatus | 'skipped'> {
    const db = { organizationId: job.organizationId, userId: job.userId };
    // A job whose ids do not belong together sees nothing (RLS on organization and author).
    const found = await this.load(db, job.investigationId);
    if (!found || TERMINAL_INVESTIGATION_STATUSES.includes(found.status)) return 'skipped';
    const id = found.id;
    try {
      if (found.cancelRequested) return await this.finish(db, id, new Stop('CANCELLED', null));
      let ctx = await this.context(job);
      if (found.status === 'QUEUED' || found.status === 'PLANNING') {
        const next = await this.planPhase(ctx, db, id);
        if (next !== 'RUNNING') return next;
      }
      const current = await this.load(db, id);
      if (current?.status !== 'RUNNING') return current?.status ?? 'skipped';
      ctx = await this.context(job);
      return await this.runSteps(ctx, db, id);
    } catch (error) {
      if (error instanceof Stop) return this.finish(db, id, error);
      if (!isFinalAttempt) throw error; // BullMQ retries; finished steps are not repeated
      this.logger.error({ err: error }, 'Investigation failed');
      const code = error instanceof LlmError ? 'AI_PROVIDER_ERROR' : 'INTERNAL_ERROR';
      return this.finish(db, id, new Stop('FAILED', code));
    }
  }

  // ─── Planning ──────────────────────────────────────────────────────────────

  private async planPhase(
    ctx: TenantContext,
    db: { organizationId: string; userId: string },
    id: string,
  ): Promise<InvestigationStatus> {
    await this.update(
      db,
      id,
      ['QUEUED', 'PLANNING'],
      { status: 'PLANNING', startedAt: new Date() },
      true,
    );
    await this.events.emit(db, id, { type: 'status', status: 'PLANNING' });
    const inv = (await this.load(db, id))!;
    const catalog = await this.metrics.catalog(ctx, inv.model.key);
    const org = await this.prisma.runInTenant(ctx.organizationId, (tx) =>
      tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } }),
    );
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone }).format(new Date());
    const budget = inv.budget as unknown as Budget;
    const usage = inv.usage as unknown as Usage;

    const outcome = await this.planner.plan(ctx, {
      goal: inv.goal,
      catalog,
      today,
      timezone: org.timezone,
      maxTokens: budget.maxTokens - usage.tokens,
    });
    const nextUsage = { ...usage, tokens: usage.tokens + outcome.tokens };
    await this.update(db, id, ['PLANNING'], {
      usage: nextUsage,
    });
    if (outcome.status === 'not_possible') {
      throw new Stop('FAILED', 'PLAN_NOT_POSSIBLE', outcome.reason);
    }
    if (outcome.status === 'invalid') {
      const codes = [...new Set(outcome.errors.map((e) => e.code))].join(', ');
      throw new Stop('FAILED', 'PLAN_INVALID', codes || null);
    }

    const pinned: Pinned = {
      modelRevision: catalog.model.revision,
      metrics: Object.fromEntries(catalog.metrics.map((m) => [m.key, m.version])),
    };
    const next: InvestigationStatus = inv.requireApproval ? 'AWAITING_APPROVAL' : 'RUNNING';
    await this.prisma.runInContext(db, async (tx) => {
      await tx.investigationStep.deleteMany({ where: { investigationId: id } });
      await tx.investigationStep.createMany({
        data: outcome.plan.steps.map((step, position) => ({
          id: uuidv7(),
          organizationId: db.organizationId,
          investigationId: id,
          stepKey: step.id,
          position,
          tool: step.tool,
          purpose: step.purpose,
          queryHistoryIds: [],
        })),
      });
      await tx.investigation.update({
        where: { id },
        data: {
          plan: outcome.plan,
          pinned: pinned as unknown as Prisma.InputJsonObject,
          status: next,
        },
      });
    });
    await this.events.emit(db, id, {
      type: 'plan_ready',
      steps: outcome.plan.steps.length,
      requiresApproval: inv.requireApproval,
    });
    await this.events.emit(db, id, { type: 'status', status: next });
    return next;
  }

  // ─── Steps ─────────────────────────────────────────────────────────────────

  private async runSteps(
    ctx: TenantContext,
    db: { organizationId: string; userId: string },
    id: string,
  ): Promise<InvestigationStatus> {
    const inv = (await this.load(db, id))!;
    const plan = analysisPlanSchema.parse(inv.plan);
    const byKey = new Map(plan.steps.map((s) => [s.id, s]));

    for (const step of plan.steps) {
      const state = await this.load(db, id);
      if (!state) return 'CANCELLED'; // deleted while running
      const row = state.steps.find((s) => s.stepKey === step.id)!;
      if (row.status === 'SUCCEEDED' || row.status === 'FAILED' || row.status === 'SKIPPED')
        continue;

      if (state.cancelRequested) {
        await this.skipRemaining(db, id, 'CANCELLED');
        throw new Stop('CANCELLED', null);
      }
      const budget = state.budget as unknown as Budget;
      const usage = state.usage as unknown as Usage;
      const elapsed = Date.now() - (state.startedAt?.getTime() ?? Date.now());
      const catalog0 = await this.metrics.catalog(ctx, state.model.key);
      if (
        elapsed > budget.maxDurationMs ||
        usage.queries + estimatedQueries(step, catalog0) > budget.maxQueries
      ) {
        await this.skipRemaining(db, id, 'BUDGET_EXCEEDED');
        throw new Stop('PARTIAL', 'BUDGET_EXCEEDED');
      }

      // Authorization and definitions are re-checked before every step.
      ctx = await this.context({ ...db, investigationId: id });
      if (!ctx.permissions.has(Permission.SEMANTIC_QUERY)) {
        await this.skipRemaining(db, id, 'FORBIDDEN');
        throw new Stop('FAILED', 'FORBIDDEN');
      }
      const catalog = await this.metrics.catalog(ctx, state.model.key);
      const pinned = state.pinned as unknown as Pinned;
      const versions = new Map(catalog.metrics.map((m) => [m.key, m.version]));
      if (
        catalog.model.revision !== pinned.modelRevision ||
        Object.entries(pinned.metrics).some(([k, v]) => versions.has(k) && versions.get(k) !== v)
      ) {
        await this.skipRemaining(db, id, 'MODEL_CHANGED');
        throw new Stop('FAILED', 'MODEL_CHANGED');
      }

      // Members chosen by an earlier step (resolved here, never by the model).
      let scopeFilter: { member: string; values: string[] } | undefined;
      if ('scope' in step && step.scope) {
        const ref = state.steps.find((s) => s.stepKey === step.scope!.fromStep);
        if (ref?.status !== 'SUCCEEDED') {
          await this.setStep(db, row.id, {
            status: 'SKIPPED',
            errorCode: 'DEPENDENCY_FAILED',
            finishedAt: new Date(),
          });
          await this.events.emit(db, id, {
            type: 'step_skipped',
            stepKey: step.id,
            code: 'DEPENDENCY_FAILED',
          });
          continue;
        }
        const refStep = byKey.get(step.scope.fromStep)!;
        const values = pickMembers(
          ref.output as unknown as ToolOutput,
          step.scope.pick,
          step.scope.k,
        );
        if (values.length === 0) {
          await this.setStep(db, row.id, {
            status: 'SKIPPED',
            errorCode: 'NO_MEMBERS',
            finishedAt: new Date(),
          });
          await this.events.emit(db, id, {
            type: 'step_skipped',
            stepKey: step.id,
            code: 'NO_MEMBERS',
          });
          continue;
        }
        scopeFilter = { member: (refStep as { dimension: string }).dimension, values };
      }

      const attempt = row.attempt + 1;
      if (attempt > MAX_STEP_ATTEMPTS) {
        await this.setStep(db, row.id, {
          status: 'FAILED',
          errorCode: 'RETRIES_EXHAUSTED',
          finishedAt: new Date(),
        });
        await this.events.emit(db, id, {
          type: 'step_failed',
          stepKey: step.id,
          code: 'RETRIES_EXHAUSTED',
        });
        continue;
      }
      const input = toolInput(state.model.key, step, scopeFilter);
      await this.setStep(db, row.id, {
        status: 'RUNNING',
        attempt,
        startedAt: new Date(),
        input: input as unknown as Prisma.InputJsonObject,
      });
      await this.events.emit(db, id, { type: 'step_started', stepKey: step.id, tool: step.tool });

      try {
        const run = await this.tools.run(ctx, input);
        await this.setStep(db, row.id, {
          status: 'SUCCEEDED',
          output: run.output as unknown as Prisma.InputJsonObject,
          queryHistoryIds: run.results.map((r) => r.queryHistoryId).filter((x): x is string => !!x),
          finishedAt: new Date(),
        });
        await this.addUsage(db, id, { steps: 1, queries: run.queries.length });
        await this.events.emit(db, id, { type: 'step_completed', stepKey: step.id });
      } catch (error) {
        // A rejected query is an answer about this step (e.g. a policy hides a member),
        // not a crash: record it and go on with the steps that do not depend on it.
        if (!(error instanceof QueryRejectedError)) throw error;
        const reason = error.errors?.[0]?.path?.replace(/^reason\./, '') ?? 'QUERY_REJECTED';
        await this.setStep(db, row.id, {
          status: 'FAILED',
          errorCode: reason,
          finishedAt: new Date(),
        });
        await this.events.emit(db, id, { type: 'step_failed', stepKey: step.id, code: reason });
      }
    }

    const final = (await this.load(db, id))!;
    const complete = final.steps.every((s) => s.status === 'SUCCEEDED');
    return this.finish(db, id, complete ? null : new Stop('PARTIAL', 'STEPS_INCOMPLETE'));
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private load(db: { organizationId: string; userId: string }, id: string) {
    return this.prisma.runInContext(db, (tx) =>
      tx.investigation.findUnique({
        where: { id },
        include: { model: { select: { key: true } }, steps: { orderBy: { position: 'asc' } } },
      }),
    );
  }

  /** The author's current membership: role changes and removals apply to the next step. */
  private async context(job: InvestigationJobData): Promise<TenantContext> {
    try {
      const membership = await this.memberships.resolve(job.userId, job.organizationId);
      return {
        ...membership,
        userId: job.userId,
        sessionId: `investigation:${job.investigationId}`,
        requestId: undefined,
        ip: undefined,
        userAgent: undefined,
      };
    } catch (error) {
      if (error instanceof AppError && error.status === 403) throw new Stop('FAILED', 'FORBIDDEN');
      throw error;
    }
  }

  private async update(
    db: { organizationId: string; userId: string },
    id: string,
    from: InvestigationStatus[],
    data: Prisma.InvestigationUpdateManyMutationInput,
    keepStartedAt = false,
  ) {
    await this.prisma.runInContext(db, async (tx) => {
      const current = await tx.investigation.findUnique({
        where: { id },
        select: { startedAt: true },
      });
      const { startedAt: _ignored, ...rest } = data;
      await tx.investigation.updateMany({
        where: { id, status: { in: from } },
        data: keepStartedAt && current?.startedAt ? rest : data,
      });
    });
  }

  private setStep(
    db: { organizationId: string; userId: string },
    stepId: string,
    data: Prisma.InvestigationStepUpdateInput,
  ) {
    return this.prisma.runInContext(db, (tx) =>
      tx.investigationStep.update({ where: { id: stepId }, data }),
    );
  }

  private async addUsage(
    db: { organizationId: string; userId: string },
    id: string,
    delta: Partial<Usage>,
  ) {
    const usage = await this.prisma.runInContext(db, async (tx) => {
      const inv = await tx.investigation.findUniqueOrThrow({ where: { id } });
      const current = inv.usage as unknown as Usage;
      const next: Usage = {
        steps: current.steps + (delta.steps ?? 0),
        queries: current.queries + (delta.queries ?? 0),
        tokens: current.tokens + (delta.tokens ?? 0),
        durationMs: inv.startedAt ? Date.now() - inv.startedAt.getTime() : 0,
      };
      await tx.investigation.update({
        where: { id },
        data: { usage: next as unknown as Prisma.InputJsonObject },
      });
      return next;
    });
    await this.events.emit(db, id, { type: 'budget', usage });
  }

  private async skipRemaining(
    db: { organizationId: string; userId: string },
    id: string,
    code: string,
  ) {
    await this.prisma.runInContext(db, (tx) =>
      tx.investigationStep.updateMany({
        where: { investigationId: id, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'SKIPPED', errorCode: code, finishedAt: new Date() },
      }),
    );
  }

  /** Ends the run once (later calls see a terminal status and change nothing). */
  private async finish(
    db: { organizationId: string; userId: string },
    id: string,
    stop: Stop | null,
  ): Promise<InvestigationStatus> {
    const status: InvestigationStatus = stop?.status ?? 'COMPLETED';
    const changed = await this.prisma.runInContext(db, async (tx) => {
      const inv = await tx.investigation.findUnique({ where: { id } });
      if (!inv || !ACTIVE.includes(inv.status)) return false;
      const usage = {
        ...(inv.usage as unknown as Usage),
        durationMs: inv.startedAt ? Date.now() - inv.startedAt.getTime() : 0,
      };
      await tx.investigation.update({
        where: { id },
        data: {
          status,
          errorCode: stop?.code ?? null,
          errorMessage: stop?.detail ?? null,
          finishedAt: new Date(),
          usage: usage,
        },
      });
      return true;
    });
    if (changed) {
      if (stop?.code) await this.events.emit(db, id, { type: 'error', code: stop.code });
      await this.events.emit(db, id, { type: 'status', status });
      await this.events.emit(db, id, { type: 'done', status });
    }
    return status;
  }
}

/** Members picked from an earlier step's deterministic output. */
export function pickMembers(
  output: ToolOutput | null,
  pick: 'top_contributors' | 'top_decliners' | 'anomalous_members',
  k: number,
): string[] {
  if (!output) return [];
  const named = (values: { member: string | null; score: number }[], positive: boolean) =>
    values
      .filter((v) => v.member !== null && (positive ? v.score > 0 : v.score < 0))
      .sort((a, b) => (positive ? b.score - a.score : a.score - b.score))
      .slice(0, k)
      .map((v) => v.member!);
  if (output.tool === 'contribution' && pick !== 'anomalous_members') {
    const values =
      output.kind === 'additive'
        ? output.contribution.members.map((m) => ({ member: m.member, score: Number(m.delta) }))
        : output.decomposition.members.map((m) => ({ member: m.member, score: m.effect }));
    return named(values, pick === 'top_contributors');
  }
  if (output.tool === 'anomaly' && pick === 'anomalous_members') {
    return output.reports
      .filter((r) => r.member !== null && r.anomalies.length > 0)
      .sort((a, b) => b.anomalies.length - a.anomalies.length)
      .slice(0, k)
      .map((r) => r.member!);
  }
  return [];
}
