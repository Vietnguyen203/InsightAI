import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ImportOptions, importOptionsSchema, isValidTimeZone } from '@insightai/contracts';
import type { Queue } from 'bullmq';
import type pg from 'pg';
import { Prisma } from '../../generated/prisma/client';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.module';
import { uuidv7 } from '../../platform/crypto/ids';
import { DataPlaneService } from '../../platform/data-plane/data-plane.service';
import { tenantReaderRole } from '../../platform/data-plane/tenant-schema';
import { PrismaService } from '../../platform/prisma/prisma.service';
import {
  profilingJobId,
  ProfilingJobName,
  type ProfilingJobData,
  QueueName,
} from '../../platform/queue/queues';
import { StorageService } from '../../platform/storage/storage.service';
import { AuditService } from '../audit/audit.service';
import { QualityCheckService } from '../quality/quality-check.service';
import type { NamedColumn } from './column-naming';
import { importLimits } from './import-limits';
import { assertSafeZip } from './parsing/file-format';
import { openCsv } from './parsing/csv-reader';
import { ImportError, type ImportWarning } from './parsing/import-error';
import { readXlsxRows } from './parsing/xlsx-reader';
import { loadRawTable } from './raw-loader';
import {
  candidateForOverride,
  candidatesFor,
  castExpression,
  type ColumnStats,
  inferType,
  type InferredType,
  type NumberLocale,
  SQL_TYPE,
} from './type-inference';

/** Statement timeout for import DDL/COPY; generous because files can hold millions of rows. */
const IMPORT_STATEMENT_TIMEOUT_MS = 15 * 60_000;

const TABLE_NAME = /^[rv]_[a-z0-9]{10}_[a-z0-9]{8}$/;

export const rawTableName = (dataKey: string, tableKey: string) => `r_${dataKey}_${tableKey}`;
export const typedTableName = (dataKey: string, tableKey: string) => `v_${dataKey}_${tableKey}`;

interface TypedColumn extends NamedColumn {
  inferred: InferredType;
  detected: InferredType;
  nonEmpty: number;
  valid: number;
}

export type RunOutcome = 'succeeded' | 'failed' | 'skipped';

/**
 * Executes one import job inside the worker process (docs/DATA_QUALITY_DESIGN.md §2):
 * download → parse (streaming) → raw text table → type inference → typed table → metadata.
 *
 * Idempotency: PostgreSQL holds the job state. Table names derive from the job's `tableKey`, so
 * a retry first drops whatever an earlier attempt of *this job* left behind. The version row is
 * written in a single transaction at the very end.
 */
@Injectable()
export class ImportRunnerService {
  private readonly logger = new Logger(ImportRunnerService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly dataPlane: DataPlaneService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    @InjectQueue(QueueName.PROFILING) private readonly profilingQueue: Queue<ProfilingJobData>,
    private readonly qualityChecks: QualityCheckService,
  ) {}

