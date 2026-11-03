import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { cleaningOperationSchema } from '@insightai/contracts';
import type { Queue } from 'bullmq';
import type pg from 'pg';
import { Prisma } from '../../generated/prisma/client';
import { uuidv7 } from '../../platform/crypto/ids';
import { DataPlaneService } from '../../platform/data-plane/data-plane.service';
import { tenantReaderRole } from '../../platform/data-plane/tenant-schema';
import { AppError } from '../../platform/errors/app-error';
import { PrismaService } from '../../platform/prisma/prisma.service';
import {
  profilingJobId,
  ProfilingJobName,
  type ProfilingJobData,
  QueueName,
} from '../../platform/queue/queues';
import { AuditService } from '../audit/audit.service';
import { QualityCheckService } from '../quality/quality-check.service';
import { impactSelect, resultSelect } from './cleaning-compiler';
import {
  compileFor,
  describeCleaningDbError,
  isDataError,
  loadCleaningSource,
} from './cleaning-source';

/** Generous: a cleaning job rewrites a whole table (millions of rows). */
const CLEANING_STATEMENT_TIMEOUT_MS = 15 * 60_000;
const TABLE_NAME = /^v_[a-z0-9]{10}_[a-z0-9]{8}$/;

export type CleaningOutcome = 'succeeded' | 'failed' | 'skipped';

/** A failure caused by the data or the operations (not retried). */
class CleaningDataError extends Error {}

/**
 * Applies a cleaning job in the worker (docs/DATA_QUALITY_DESIGN.md §6.4): one
 * `CREATE TABLE … AS` from the compiled operations → metadata of the new version in one
 * transaction → profiling and a quality check of the new version (re-validation).
 *
 * Idempotency: PostgreSQL holds the job state; the table name derives from the job's `tableKey`,
 * so a retry drops what an earlier attempt of this job left behind. The new version is NOT
 * activated: the user compares it with the source and activates it explicitly.
 */
@Injectable()
export class CleaningRunnerService {
  private readonly logger = new Logger(CleaningRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dataPlane: DataPlaneService,
    private readonly audit: AuditService,
    private readonly qualityChecks: QualityCheckService,
    @InjectQueue(QueueName.PROFILING) private readonly profilingQueue: Queue<ProfilingJobData>,
  ) {}

  async run(
    organizationId: string,
    cleaningJobId: string,
    isFinalAttempt: boolean,
  ): Promise<CleaningOutcome> {
    const claimed = await this.prisma.runInTenant(organizationId, async (tx) => {
      const { count } = await tx.cleaningJob.updateMany({
        where: { id: cleaningJobId, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: new Date() },
      });
      if (count === 0) return null;
      const job = await tx.cleaningJob.findUniqueOrThrow({
        where: { id: cleaningJobId },
        include: { operations: { orderBy: { seq: 'asc' } }, dataset: true },
      });
      const operations = job.operations.map((op) => cleaningOperationSchema.parse(op.params));
      const source = await loadCleaningSource(tx, organizationId, job.sourceVersionId, operations);
      return { job, operations, source };
    });
    if (!claimed) return 'skipped';
    const { job, operations, source } = claimed;
    const schema = source.organization.dataSchema;
    const table = `v_${job.dataset.dataKey}_${job.tableKey}`;

    try {
      if (!TABLE_NAME.test(table)) throw new Error('Refusing to use an unexpected table name');
      let compiled;
      try {
        compiled = compileFor(source, operations);
      } catch (error) {
        // E.g. a referenced rule was deleted after the job was queued.
        if (error instanceof AppError) throw new CleaningDataError(error.message);
        throw error;
      }

      const result = await this.dataPlane
        .withTenantWrite(
          schema,
          (client) => this.buildTable(client, schema, table, compiled, source.rawTable),
          { statementTimeoutMs: CLEANING_STATEMENT_TIMEOUT_MS },
        )
        .catch((error: unknown) => {
          if (isDataError(error)) throw new CleaningDataError(describeCleaningDbError(error));
          throw error;
        });

      const versionId = await this.complete(job, source, table, compiled, result);
      await this.profilingQueue.add(
        ProfilingJobName.RUN,
        { organizationId, versionId },
        { jobId: profilingJobId(versionId) },
      );
      // Re-validation with the same rule set, so the versions can be compared.
      await this.qualityChecks.request({
        organizationId,
        datasetId: job.datasetId,
        versionId,
        trigger: 'CLEANING',
        requestedById: job.requestedById,
      });
      this.logger.log({ cleaningJobId, rows: result.rowCount }, 'Cleaning succeeded');
      return 'succeeded';
    } catch (error) {
      if (error instanceof CleaningDataError) {
        await this.fail(organizationId, job.id, schema, table, {
          code: 'CLEANING_FAILED',
          message: error.message,
        });
        return 'failed';
      }
      this.logger.error({ err: error, cleaningJobId }, 'Cleaning attempt failed');
      if (!isFinalAttempt) throw error; // let the queue retry
      await this.fail(organizationId, job.id, schema, table, {
        code: 'INTERNAL_ERROR',
        message: 'The cleaning failed because of a system error. Please try again.',
      });
      return 'failed';
    }
  }

