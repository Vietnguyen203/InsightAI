import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type {
  Page,
  QualityCheckDetail,
  QualityCheckSummary,
  QualityIssue,
} from '@insightai/contracts';
import type { Queue } from 'bullmq';
import { uuidv7 } from '../../platform/crypto/ids';
import { NotFoundError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { isUniqueViolation } from '../../platform/prisma/prisma-errors';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { QualityJobName, type QualityJobData, QueueName } from '../../platform/queue/queues';
import { toCheckSummary, toRuleResult } from './quality-mappers';
import { QualityRuleService } from './quality-rule.service';

export interface CheckRequest {
  organizationId: string;
  datasetId: string;
  versionId: string;
  trigger: 'IMPORT' | 'MANUAL' | 'CLEANING';
  requestedById: string | null;
}

/** Creates, queues and reads quality checks. Used by the API and by the import worker. */
@Injectable()
export class QualityCheckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: QualityRuleService,
    @InjectQueue(QueueName.QUALITY) private readonly queue: Queue<QualityJobData>,
  ) {}

  /**
   * Queues a check of one version. If a check of that version is already queued or running,
   * that one is returned instead (unique partial index), so repeated requests are harmless.
   */
  async request(input: CheckRequest): Promise<string> {
    const checkId = await this.prisma
      .runInTenant(input.organizationId, async (tx) => {
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: input.organizationId },
        });
        await this.rules.ensureSystemRules(
          tx,
          input.organizationId,
          input.datasetId,
          input.versionId,
          organization.locale,
        );
        const check = await tx.qualityCheck.create({
          data: {
            id: uuidv7(),
            organizationId: input.organizationId,
            datasetId: input.datasetId,
            datasetVersionId: input.versionId,
            trigger: input.trigger,
            requestedById: input.requestedById,
          },
        });
        return check.id;
      })
      .catch(async (error: unknown) => {
        if (!isUniqueViolation(error)) throw error;
        const active = await this.prisma.runInTenant(input.organizationId, (tx) =>
          tx.qualityCheck.findFirstOrThrow({
            where: { datasetVersionId: input.versionId, status: { in: ['PENDING', 'RUNNING'] } },
          }),
        );
        return active.id;
      });

    // Deterministic job id: enqueueing the same check twice is a no-op.
    await this.queue.add(
      QualityJobName.RUN,
      { organizationId: input.organizationId, checkId },
      { jobId: `quality-${checkId}` },
    );
    return checkId;
  }

  /** Runs a check of the active (or given) version on behalf of a user. */
  async requestManual(
    ctx: TenantContext,
    datasetId: string,
    versionId?: string,
  ): Promise<QualityCheckSummary> {
    const target = await this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const dataset = await tx.dataset.findUnique({ where: { id: datasetId } });
      if (!dataset) throw new NotFoundError('Dataset not found');
      const id = versionId ?? dataset.activeVersionId;
      if (!id) throw new NotFoundError('This dataset has no data yet');
      const version = await tx.datasetVersion.findFirst({ where: { id, datasetId } });
      if (!version) throw new NotFoundError('Version not found');
      return version.id;
    });
    const checkId = await this.request({
      organizationId: ctx.organizationId,
      datasetId,
      versionId: target,
      trigger: 'MANUAL',
      requestedById: ctx.userId,
    });
    return this.prisma.runInTenant(ctx.organizationId, async (tx) =>
      toCheckSummary(
        await tx.qualityCheck.findUniqueOrThrow({
          where: { id: checkId },
          include: { version: { select: { versionNo: true } } },
        }),
      ),
    );
  }

  async list(ctx: TenantContext, datasetId: string): Promise<QualityCheckSummary[]> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const dataset = await tx.dataset.findUnique({ where: { id: datasetId } });
      if (!dataset) throw new NotFoundError('Dataset not found');
      const checks = await tx.qualityCheck.findMany({
        where: { datasetId },
        include: { version: { select: { versionNo: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return checks.map(toCheckSummary);
    });
  }

  async get(ctx: TenantContext, checkId: string): Promise<QualityCheckDetail> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const check = await tx.qualityCheck.findUnique({
        where: { id: checkId },
        include: { version: { select: { versionNo: true } }, results: true },
      });
      if (!check) throw new NotFoundError('Quality check not found');
      const results = check.results.map(toRuleResult);
      // Most useful first: failed, then errors/skipped, then passed; worst pass rate first.
      const order = { FAILED: 0, ERROR: 1, SKIPPED: 2, PASSED: 3 } as const;
      results.sort(
        (a, b) => order[a.status] - order[b.status] || (a.passRate ?? 1) - (b.passRate ?? 1),
      );
      return { ...toCheckSummary(check), results };
    });
  }

  async issues(
    ctx: TenantContext,
    checkId: string,
    resultId: string,
    query: { limit: number; after: number },
  ): Promise<Page<QualityIssue>> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const result = await tx.qualityCheckResult.findFirst({
        where: { id: resultId, qualityCheckId: checkId },
      });
      if (!result) throw new NotFoundError('Result not found');
      const rows = await tx.qualityIssue.findMany({
        where: { qualityCheckResultId: resultId, rowId: { gt: BigInt(query.after) } },
        orderBy: { rowId: 'asc' },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((issue) => ({
          rowId: Number(issue.rowId),
          column: issue.columnName,
          value: issue.value,
          rawValue: issue.rawValue,
        })),
        nextCursor: rows.length > query.limit ? String(page.at(-1)?.rowId) : null,
      };
    });
  }
}