  /**
   * @param isFinalAttempt when false, unexpected (system) errors are rethrown so the queue
   *   retries; data errors (ImportError) always fail the job immediately.
   */
  async run(
    organizationId: string,
    importJobId: string,
    isFinalAttempt: boolean,
  ): Promise<RunOutcome> {
    const job = await this.claim(organizationId, importJobId);
    if (!job) return 'skipped';

    const { dataset, dataSource, organization } = job;
    const rawTable = rawTableName(dataset.dataKey, job.tableKey);
    const typedTable = typedTableName(dataset.dataKey, job.tableKey);
    if (!TABLE_NAME.test(rawTable) || !TABLE_NAME.test(typedTable)) {
      throw new Error('Refusing to use an unexpected data-plane table name');
    }

    const workDir = await mkdtemp(join(this.config.WORK_DIR ?? tmpdir(), 'insightai-import-'));
    try {
      const options = importOptionsSchema.parse(job.options);
      const filePath = join(workDir, 'source');
      await this.storage.downloadToFile(dataSource.storageKey, filePath);

      const result = await this.dataPlane.withTenantWrite(
        organization.dataSchema,
        (client) =>
          this.buildTables(client, {
            filePath,
            format: dataSource.fileFormat === 'xlsx' ? 'xlsx' : 'csv',
            options,
            rawTable,
            typedTable,
            locale: options.locale ?? (organization.locale === 'en' ? 'en' : 'vi'),
            timezone: organization.timezone,
            readerRole: tenantReaderRole(organization.dataSchema),
          }),
        { statementTimeoutMs: IMPORT_STATEMENT_TIMEOUT_MS },
      );

      const versionId = await this.complete(job, rawTable, typedTable, result);
      // Deterministic job id: a retried import cannot enqueue the profiling twice.
      await this.profilingQueue.add(
        ProfilingJobName.RUN,
        { organizationId: job.organizationId, versionId },
        { jobId: profilingJobId(versionId) },
      );
      // Every new version is checked against the dataset rules (system rules are created here).
      await this.qualityChecks.request({
        organizationId: job.organizationId,
        datasetId: job.datasetId,
        versionId,
        trigger: 'IMPORT',
        requestedById: job.requestedById,
      });
      this.logger.log({ importJobId, rows: result.rowCount }, 'Import succeeded');
      return 'succeeded';
    } catch (error) {
      if (error instanceof ImportError) {
        await this.fail(job, { code: error.code, message: error.message });
        return 'failed';
      }
      this.logger.error({ err: error, importJobId }, 'Import attempt failed');
      if (!isFinalAttempt) throw error; // let the queue retry
      await this.fail(job, {
        code: 'INTERNAL_ERROR',
        message: 'The import failed because of a system error. Please try again.',
      });
      return 'failed';
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** PENDING/RUNNING → RUNNING. Returns null when the job is already finished. */
  private async claim(organizationId: string, importJobId: string) {
    return this.prisma.runInTenant(organizationId, async (tx) => {
      const { count } = await tx.importJob.updateMany({
        where: { id: importJobId, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: new Date() },
      });
      if (count === 0) return null;
      const job = await tx.importJob.findUniqueOrThrow({
        where: { id: importJobId },
        include: { dataset: true, dataSource: true },
      });
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      return { ...job, organization };
    });
  }

  private async buildTables(
    client: pg.PoolClient,
    input: {
      filePath: string;
      format: 'csv' | 'xlsx';
      options: ReturnType<typeof importOptionsSchema.parse>;
      rawTable: string;
      typedTable: string;
      locale: NumberLocale;
      timezone: string;
      readerRole: string;
    },
  ) {
    const id = (value: string) => client.escapeIdentifier(value);
    const warnings: ImportWarning[] = [];

    // Leftovers of an earlier attempt of this same job (names are unique to the job).
    await client.query(`DROP TABLE IF EXISTS ${id(input.typedTable)}`);
    await client.query(`DROP TABLE IF EXISTS ${id(input.rawTable)}`);

    let rows: AsyncIterable<string[]>;
    // XLSX numbers/dates are machine values (rendered as 1234.5 / ISO), so they always use `en`.
    let locale = input.locale;
    if (input.format === 'xlsx') {
      await assertSafeZip(input.filePath);
      rows = readXlsxRows(input.filePath, input.options.sheetName);
      locale = 'en';
    } else {
      const csv = await openCsv(input.filePath, input.options);
      rows = csv.rows;
    }

    const loaded = await loadRawTable(client, input.rawTable, rows, {
      hasHeader: input.options.hasHeader,
      limits: importLimits(this.config),
    });
    warnings.push(...loaded.warnings);

    const typed = await this.inferColumns(
      client,
      input.rawTable,
      loaded.columns,
      locale,
      input.options,
    );

    const tz = client.escapeLiteral(isValidTimeZone(input.timezone) ? input.timezone : 'UTC');
    const select = typed
      .map((c) => {
        const expr = castExpression(id(c.physicalName), c.inferred).replaceAll('$tz', tz);
        return `(${expr})::${SQL_TYPE[c.inferred.type]} AS ${id(c.physicalName)}`;
      })
      .join(', ');
    await client.query(
      `CREATE TABLE ${id(input.typedTable)} AS SELECT _row_id, ${select} FROM ${id(input.rawTable)}`,
    );
    await client.query(`ALTER TABLE ${id(input.typedTable)} ADD PRIMARY KEY (_row_id)`);

    // Valid = non-NULL typed values; anything non-empty in raw but NULL in typed is invalid.
    const validCounts = await client.query<Record<string, string>>(
      `SELECT ${typed.map((c, i) => `count(${id(c.physicalName)}) AS v${i}`).join(', ')} FROM ${id(input.typedTable)}`,
    );
    typed.forEach((column, i) => {
      column.valid = Number(validCounts.rows[0]?.[`v${i}`] ?? 0);
    });

    // The writer owns both tables; analytics reads them through the tenant reader role only.
    await client.query(
      `GRANT SELECT ON ${id(input.rawTable)}, ${id(input.typedTable)} TO ${id(input.readerRole)}`,
    );
    await client.query(`ANALYZE ${id(input.typedTable)}`);

    return { rowCount: loaded.rowCount, columns: typed, warnings };
  }

  /** One aggregate query counts non-empty values and pattern matches for every column. */
  private async inferColumns(
    client: pg.PoolClient,
    rawTable: string,
    columns: NamedColumn[],
    locale: NumberLocale,
    options: ImportOptions,
  ): Promise<TypedColumn[]> {
    const id = (value: string) => client.escapeIdentifier(value);
    const candidates = candidatesFor(locale);
    const overrides = options.columnTypes ?? {};
    const unknown = Object.keys(overrides).filter((name) => !columns.some((c) => c.name === name));
    if (unknown.length > 0) {
      throw new ImportError(
        'UNKNOWN_COLUMN',
        `Unknown column(s) in columnTypes: ${unknown.join(', ')}`,
      );
    }

    const aggregates: string[] = [];
    columns.forEach((column, ci) => {
      const v = `NULLIF(btrim(${id(column.physicalName)}), '')`;
      aggregates.push(`count(${v}) AS n${ci}`);
      candidates.forEach((candidate, ki) => {
        aggregates.push(`count(*) FILTER (WHERE ${v} ~* '${candidate.pattern}') AS m${ci}_${ki}`);
      });
    });
    const result = await client.query<Record<string, string>>(
      `SELECT ${aggregates.join(', ')} FROM ${id(rawTable)}`,
    );
    const row = result.rows[0] ?? {};

    return columns.map((column, ci) => {
      const stats: ColumnStats = {
        nonEmpty: Number(row[`n${ci}`] ?? 0),
        matches: Object.fromEntries(
          candidates.map((candidate, ki) => [candidate.key, Number(row[`m${ci}_${ki}`] ?? 0)]),
        ),
      };
      const detected = inferType(stats, candidates);
      const forced = overrides[column.name];
      const inferred = forced ? candidateForOverride(forced, stats, candidates) : detected;
      return { ...column, inferred, detected, nonEmpty: stats.nonEmpty, valid: 0 };
    });
  }

  private async complete(
    job: NonNullable<Awaited<ReturnType<ImportRunnerService['claim']>>>,
    rawTable: string,
    typedTable: string,
    result: { rowCount: number; columns: TypedColumn[]; warnings: ImportWarning[] },
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

        await tx.datasetVersion.create({
          data: {
            id: versionId,
            organizationId: job.organizationId,
            datasetId: job.datasetId,
            versionNo,
            origin: 'IMPORT',
            importJobId: job.id,
            physicalTable: typedTable,
            rawTable,
            rowCount: BigInt(result.rowCount),
            createdById: job.requestedById,
          },
        });
        await tx.datasetColumn.createMany({
          data: result.columns.map((c) => ({
            id: uuidv7(),
            organizationId: job.organizationId,
            datasetVersionId: versionId,
            ordinal: c.ordinal,
            originalName: c.originalName,
            name: c.name,
            physicalName: c.physicalName,
            dataType: c.inferred.type,
            inferredType: c.detected.type,
            typeConfidence: new Prisma.Decimal(c.detected.confidence.toFixed(4)),
            detectedFormat: c.inferred.candidate?.format ?? null,
            nonEmptyCount: BigInt(c.nonEmpty),
            invalidCount: BigInt(Math.max(0, c.nonEmpty - c.valid)),
          })),
        });

        const invalidColumns = result.columns.filter((c) => c.nonEmpty > c.valid);
        const warnings = [...result.warnings];
        if (invalidColumns.length > 0) {
          warnings.push({
            code: 'INVALID_VALUES',
            message: `Some values could not be converted and were stored as empty: ${invalidColumns
              .map((c) => c.name)
              .join(', ')}`,
            count: invalidColumns.reduce((sum, c) => sum + (c.nonEmpty - c.valid), 0),
          });
        }

        await tx.importJob.update({
          where: { id: job.id },
          data: {
            status: 'SUCCEEDED',
            rowsRead: BigInt(result.rowCount),
            warnings: warnings as unknown as Prisma.InputJsonValue,
            error: Prisma.DbNull,
            finishedAt: new Date(),
          },
        });
        // A new import becomes the active version: the user explicitly uploaded new data.
        await tx.dataset.update({
          where: { id: job.datasetId },
          data: { activeVersionId: versionId, status: 'READY' },
        });
        await this.audit.record(tx, {
          organizationId: job.organizationId,
          actorUserId: job.requestedById,
          action: 'dataset.version_created',
          resourceType: 'dataset',
          resourceId: job.datasetId,
          changes: { versionId, versionNo, importJobId: job.id, rows: result.rowCount },
          meta: { requestId: undefined, ip: undefined, userAgent: 'import-worker' },
        });
        return versionId;
      },
      { timeoutMs: 60_000 },
    );
  }

  private async fail(
    job: NonNullable<Awaited<ReturnType<ImportRunnerService['claim']>>>,
    error: { code: string; message: string },
  ): Promise<void> {
    // Best effort: remove this job's partial tables (they are never referenced by a version).
    await this.dataPlane
      .withTenantWrite(job.organization.dataSchema, async (client) => {
        const id = (value: string) => client.escapeIdentifier(value);
        await client.query(
          `DROP TABLE IF EXISTS ${id(typedTableName(job.dataset.dataKey, job.tableKey))}`,
        );
        await client.query(
          `DROP TABLE IF EXISTS ${id(rawTableName(job.dataset.dataKey, job.tableKey))}`,
        );
      })
      .catch((dropError: unknown) =>
        this.logger.warn(
          { err: dropError, importJobId: job.id },
          'Could not drop partial import tables',
        ),
      );

    await this.prisma.runInTenant(job.organizationId, (tx) =>
      tx.importJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', error, finishedAt: new Date() },
      }),
    );
  }
}
