import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type {
  CleaningJob,
  CleaningOperation,
  CleaningPreview,
  cleaningRequestSchema,
} from '@insightai/contracts';
import type { Queue } from 'bullmq';
import type { z } from 'zod';
import { randomBase36, uuidv7 } from '../../platform/crypto/ids';
import { DataPlaneService } from '../../platform/data-plane/data-plane.service';
import { ConflictError, NotFoundError, QueryRejectedError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { type DbTransaction, PrismaService } from '../../platform/prisma/prisma.service';
import {
  cleaningJobId,
  CleaningJobName,
  type CleaningJobData,
  QueueName,
} from '../../platform/queue/queues';
import { AuditService } from '../audit/audit.service';
import { impactSelect } from './cleaning-compiler';
import { toCleaningJobDto } from './cleaning-mappers';
import {
  type CleaningSource,
  compileFor,
  describeCleaningDbError,
  isDataError,
  loadCleaningSource,
} from './cleaning-source';

type CleaningRequestBody = z.output<typeof cleaningRequestSchema>;

/** Preview runs on the whole table (exact impact), bounded by this limit. */
const PREVIEW_STATEMENT_TIMEOUT_MS = 60_000;
const PREVIEW_SAMPLE_ROWS = 50;
/** Columns shown in the before/after sample when only rows are removed. */
const SAMPLE_FALLBACK_COLUMNS = 6;

const jobInclude = {
  operations: { orderBy: { seq: 'asc' } },
  sourceVersion: { select: { versionNo: true } },
  targetVersion: { select: { id: true } },
} as const;

@Injectable()
export class CleaningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataPlane: DataPlaneService,
    private readonly audit: AuditService,
    @InjectQueue(QueueName.CLEANING) private readonly queue: Queue<CleaningJobData>,
  ) {}

  /**
   * Runs the compiled operations read-only: exact counts per operation on the whole table plus
   * before/after values of a sample of changed rows (docs/DATA_QUALITY_DESIGN.md §6.3).
   */
  async preview(
    ctx: TenantContext,
    datasetId: string,
    body: CleaningRequestBody,
  ): Promise<CleaningPreview> {
    const source = await this.prisma.runInTenant(ctx.organizationId, (tx) =>
      this.load(tx, ctx.organizationId, datasetId, body.sourceVersionId, body.operations),
    );
    const compiled = compileFor(source, body.operations);

    const kept = compiled.columns.filter((c) => !c.removed);
    const changed = kept.filter((c) => c.modified);
    const shown = changed.length > 0 ? changed : kept.slice(0, SAMPLE_FALLBACK_COLUMNS);
    const flags = compiled.operations.flatMap((op) => (op.flag ? [`"${op.flag}"`] : []));
    const touched = ['f._del IS NOT NULL', ...flags.map((f) => `f.${f}`)].join(' OR ');

    const { impact, sample } = await this.dataPlane
      .withTenantRead(
        ctx.dataSchema,
        async (client) => {
          const impactRow = (await client.query<Record<string, string>>(impactSelect(compiled)))
            .rows[0]!;
          const before = shown.map((c) => `t."${c.physicalName}"::text`);
          const after = shown.map((c) => `f."${c.physicalName}"::text`);
          const rows = await client.query<
            { row_id: string; removed: boolean } & Record<string, string | null>
          >(
            `${compiled.withClause} SELECT f._row_id AS row_id, f._del IS NOT NULL AS removed, ` +
              `${[...before.map((b, i) => `${b} AS b${i}`), ...after.map((a, i) => `${a} AS a${i}`)].join(', ')} ` +
              `FROM ${compiled.finalStage} f JOIN ${source.sourceTable} t ON t._row_id = f._row_id ` +
              `WHERE ${touched} ORDER BY f._row_id LIMIT ${PREVIEW_SAMPLE_ROWS}`,
          );
          return { impact: impactRow, sample: rows.rows };
        },
        { statementTimeoutMs: PREVIEW_STATEMENT_TIMEOUT_MS },
      )
      .catch((error: unknown) => {
        if (isDataError(error) || (error as { code?: string }).code === '57014') {
          throw new QueryRejectedError(describeCleaningDbError(error));
        }
        throw error;
      });

    return {
      sourceVersionId: source.version.id,
      rowCountBefore: Number(impact.total),
      rowCountAfter: Number(impact.kept),
      operations: compiled.operations.map((op) => ({
        index: op.index,
        type: op.type,
        affectedRows: op.flag ? Number(impact[`a${op.index}`]) : null,
        removedRows: Number(impact[`d${op.index}`] ?? 0),
      })),
      columns: compiled.columns.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        previousName: c.name !== c.source.name ? c.source.name : null,
        previousType: c.dataType !== c.source.dataType ? c.source.dataType : null,
        status: c.removed
          ? 'removed'
          : c.modified || c.dataType !== c.source.dataType
            ? 'modified'
            : c.name !== c.source.name
              ? 'renamed'
              : 'unchanged',
      })),
      sample: {
        columns: shown.map((c) => c.name),
        rows: sample.map((r) => ({
          rowId: Number(r.row_id),
          removed: r.removed,
          before: shown.map((_, i) => r[`b${i}`] ?? null),
          after: r.removed ? null : shown.map((_, i) => r[`a${i}`] ?? null),
        })),
      },
    };
  }

  /** Validates the operations and queues a job that writes a new version (never activated). */
  async apply(
    ctx: TenantContext,
    datasetId: string,
    body: CleaningRequestBody,
  ): Promise<CleaningJob> {
    const jobId = await this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const source = await this.load(
          tx,
          ctx.organizationId,
          datasetId,
          body.sourceVersionId,
          body.operations,
        );
        compileFor(source, body.operations); // fail fast; the worker compiles again

        const id = uuidv7();
        await tx.cleaningJob.create({
          data: {
            id,
            organizationId: ctx.organizationId,
            datasetId,
            sourceVersionId: source.version.id,
            tableKey: randomBase36(8),
            requestedById: ctx.userId,
          },
        });
        await tx.cleaningOperation.createMany({
          data: body.operations.map((op, seq) => ({
            id: uuidv7(),
            organizationId: ctx.organizationId,
            cleaningJobId: id,
            seq,
            opType: op.type,
            params: op,
          })),
        });
        await this.audit.record(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'cleaning.requested',
          resourceType: 'dataset',
          resourceId: datasetId,
          changes: {
            cleaningJobId: id,
            sourceVersionId: source.version.id,
            operations: body.operations.map((op) => op.type),
          },
          meta: ctx,
        });
        return id;
      },
    );

    await this.queue.add(
      CleaningJobName.RUN,
      { organizationId: ctx.organizationId, cleaningJobId: jobId },
      { jobId: cleaningJobId(jobId) },
    );
    return this.get(ctx, jobId);
  }

  async list(ctx: TenantContext, datasetId: string): Promise<CleaningJob[]> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const dataset = await tx.dataset.findUnique({ where: { id: datasetId } });
      if (!dataset) throw new NotFoundError('Dataset not found');
      const jobs = await tx.cleaningJob.findMany({
        where: { datasetId },
        include: jobInclude,
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return jobs.map(toCleaningJobDto);
    });
  }

  async get(ctx: TenantContext, jobId: string): Promise<CleaningJob> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const job = await tx.cleaningJob.findUnique({ where: { id: jobId }, include: jobInclude });
      if (!job) throw new NotFoundError('Cleaning job not found');
      return toCleaningJobDto(job);
    });
  }

  private async load(
    tx: DbTransaction,
    organizationId: string,
    datasetId: string,
    versionId: string | undefined,
    operations: CleaningOperation[],
  ): Promise<CleaningSource> {
    // RLS limits the lookup to the current organization: other tenants' ids look missing.
    const dataset = await tx.dataset.findUnique({ where: { id: datasetId } });
    if (!dataset) throw new NotFoundError('Dataset not found');
    if (dataset.archivedAt) throw new ConflictError('Archived datasets cannot be cleaned');
    const id = versionId ?? dataset.activeVersionId;
    if (!id) throw new NotFoundError('This dataset has no data yet');
    const version = await tx.datasetVersion.findFirst({ where: { id, datasetId } });
    if (!version) throw new NotFoundError('Version not found');
    return loadCleaningSource(tx, organizationId, version.id, operations);
  }
}
