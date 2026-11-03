import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type {
  ColumnProfile,
  CreateDatasetRequest,
  DatasetProfile,
  DatasetDetail,
  DatasetSummary,
  RowsPage,
  UpdateDatasetRequest,
  VersionComparison,
} from '@insightai/contracts';
import type { Queue } from 'bullmq';
import { randomBase36, uuidv7 } from '../../platform/crypto/ids';
import { DataPlaneService } from '../../platform/data-plane/data-plane.service';
import { ConflictError, NotFoundError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { isUniqueViolation } from '../../platform/prisma/prisma-errors';
import { type DbTransaction, PrismaService } from '../../platform/prisma/prisma.service';
import {
  profilingJobId,
  ProfilingJobName,
  type ProfilingJobData,
  QueueName,
} from '../../platform/queue/queues';
import { AuditService } from '../audit/audit.service';
import { toColumnDto, toDatasetSummary, toVersionDto } from './dataset-mappers';

const summaryInclude = {
  activeVersion: { include: { _count: { select: { columns: true } } } },
  importJobs: {
    select: { id: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
} as const;

const PHYSICAL_NAME = /^c_[0-9]{1,3}$/;
const TABLE_NAME = /^v_[a-z0-9]{10}_[a-z0-9]{8}$/;

@Injectable()
export class DatasetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataPlane: DataPlaneService,
    private readonly audit: AuditService,
    @InjectQueue(QueueName.PROFILING) private readonly profilingQueue: Queue<ProfilingJobData>,
  ) {}

  async create(ctx: TenantContext, input: CreateDatasetRequest): Promise<DatasetSummary> {
    return this.prisma
      .runInContext({ organizationId: ctx.organizationId, userId: ctx.userId }, async (tx) => {
        const dataset = await tx.dataset.create({
          data: {
            id: uuidv7(),
            organizationId: ctx.organizationId,
            name: input.name,
            description: input.description ?? null,
            dataKey: randomBase36(10),
            createdById: ctx.userId,
          },
          include: summaryInclude,
        });
        await this.audit.record(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'dataset.created',
          resourceType: 'dataset',
          resourceId: dataset.id,
          changes: { name: input.name },
          meta: ctx,
        });
        return toDatasetSummary(dataset);
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw new ConflictError('Could not create dataset, please retry');
        throw error;
      });
  }

  async list(
    ctx: TenantContext,
    options: { includeArchived?: boolean } = {},
  ): Promise<DatasetSummary[]> {
    const rows = await this.prisma.runInTenant(ctx.organizationId, (tx) =>
      tx.dataset.findMany({
        where: options.includeArchived ? {} : { archivedAt: null },
        include: summaryInclude,
        orderBy: { updatedAt: 'desc' },
      }),
    );
    return rows.map(toDatasetSummary);
  }

  async get(ctx: TenantContext, datasetId: string): Promise<DatasetDetail> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const dataset = await tx.dataset.findUnique({
        where: { id: datasetId },
        include: summaryInclude,
      });
      if (!dataset) throw new NotFoundError('Dataset not found');
      const [columns, versions] = await Promise.all([
        dataset.activeVersionId
          ? tx.datasetColumn.findMany({
              where: { datasetVersionId: dataset.activeVersionId },
              orderBy: { ordinal: 'asc' },
            })
          : [],
        tx.datasetVersion.findMany({ where: { datasetId }, orderBy: { versionNo: 'desc' } }),
      ]);
      return {
        ...toDatasetSummary(dataset),
        columns: columns.map(toColumnDto),
        versions: versions.map(toVersionDto),
      };
    });
  }

  async update(
    ctx: TenantContext,
    datasetId: string,
    input: UpdateDatasetRequest,
  ): Promise<DatasetSummary> {
    return this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const before = await this.find(tx, datasetId);
        if (before.archivedAt) throw new ConflictError('Archived datasets cannot be edited');
        const after = await tx.dataset.update({
          where: { id: datasetId },
          data: input,
          include: summaryInclude,
        });
        await this.audit.record(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'dataset.updated',
          resourceType: 'dataset',
          resourceId: datasetId,
          changes: { before: { name: before.name, description: before.description }, after: input },
          meta: ctx,
        });
        return toDatasetSummary(after);
      },
    );
  }

  /** Archiving hides the dataset; its versions and data tables are kept (nothing is deleted). */
  async archive(ctx: TenantContext, datasetId: string): Promise<void> {
    await this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const dataset = await this.find(tx, datasetId);
        if (dataset.archivedAt) return;
        await tx.dataset.update({
          where: { id: datasetId },
          data: { archivedAt: new Date(), status: 'ARCHIVED' },
        });
        await this.audit.record(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'dataset.archived',
          resourceType: 'dataset',
          resourceId: datasetId,
          meta: ctx,
        });
      },
    );
  }

  /**
   * Data preview with keyset pagination on `_row_id`. Runs through the tenant reader role in a
   * read-only transaction; identifiers come from metadata and are re-validated before use.
   */
  async rows(
    ctx: TenantContext,
    datasetId: string,
    query: { versionId?: string | undefined; after: number; limit: number },
  ): Promise<RowsPage> {
    const { version, columns } = await this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const dataset = await this.find(tx, datasetId);
      const versionId = query.versionId ?? dataset.activeVersionId;
      if (!versionId) throw new NotFoundError('This dataset has no data yet');
      const found = await tx.datasetVersion.findFirst({ where: { id: versionId, datasetId } });
      if (!found) throw new NotFoundError('Version not found');
      const cols = await tx.datasetColumn.findMany({
        where: { datasetVersionId: found.id },
        orderBy: { ordinal: 'asc' },
      });
      return { version: found, columns: cols };
    });

    if (
      !TABLE_NAME.test(version.physicalTable) ||
      !columns.every((c) => PHYSICAL_NAME.test(c.physicalName))
    ) {
      throw new Error('Unexpected data-plane identifier in metadata');
    }

    const result = await this.dataPlane.withTenantRead(ctx.dataSchema, (client) => {
      const id = (value: string) => client.escapeIdentifier(value);
      // ::text keeps values exactly as PostgreSQL renders them (no float or time-zone drift).
      const select = columns.map((c) => `${id(c.physicalName)}::text`).join(', ');
      return client.query<{ _row_id: string } & Record<string, string | null>>({
        text: `SELECT _row_id, ${select} FROM ${id(version.physicalTable)} WHERE _row_id > $1 ORDER BY _row_id LIMIT $2`,
        values: [query.after, query.limit + 1],
        rowMode: 'array',
      } as never);
    });

    const rawRows = result.rows as unknown as (string | null)[][];
    const page = rawRows.slice(0, query.limit);
    return {
      versionId: version.id,
      columns: columns.map((c) => ({
        name: c.name,
        originalName: c.originalName,
        dataType: c.dataType,
      })),
      rows: page.map(([rowId, ...values]) => ({ rowId: Number(rowId), values })),
      nextAfter: rawRows.length > query.limit ? Number(page.at(-1)?.[0]) : null,
    };
  }

  async profile(
    ctx: TenantContext,
    datasetId: string,
    versionId: string | undefined,
  ): Promise<DatasetProfile> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const version = await this.findVersion(tx, datasetId, versionId);
      const profiles = await tx.columnProfile.findMany({
        where: { datasetVersionId: version.id },
        include: { column: { select: { ordinal: true } } },
      });
      profiles.sort((a, b) => a.column.ordinal - b.column.ordinal);
      return {
        versionId: version.id,
        status: version.profileStatus,
        computedAt: version.profiledAt?.toISOString() ?? null,
        columns: profiles.map((p) => p.stats as unknown as ColumnProfile),
      };
    });
  }

  /** Recomputes the profile of a version (e.g. after a failure). */
  async reprofile(
    ctx: TenantContext,
    datasetId: string,
    versionId: string | undefined,
  ): Promise<void> {
    const version = await this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const found = await this.findVersion(tx, datasetId, versionId);
      if (found.profileStatus === 'RUNNING' || found.profileStatus === 'PENDING') {
        throw new ConflictError('Profiling is already in progress');
      }
      await tx.datasetVersion.update({
        where: { id: found.id },
        data: { profileStatus: 'PENDING' },
      });
      return found;
    });
    await this.profilingQueue.add(
      ProfilingJobName.RUN,
      { organizationId: ctx.organizationId, versionId: version.id },
      { jobId: profilingJobId(version.id, String(Date.now())) },
    );
  }

  /**
   * Makes a version the one used by analytics. Activating an older version is the rollback:
   * nothing is deleted, every version stays available.
   */
  async activateVersion(
    ctx: TenantContext,
    datasetId: string,
    versionId: string,
  ): Promise<DatasetSummary> {
    return this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const dataset = await this.find(tx, datasetId);
        if (dataset.archivedAt) throw new ConflictError('Archived datasets cannot be edited');
        const version = await tx.datasetVersion.findFirst({ where: { id: versionId, datasetId } });
        if (!version) throw new NotFoundError('Version not found');
        const after = await tx.dataset.update({
          where: { id: datasetId },
          data: { activeVersionId: version.id, status: 'READY' },
          include: summaryInclude,
        });
        if (dataset.activeVersionId !== version.id) {
          await this.audit.record(tx, {
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            action: 'dataset.version_activated',
            resourceType: 'dataset',
            resourceId: datasetId,
            changes: {
              from: dataset.activeVersionId,
              to: version.id,
              versionNo: version.versionNo,
            },
            meta: ctx,
          });
        }
        return toDatasetSummary(after);
      },
    );
  }

  /**
   * Compares two versions of a dataset: rows by their stable row id, columns by their physical
   * identity (stable across cleaning, so a renamed column is compared with itself), and the
   * latest successful quality check of each side rule by rule.
   */
  async compareVersions(
    ctx: TenantContext,
    datasetId: string,
    baseId: string,
    targetId: string,
  ): Promise<VersionComparison> {
    const loaded = await this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      await this.find(tx, datasetId);
      const load = async (id: string) => {
        const version = await tx.datasetVersion.findFirst({
          where: { id, datasetId },
          include: { columns: { orderBy: { ordinal: 'asc' } } },
        });
        if (!version) throw new NotFoundError('Version not found');
        const check = await tx.qualityCheck.findFirst({
          where: { datasetVersionId: id, status: 'SUCCEEDED' },
          orderBy: { createdAt: 'desc' },
          include: { results: true },
        });
        return { version, check };
      };
      return { base: await load(baseId), target: await load(targetId) };
    });
    const { base, target } = loaded;
    for (const side of [base, target]) {
      if (
        !TABLE_NAME.test(side.version.physicalTable) ||
        !side.version.columns.every((c) => PHYSICAL_NAME.test(c.physicalName))
      ) {
        throw new Error('Unexpected data-plane identifier in metadata');
      }
    }

    const targetColumns = new Map(target.version.columns.map((c) => [c.physicalName, c]));
    const shared = base.version.columns.filter((c) => targetColumns.has(c.physicalName));

    const counts = await this.dataPlane.withTenantRead(
      ctx.dataSchema,
      async (client) => {
        const id = (value: string) => client.escapeIdentifier(value);
        const both = 'b._row_id IS NOT NULL AND t._row_id IS NOT NULL';
        const differs = shared.map(
          (c) => `b.${id(c.physicalName)}::text IS DISTINCT FROM t.${id(c.physicalName)}::text`,
        );
        const parts = [
          'count(*) FILTER (WHERE t._row_id IS NULL) AS removed',
          'count(*) FILTER (WHERE b._row_id IS NULL) AS added',
          `count(*) FILTER (WHERE ${both} AND (${differs.length > 0 ? differs.join(' OR ') : 'false'})) AS changed`,
          ...differs.map((d, i) => `count(*) FILTER (WHERE ${both} AND ${d}) AS c${i}`),
        ];
        return (
          await client.query<Record<string, string>>(
            `SELECT ${parts.join(', ')} FROM ${id(base.version.physicalTable)} b ` +
              `FULL JOIN ${id(target.version.physicalTable)} t ON t._row_id = b._row_id`,
          )
        ).rows[0]!;
      },
      { statementTimeoutMs: 60_000 },
    );

    const columns: VersionComparison['columns'] = base.version.columns.map((c) => {
      const other = targetColumns.get(c.physicalName);
      const i = shared.indexOf(c);
      return {
        name: other?.name ?? c.name,
        baseType: c.dataType,
        targetType: other?.dataType ?? null,
        status: !other ? 'removed' : other.dataType !== c.dataType ? 'retyped' : 'unchanged',
        changedRows: other ? Number(counts[`c${i}`]) : null,
      };
    });
    const basePhysical = new Set(base.version.columns.map((c) => c.physicalName));
    for (const c of target.version.columns) {
      if (basePhysical.has(c.physicalName)) continue;
      columns.push({
        name: c.name,
        baseType: null,
        targetType: c.dataType,
        status: 'added',
        changedRows: null,
      });
    }

    // Rules matched by id; a rule present on one side only still appears.
    type Result = NonNullable<typeof base.check>['results'][number];
    const key = (r: Result) => r.qualityRuleId ?? `deleted:${r.id}`;
    const rules = new Map<
      string,
      { name: string; ruleId: string | null; base?: Result; target?: Result }
    >();
    for (const [side, check] of [
      ['base', base.check],
      ['target', target.check],
    ] as const) {
      for (const r of check?.results ?? []) {
        const entry = rules.get(key(r)) ?? {
          name: (r.ruleSnapshot as { name: string }).name,
          ruleId: r.qualityRuleId,
        };
        entry[side] = r;
        rules.set(key(r), entry);
      }
    }
    const scored = (r: Result | undefined) => r?.status === 'PASSED' || r?.status === 'FAILED';
    const side = (version: typeof base.version) => ({
      id: version.id,
      versionNo: version.versionNo,
      origin: version.origin,
      rowCount: Number(version.rowCount),
      qualityStatus: version.qualityStatus,
      qualityScore: version.qualityScore === null ? null : Number(version.qualityScore),
    });

    return {
      base: side(base.version),
      target: side(target.version),
      rows: {
        removed: Number(counts.removed),
        added: Number(counts.added),
        changed: Number(counts.changed),
      },
      columns,
      rules: [...rules.values()].map((r) => ({
        ruleId: r.ruleId,
        ruleName: r.name,
        baseFailed: scored(r.base) ? Number(r.base!.failedCount) : null,
        targetFailed: scored(r.target) ? Number(r.target!.failedCount) : null,
        basePassRate: scored(r.base) && r.base!.passRate !== null ? Number(r.base!.passRate) : null,
        targetPassRate:
          scored(r.target) && r.target!.passRate !== null ? Number(r.target!.passRate) : null,
      })),
    };
  }

  private async findVersion(tx: DbTransaction, datasetId: string, versionId: string | undefined) {
    const dataset = await this.find(tx, datasetId);
    const id = versionId ?? dataset.activeVersionId;
    if (!id) throw new NotFoundError('This dataset has no data yet');
    const version = await tx.datasetVersion.findFirst({ where: { id, datasetId } });
    if (!version) throw new NotFoundError('Version not found');
    return version;
  }

  private async find(tx: DbTransaction, datasetId: string) {
    // RLS limits the lookup to the current organization: other tenants' ids look missing.
    const dataset = await tx.dataset.findUnique({ where: { id: datasetId } });
    if (!dataset) throw new NotFoundError('Dataset not found');
    return dataset;
  }
}