  private async buildTable(
    client: pg.PoolClient,
    schema: string,
    table: string,
    compiled: ReturnType<typeof compileFor>,
    rawTable: string | null,
  ) {
    const id = (value: string) => client.escapeIdentifier(value);
    await client.query(`DROP TABLE IF EXISTS ${id(table)}`);

    const impact = (await client.query<Record<string, string>>(impactSelect(compiled))).rows[0]!;
    await client.query(`CREATE TABLE ${id(table)} AS ${resultSelect(compiled)}`);
    await client.query(`ALTER TABLE ${id(table)} ADD PRIMARY KEY (_row_id)`);

    // Column statistics like an import: non-empty = a value or an original file value;
    // invalid = an original value that is still not a valid value of the column type.
    const kept = compiled.columns.filter((c) => !c.removed);
    const parts = kept.flatMap((c, i) => {
      const typed = `t.${id(c.physicalName)}`;
      if (!rawTable) return [`count(${typed}) AS n${i}`, `0 AS v${i}`];
      const original = `NULLIF(btrim(r.${id(c.physicalName)}), '')`;
      return [
        `count(*) FILTER (WHERE ${typed} IS NOT NULL OR ${original} IS NOT NULL) AS n${i}`,
        c.dataType === 'TEXT'
          ? `0 AS v${i}`
          : `count(*) FILTER (WHERE ${typed} IS NULL AND ${original} IS NOT NULL) AS v${i}`,
      ];
    });
    const from = rawTable
      ? `${id(table)} t LEFT JOIN ${rawTable} r ON r._row_id = t._row_id`
      : `${id(table)} t`;
    const stats = (
      await client.query<Record<string, string>>(`SELECT ${parts.join(', ')} FROM ${from}`)
    ).rows[0]!;

    // The writer owns the table; analytics reads it through the tenant reader role only.
    await client.query(`GRANT SELECT ON ${id(table)} TO ${id(tenantReaderRole(schema))}`);
    await client.query(`ANALYZE ${id(table)}`);

    return {
      rowCount: Number(impact.kept),
      impact,
      columns: kept.map((c, i) => ({
        column: c,
        nonEmpty: Number(stats[`n${i}`] ?? 0),
        invalid: Number(stats[`v${i}`] ?? 0),
      })),
    };
  }

  private async complete(
    job: { id: string; organizationId: string; datasetId: string; requestedById: string | null },
    source: Awaited<ReturnType<typeof loadCleaningSource>>,
    table: string,
    compiled: ReturnType<typeof compileFor>,
    result: Awaited<ReturnType<CleaningRunnerService['buildTable']>>,
  ): Promise<string> {
    return this.prisma.runInTenant(
      job.organizationId,
      async (tx) => {
        // Serialize version numbering per dataset.
        await tx.$queryRaw`SELECT id FROM app.datasets WHERE id = ${job.datasetId}::uuid FOR UPDATE`;
        const latest = await tx.datasetVersion.aggregate({
          where: { datasetId: job.datasetId },
          _max: { versionNo: true },
        });
        const versionId = uuidv7();
        const versionNo = (latest._max.versionNo ?? 0) + 1;
        const sourceColumns = new Map(source.version.columns.map((c) => [c.physicalName, c]));

        await tx.datasetVersion.create({
          data: {
            id: versionId,
            organizationId: job.organizationId,
            datasetId: job.datasetId,
            versionNo,
            origin: 'CLEANING',
            parentVersionId: source.version.id,
            cleaningJobId: job.id,
            physicalTable: table,
            // Same raw table: physical column names and row ids are stable across versions.
            rawTable: source.version.rawTable,
            rowCount: BigInt(result.rowCount),
            createdById: job.requestedById ?? source.version.createdById,
          },
        });
        await tx.datasetColumn.createMany({
          data: result.columns.map(({ column, nonEmpty, invalid }) => {
            const before = sourceColumns.get(column.physicalName)!;
            return {
              id: uuidv7(),
              organizationId: job.organizationId,
              datasetVersionId: versionId,
              ordinal: column.ordinal,
              originalName: column.originalName,
              name: column.name,
              physicalName: column.physicalName,
              dataType: column.dataType,
              inferredType: before.inferredType,
              typeConfidence: before.typeConfidence,
              detectedFormat: column.dataType === before.dataType ? before.detectedFormat : null,
              nonEmptyCount: BigInt(nonEmpty),
              invalidCount: BigInt(invalid),
            };
          }),
        });

        for (const op of compiled.operations) {
          await tx.cleaningOperation.update({
            where: { cleaningJobId_seq: { cleaningJobId: job.id, seq: op.index } },
            data: {
              affectedRows: op.flag ? BigInt(result.impact[`a${op.index}`] ?? 0) : null,
              removedRows: BigInt(result.impact[`d${op.index}`] ?? 0),
            },
          });
        }
        await tx.cleaningJob.update({
          where: { id: job.id },
          data: { status: 'SUCCEEDED', error: Prisma.DbNull, finishedAt: new Date() },
        });
        await this.audit.record(tx, {
          organizationId: job.organizationId,
          actorUserId: job.requestedById,
          action: 'dataset.version_created',
          resourceType: 'dataset',
          resourceId: job.datasetId,
          changes: {
            versionId,
            versionNo,
            cleaningJobId: job.id,
            parentVersionId: source.version.id,
            rows: result.rowCount,
          },
          meta: { requestId: undefined, ip: undefined, userAgent: 'cleaning-worker' },
        });
        return versionId;
      },
      { timeoutMs: 60_000 },
    );
  }

  private async fail(
    organizationId: string,
    jobId: string,
    schema: string,
    table: string,
    error: { code: string; message: string },
  ): Promise<void> {
    // Best effort: the partial table is never referenced by a version.
    if (TABLE_NAME.test(table)) {
      await this.dataPlane
        .withTenantWrite(schema, (client) =>
          client.query(`DROP TABLE IF EXISTS ${client.escapeIdentifier(table)}`),
        )
        .catch((dropError: unknown) =>
          this.logger.warn({ err: dropError, jobId }, 'Could not drop partial cleaning table'),
        );
    }
    await this.prisma.runInTenant(organizationId, (tx) =>
      tx.cleaningJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', error, finishedAt: new Date() },
      }),
    );
  }
}
