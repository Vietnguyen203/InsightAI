import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  type CompiledQuery,
  type Entity,
  isValidTimeZone,
  type MetricDefinition,
  metricDefinitionSchema,
  type Relationship,
  type SemanticQueryParsed,
  type SemanticQueryResult,
} from '@insightai/contracts';
import type { Redis } from 'ioredis';
import { uuidv7 } from '../../platform/crypto/ids';
import { DataPlaneService } from '../../platform/data-plane/data-plane.service';
import { QueryRejectedError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { REDIS_CLIENT } from '../../platform/queue/queue.module';
import { qualifiedTable } from '../quality/version-columns';
import { policyRules, type StoredPolicy } from './access-policy-rules';
import { compareRangeFor, resolveDateRange } from './date-range';
import {
  type EntityData,
  type Plan,
  type PlannedMetric,
  planQuery,
  QueryRejection,
} from './query-planner';
import { initSqlValidator, SqlRejected, validateSql } from './sql-validator';

const QUERY_STATEMENT_TIMEOUT_MS = 15_000;
const CACHE_TTL_SECONDS = 600;
const CACHE_PREFIX = 'insightai:sq:';
const PHYSICAL_NAME = /^c_[0-9]{1,3}$/;

interface Snapshot {
  revision: number;
  entities: Entity[];
  relationships: Relationship[];
}

interface Prepared {
  plan: Plan;
  compiled: CompiledQuery;
  modelId: string;
  dataSchema: string;
  cacheKey: string;
}

/**
 * Runs Semantic Query IR (docs/SEMANTIC_LAYER_DESIGN.md §6): published snapshot + active dataset
 * versions + access policies → plan → SQL validated by PostgreSQL's parser → read-only execution
 * as the tenant reader role → cached result. Every query is recorded in query_history.
 */
@Injectable()
export class QueryEngineService implements OnModuleInit {
  private readonly logger = new Logger(QueryEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dataPlane: DataPlaneService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit(): Promise<void> {
    return initSqlValidator();
  }

  /** SQL and columns without running the query (model editor "test query"). */
  async compile(ctx: TenantContext, query: SemanticQueryParsed): Promise<CompiledQuery> {
    const outcome = await this.guarded(ctx, query, null, async () => {
      return (await this.prepare(ctx, query)).compiled;
    });
    return outcome.value;
  }

  async run(
    ctx: TenantContext,
    query: SemanticQueryParsed,
    source: 'API' | 'KPI' | 'DASHBOARD' | 'AI' = 'API',
  ): Promise<SemanticQueryResult> {
    const outcome = await this.guarded(ctx, query, source, async (record) => {
      const prepared = await this.prepare(ctx, query);
      record.prepared = prepared;
      const cached = await this.cacheGet(prepared.cacheKey);
      if (cached) {
        record.cached = true;
        return { ...cached, cached: true, queryHistoryId: record.historyId };
      }
      const rows = await this.dataPlane.withTenantRead(
        prepared.dataSchema,
        async (client) =>
          (
            await client.query<string[]>({
              text: prepared.plan.sql,
              values: prepared.plan.params,
              rowMode: 'array',
              // Keep values exactly as PostgreSQL renders them (no float or time-zone drift).
              types: { getTypeParser: () => (value: string) => value },
            })
          ).rows as unknown as (string | null)[][],
        { statementTimeoutMs: QUERY_STATEMENT_TIMEOUT_MS },
      );
      const truncated = rows.length > query.limit;
      const result: SemanticQueryResult = {
        columns: prepared.compiled.columns,
        rows: rows.slice(0, query.limit),
        truncated,
        dateRange: prepared.compiled.dateRange,
        compareRange: prepared.compiled.compareRange,
        metrics: prepared.compiled.metrics,
        modelRevision: prepared.compiled.modelRevision,
        queryHistoryId: record.historyId,
        cached: false,
        policiesApplied: prepared.compiled.policiesApplied,
      };
      await this.cacheSet(prepared.cacheKey, result);
      return result;
    });
    return outcome.value;
  }

  /**
   * Checks that a metric version can be published: its definition (with the other published
   * metrics) must plan against the published model and current data. Access policies do not
   * apply: the check is about the definition, not about who queries it.
   */
  async checkMetric(
    ctx: TenantContext,
    modelKey: string,
    candidate: { key: string; definition: MetricDefinition },
  ): Promise<void> {
    const query = {
      model: modelKey,
      metrics: [candidate.key],
      measures: [],
      dimensions: [],
      filters: [],
      orderBy: [],
      limit: 1,
      ...(candidate.definition.type === 'SIMPLE' && candidate.definition.timeDimension
        ? { timeDimension: {} }
        : {}),
    } satisfies SemanticQueryParsed;
    try {
      await this.prepare(ctx, query, candidate);
    } catch (error) {
      if (error instanceof QueryRejection) {
        throw new QueryRejectedError(error.message, [
          { path: `reason.${error.code}`, message: error.message },
        ]);
      }
      throw error;
    }
  }

  /**
   * Most frequent values of a categorical dimension (≤ 50), optionally containing `search`. Used
   * by the AI to map words ("miền Bắc") to real values; access policies apply as for queries.
   */
  async dimensionValues(
    ctx: TenantContext,
    modelKey: string,
    dimension: string,
    search?: string,
  ): Promise<string[]> {
    const entityKey = dimension.split('.')[0] ?? '';
    const query = {
      model: modelKey,
      metrics: [],
      measures: [],
      dimensions: [dimension],
      filters: search ? [{ member: dimension, op: 'contains' as const, values: [search] }] : [],
      orderBy: [{ member: '__rows', dir: 'desc' as const }],
      limit: 50,
    } satisfies SemanticQueryParsed;
    const prepared = await this.prepare(ctx, query, undefined, entityKey);
    const rows = await this.dataPlane.withTenantRead(
      prepared.dataSchema,
      async (client) =>
        (
          await client.query<string[]>({
            text: prepared.plan.sql,
            values: prepared.plan.params,
            rowMode: 'array',
            types: { getTypeParser: () => (value: string) => value },
          })
        ).rows,
      { statementTimeoutMs: QUERY_STATEMENT_TIMEOUT_MS },
    );
    return rows
      .slice(0, 50)
      .map((r) => r[0])
      .filter((v): v is string => v !== null && v !== undefined);
  }

  private async prepare(
    ctx: TenantContext,
    query: SemanticQueryParsed,
    candidate?: { key: string; definition: MetricDefinition },
    countRowsOf?: string,
  ): Promise<Prepared> {
    const loaded = await this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const model = await tx.semanticModel.findUnique({
        where: { organizationId_key: { organizationId: ctx.organizationId, key: query.model } },
        include: {
          accessPolicies: true,
          metrics: { include: { versions: { where: { status: 'PUBLISHED' } } } },
        },
      });
      if (!model?.publishedSnapshot) return null;
      const snapshot = model.publishedSnapshot as unknown as Snapshot;
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: ctx.organizationId },
      });
      const data = new Map<string, EntityData>();
      for (const entity of snapshot.entities) {
        const dataset = await tx.dataset.findUnique({
          where: { id: entity.datasetId },
          include: { activeVersion: { include: { columns: true } } },
        });
        const version = dataset && !dataset.archivedAt ? dataset.activeVersion : null;
        if (!version) continue;
        if (!version.columns.every((c) => PHYSICAL_NAME.test(c.physicalName))) {
          throw new Error('Unexpected column identifier in metadata');
        }
        data.set(entity.id, {
          table: qualifiedTable(organization.dataSchema, version.physicalTable),
          versionId: version.id,
          columns: new Map(
            version.columns.map((c) => [
              c.name,
              { physicalName: c.physicalName, dataType: c.dataType },
            ]),
          ),
        });
      }
      return { model, snapshot, organization, data };
    });
    if (!loaded) {
      throw new QueryRejection('UNKNOWN_MODEL', `No published semantic model "${query.model}"`);
    }
    const { model, snapshot, organization, data } = loaded;

    const policies: StoredPolicy[] = model.accessPolicies.map((p) => ({
      name: p.name,
      roles: p.roles,
      enabled: p.enabled,
      memberAccess: p.memberAccess as StoredPolicy['memberAccess'],
      rowFilter: p.rowFilter as StoredPolicy['rowFilter'],
    }));
    const rules = candidate
      ? { names: [], allows: () => true, rowFilters: null }
      : policyRules(policies, ctx.role);
    const metrics = new Map<string, PlannedMetric>();
    for (const metric of model.metrics) {
      const version = metric.versions[0];
      if (!version) continue;
      metrics.set(metric.key, {
        key: metric.key,
        version: version.versionNo,
        versionId: version.id,
        label: version.label,
        unit: version.unit,
        format: version.format as PlannedMetric['format'],
        definition: metricDefinitionSchema.parse(version.definition),
      });
    }
    if (candidate) {
      metrics.set(candidate.key, {
        key: candidate.key,
        version: 0,
        versionId: '',
        label: candidate.key,
        unit: null,
        format: 'number',
        definition: candidate.definition,
      });
    }
    const timezone = isValidTimeZone(organization.timezone) ? organization.timezone : 'UTC';
    const range = query.timeDimension?.dateRange
      ? resolveDateRange(query.timeDimension.dateRange, timezone)
      : null;
    const compareTo = query.timeDimension?.compareTo;
    const compareRange = range && compareTo ? compareRangeFor(range, compareTo) : null;

    const plan = planQuery({
      query,
      entities: snapshot.entities,
      relationships: snapshot.relationships,
      metrics,
      data,
      policy: rules,
      dateRange: range,
      compareRange,
      ...(countRowsOf ? { countRowsOf } : {}),
    });
    const tables = new Set(
      [...data.values()].map((d) => d.table.split('.')[1]!.replaceAll('"', '')),
    );
    validateSql(plan.sql, { schema: organization.dataSchema, tables });

    const applied = model.accessPolicies
      .filter((p) => rules.names.includes(p.name))
      .map((p) => `${p.id}:${p.updatedAt.toISOString()}`)
      .sort();
    const cacheKey =
      CACHE_PREFIX +
      createHash('sha256')
        .update(
          JSON.stringify({
            org: ctx.organizationId,
            sql: plan.sql,
            params: plan.params,
            revision: snapshot.revision,
            versions: plan.datasetVersionIds,
            policies: applied,
            metrics: plan.metrics.map((m) => m.versionId),
          }),
        )
        .digest('hex');

    return {
      plan,
      modelId: model.id,
      dataSchema: organization.dataSchema,
      cacheKey,
      compiled: {
        sql: plan.sql,
        params: plan.params,
        columns: plan.columns,
        dateRange: range,
        compareRange,
        metrics: plan.metrics.map((m) => ({ key: m.key, version: m.version })),
        modelRevision: snapshot.revision,
        policiesApplied: rules.names,
      },
    };
  }

  /** Records the query (success or not) and maps planner/validator rejections to 422. */
  private async guarded<T>(
    ctx: TenantContext,
    query: SemanticQueryParsed,
    /** Null: not a data query (compile only), so nothing is recorded. */
    source: string | null,
    work: (record: { prepared?: Prepared; cached: boolean; historyId: string }) => Promise<T>,
  ): Promise<{ value: T }> {
    const started = Date.now();
    const record: { prepared?: Prepared; cached: boolean; historyId: string } = {
      cached: false,
      historyId: uuidv7(),
    };
    let status: 'SUCCEEDED' | 'REJECTED' | 'FAILED' = 'SUCCEEDED';
    let errorCode: string | null = null;
    let value: T | undefined;
    try {
      value = await work(record);
      return { value };
    } catch (error) {
      if (error instanceof QueryRejection) {
        status = 'REJECTED';
        errorCode = error.code;
        throw new QueryRejectedError(error.message, [
          { path: `reason.${error.code}`, message: error.message },
        ]);
      }
      if (error instanceof SqlRejected) {
        // The planner produced something the validator refuses: a bug, never user input.
        status = 'REJECTED';
        errorCode = 'SQL_REJECTED';
        this.logger.error({ err: error }, 'Generated SQL rejected by the validator');
        throw new QueryRejectedError('The query could not be run safely', [
          { path: 'reason.SQL_REJECTED', message: 'The query could not be run safely' },
        ]);
      }
      status = 'FAILED';
      const code = (error as { code?: string }).code;
      errorCode = code === '57014' ? 'TIMEOUT' : 'INTERNAL_ERROR';
      if (code === '57014') {
        throw new QueryRejectedError('The query took too long', [
          { path: 'reason.TIMEOUT', message: 'The query took too long' },
        ]);
      }
      throw error;
    } finally {
      if (source !== null)
        await this.recordHistory(ctx, query, source, record, status, errorCode, value, started);
    }
  }

  private async recordHistory<T>(
    ctx: TenantContext,
    query: SemanticQueryParsed,
    source: string,
    record: { prepared?: Prepared; cached: boolean; historyId: string },
    status: 'SUCCEEDED' | 'REJECTED' | 'FAILED',
    errorCode: string | null,
    value: T | undefined,
    started: number,
  ): Promise<void> {
    const prepared = record.prepared;
    const rows =
      value && typeof value === 'object' && 'rows' in value
        ? (value as unknown as SemanticQueryResult)
        : null;
    await this.prisma
      .runInTenant(ctx.organizationId, (tx) =>
        tx.queryHistory.createMany({
          data: {
            id: record.historyId,
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            source,
            semanticModelId: prepared?.modelId ?? null,
            modelRevision: prepared?.compiled.modelRevision ?? null,
            semanticQuery: query as never,
            compiledSql: prepared?.plan.sql ?? null,
            datasetVersionIds: prepared?.plan.datasetVersionIds ?? [],
            metricVersionIds: prepared?.plan.metrics.map((m) => m.versionId) ?? [],
            policiesApplied: prepared?.compiled.policiesApplied ?? [],
            status,
            errorCode,
            rowCount: rows ? rows.rows.length : null,
            truncated: rows?.truncated ?? false,
            cached: record.cached,
            durationMs: Date.now() - started,
          },
        }),
      )
      .catch((error: unknown) =>
        this.logger.warn({ err: error }, 'Could not record query history'),
      );
  }

  private async cacheGet(key: string): Promise<SemanticQueryResult | null> {
    try {
      const hit = await this.redis.get(key);
      return hit ? (JSON.parse(hit) as SemanticQueryResult) : null;
    } catch {
      return null; // the cache is an optimization; Redis being down must not fail queries
    }
  }

  private async cacheSet(key: string, result: SemanticQueryResult): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
    } catch {
      // ignore (see cacheGet)
    }
  }
}
