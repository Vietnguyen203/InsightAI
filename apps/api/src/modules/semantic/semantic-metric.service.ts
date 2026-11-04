import { Injectable } from '@nestjs/common';
import {
  type Catalog,
  type createMetricRequestSchema,
  type createMetricVersionRequestSchema,
  type CreateSynonymRequest,
  type Dimension,
  type Entity,
  type Metric,
  type MetricDetail,
  metricDefinitionSchema,
  type MetricVersion as MetricVersionDto,
  type Synonym,
  type updateMetricVersionRequestSchema,
} from '@insightai/contracts';
import type { z } from 'zod';
import type { MetricVersion, Prisma } from '../../generated/prisma/client';
import { uuidv7 } from '../../platform/crypto/ids';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { isUniqueViolation } from '../../platform/prisma/prisma-errors';
import { type DbTransaction, PrismaService } from '../../platform/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { policyRules, type StoredPolicy } from '../query-engine/access-policy-rules';
import { QueryEngineService } from '../query-engine/query-engine.service';

type VersionBody = z.output<typeof createMetricVersionRequestSchema>;

/** Lower case without accents (đ → d), single spaces: the synonym lookup key. */
export function normalizePhrase(phrase: string): string {
  return phrase
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const metricInclude = {
  versions: { orderBy: { versionNo: 'desc' } },
} as const;

/**
 * Metric lifecycle (docs/SEMANTIC_LAYER_DESIGN.md §7): DRAFT → PUBLISHED → DEPRECATED. At most one
 * draft and one published version per metric (partial unique indexes); a version that left DRAFT
 * is immutable (trigger). Publishing plans the metric against the published model first, so a
 * published metric is always queryable when published. Also synonyms and the query catalog.
 */
@Injectable()
export class SemanticMetricService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: QueryEngineService,
  ) {}

  async list(ctx: TenantContext, modelId: string): Promise<Metric[]> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      await this.findModel(tx, modelId);
      const [metrics, synonyms] = [
        await tx.metric.findMany({
          where: { semanticModelId: modelId },
          include: metricInclude,
          orderBy: { key: 'asc' },
        }),
        await this.metricSynonyms(tx, modelId),
      ];
      return metrics.map((m) => toMetricDto(m, synonyms.get(m.key) ?? []));
    });
  }

  async get(ctx: TenantContext, metricId: string): Promise<MetricDetail> {
    return this.prisma.runInTenant(ctx.organizationId, (tx) => this.detail(tx, metricId));
  }

  async create(
    ctx: TenantContext,
    modelId: string,
    body: z.output<typeof createMetricRequestSchema>,
  ): Promise<MetricDetail> {
    return this.write(ctx, async (tx) => {
      await this.findModel(tx, modelId);
      const metricId = uuidv7();
      await tx.metric.create({
        data: {
          id: metricId,
          organizationId: ctx.organizationId,
          semanticModelId: modelId,
          key: body.key,
          createdById: ctx.userId,
        },
      });
      await this.insertVersion(tx, ctx, metricId, 1, body);
      await this.record(tx, ctx, 'semantic.metric_created', modelId, { metric: body.key });
      return metricId;
    });
  }

  async createVersion(
    ctx: TenantContext,
    metricId: string,
    body: VersionBody,
  ): Promise<MetricDetail> {
    return this.write(ctx, async (tx) => {
      const metric = await this.findMetric(tx, metricId);
      if (metric.versions.some((v) => v.status === 'DRAFT')) {
        throw new ConflictError('This metric already has a draft version');
      }
      const next = (metric.versions[0]?.versionNo ?? 0) + 1;
      await this.insertVersion(tx, ctx, metricId, next, body);
      await this.record(tx, ctx, 'semantic.metric_changed', metric.semanticModelId, {
        metric: metric.key,
        version: next,
        op: 'draft_created',
      });
      return metricId;
    });
  }

  async updateVersion(
    ctx: TenantContext,
    versionId: string,
    body: z.output<typeof updateMetricVersionRequestSchema>,
  ): Promise<MetricDetail> {
    return this.write(ctx, async (tx) => {
      const version = await this.findDraft(tx, versionId);
      await tx.metricVersion.update({
        where: { id: versionId },
        data: {
          label: body.label,
          businessDefinition: body.businessDefinition,
          unit: body.unit,
          format: body.format,
          ...(body.definition
            ? {
                type: body.definition.type,
                definition: body.definition,
              }
            : {}),
        },
      });
      return version.metricId;
    });
  }

  async deleteDraft(ctx: TenantContext, versionId: string): Promise<MetricDetail | null> {
    return this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const version = await this.findDraft(tx, versionId);
        await tx.metricVersion.delete({ where: { id: versionId } });
        const remaining = await tx.metricVersion.count({ where: { metricId: version.metricId } });
        if (remaining === 0) {
          // A metric that never got past its first draft disappears with it.
          await tx.metric.delete({ where: { id: version.metricId } });
          return null;
        }
        return this.detail(tx, version.metricId);
      },
    );
  }

  /** Validates the draft by planning it, then makes it the published version. */
  async publish(ctx: TenantContext, versionId: string): Promise<MetricDetail> {
    const { metric, version, model } = await this.prisma.runInTenant(
      ctx.organizationId,
      async (tx) => {
        const draft = await this.findDraft(tx, versionId);
        const found = await this.findMetric(tx, draft.metricId);
        const owner = await tx.semanticModel.findUniqueOrThrow({
          where: { id: found.semanticModelId },
        });
        return { metric: found, version: draft, model: owner };
      },
    );
    if (!model.publishedSnapshot) {
      throw new ConflictError('Publish the semantic model before its metrics');
    }
    await this.engine.checkMetric(ctx, model.key, {
      key: metric.key,
      definition: metricDefinitionSchema.parse(version.definition),
    });

    return this.write(ctx, async (tx) => {
      const current = await tx.metricVersion.findUnique({ where: { id: versionId } });
      if (
        current?.status !== 'DRAFT' ||
        current.updatedAt.getTime() !== version.updatedAt.getTime()
      ) {
        throw new ConflictError('The draft changed while it was being checked; publish again');
      }
      // The partial unique index allows one PUBLISHED version: retire the old one first.
      await tx.metricVersion.updateMany({
        where: { metricId: metric.id, status: 'PUBLISHED' },
        data: { status: 'DEPRECATED' },
      });
      await tx.metricVersion.update({
        where: { id: versionId },
        data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: ctx.userId },
      });
      await this.record(tx, ctx, 'semantic.metric_published', metric.semanticModelId, {
        metric: metric.key,
        version: version.versionNo,
      });
      return metric.id;
    });
  }

  /** Deprecated metrics leave the catalog but stay queryable (existing dashboards keep working). */
  async setStatus(
    ctx: TenantContext,
    metricId: string,
    status: 'ACTIVE' | 'DEPRECATED',
  ): Promise<MetricDetail> {
    return this.write(ctx, async (tx) => {
      const metric = await this.findMetric(tx, metricId);
      await tx.metric.update({ where: { id: metricId }, data: { status } });
      await this.record(tx, ctx, 'semantic.metric_changed', metric.semanticModelId, {
        metric: metric.key,
        status,
      });
      return metricId;
    });
  }

  // ─── Synonyms ──────────────────────────────────────────────────────────────

  async listSynonyms(ctx: TenantContext, modelId: string): Promise<Synonym[]> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      await this.findModel(tx, modelId);
      const rows = await tx.semanticSynonym.findMany({
        where: { semanticModelId: modelId },
        orderBy: [{ member: 'asc' }, { phrase: 'asc' }],
      });
      return rows.map(toSynonymDto);
    });
  }

  async addSynonym(
    ctx: TenantContext,
    modelId: string,
    body: CreateSynonymRequest,
  ): Promise<Synonym> {
    return this.prisma
      .runInContext({ organizationId: ctx.organizationId, userId: ctx.userId }, async (tx) => {
        await this.findModel(tx, modelId);
        const isDimension = body.member.includes('.');
        if (isDimension) {
          const [entityKey, dimensionKey] = body.member.split('.');
          const found = await tx.semanticDimension.findFirst({
            where: { key: dimensionKey, entity: { key: entityKey, semanticModelId: modelId } },
          });
          if (!found)
            throw new ValidationError(`Unknown dimension "${body.member}"`, [
              { path: 'member', message: 'Unknown dimension' },
            ]);
        } else {
          const found = await tx.metric.findUnique({
            where: { semanticModelId_key: { semanticModelId: modelId, key: body.member } },
          });
          if (!found)
            throw new ValidationError(`Unknown metric "${body.member}"`, [
              { path: 'member', message: 'Unknown metric' },
            ]);
        }
        const normalized = normalizePhrase(body.phrase);
        if (!normalized) throw new ValidationError('The phrase is empty');
        const row = await tx.semanticSynonym.create({
          data: {
            id: uuidv7(),
            organizationId: ctx.organizationId,
            semanticModelId: modelId,
            memberKind: isDimension ? 'DIMENSION' : 'METRIC',
            member: body.member,
            phrase: body.phrase.trim(),
            phraseNormalized: normalized,
          },
        });
        await this.record(tx, ctx, 'semantic.synonym_added', modelId, {
          member: body.member,
          phrase: body.phrase,
        });
        return toSynonymDto(row);
      })
      .catch((error: unknown) => {
        // One phrase points to one member, otherwise the AI could not map it unambiguously.
        if (isUniqueViolation(error)) throw new ConflictError('This phrase is already used');
        throw error;
      });
  }

  async removeSynonym(ctx: TenantContext, synonymId: string): Promise<void> {
    await this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const row = await tx.semanticSynonym.findUnique({ where: { id: synonymId } });
        if (!row) throw new NotFoundError('Synonym not found');
        await tx.semanticSynonym.delete({ where: { id: synonymId } });
        await this.record(tx, ctx, 'semantic.synonym_removed', row.semanticModelId, {
          member: row.member,
          phrase: row.phrase,
        });
      },
    );
  }

  // ─── Catalog ───────────────────────────────────────────────────────────────

  /** What the caller may query in a published model, filtered by their access policies. */
  async catalog(ctx: TenantContext, modelKey: string): Promise<Catalog> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const model = await tx.semanticModel.findUnique({
        where: { organizationId_key: { organizationId: ctx.organizationId, key: modelKey } },
        include: {
          accessPolicies: true,
          metrics: {
            include: { versions: { where: { status: 'PUBLISHED' } } },
            orderBy: { key: 'asc' },
          },
          synonyms: true,
        },
      });
      if (!model?.publishedSnapshot)
        throw new NotFoundError(`No published semantic model "${modelKey}"`);
      const snapshot = model.publishedSnapshot as unknown as {
        revision: number;
        entities: Entity[];
      };
      const rules = policyRules(
        model.accessPolicies.map((p): StoredPolicy => ({
          name: p.name,
          roles: p.roles,
          enabled: p.enabled,
          memberAccess: p.memberAccess as StoredPolicy['memberAccess'],
          rowFilter: p.rowFilter as StoredPolicy['rowFilter'],
        })),
        ctx.role,
      );
      const synonymsOf = (member: string) =>
        model.synonyms
          .filter((s) => s.member === member)
          .map((s) => s.phrase)
          .sort();

      const dimensions = snapshot.entities.flatMap((e) =>
        e.dimensions
          .filter((d: Dimension) => !d.hidden && rules.allows(`${e.key}.${d.key}`))
          .map((d) => ({
            key: `${e.key}.${d.key}`,
            name: d.name,
            description: d.description,
            type: d.type,
            granularities: d.granularities,
            synonyms: synonymsOf(`${e.key}.${d.key}`),
          })),
      );
      // Ratio and derived metrics use the time dimension of their parts when they all agree.
      const published = new Map(
        model.metrics.flatMap((m) =>
          m.versions[0]
            ? [[m.key, metricDefinitionSchema.parse(m.versions[0].definition)] as const]
            : [],
        ),
      );
      const timeOf = (key: string, seen: Set<string> = new Set()): Set<string> => {
        const def = published.get(key);
        if (!def || seen.has(key)) return new Set();
        seen.add(key);
        if (def.type === 'SIMPLE') return new Set(def.timeDimension ? [def.timeDimension] : []);
        const parts =
          def.type === 'RATIO'
            ? [def.numerator, def.denominator]
            : [...published.keys()].filter((k) => new RegExp(`\\b${k}\\b`).test(def.expr));
        return new Set(parts.flatMap((p) => [...timeOf(p, seen)]));
      };
      const metrics = model.metrics.flatMap((m) => {
        const version = m.versions[0];
        if (m.status !== 'ACTIVE' || !version || !rules.allows(`metric:${m.key}`)) return [];
        const times = [...timeOf(m.key)];
        const definition = metricDefinitionSchema.parse(version.definition);
        return [
          {
            key: m.key,
            label: version.label,
            businessDefinition: version.businessDefinition,
            unit: version.unit,
            format: version.format as Catalog['metrics'][number]['format'],
            type: definition.type,
            version: version.versionNo,
            timeDimension: times.length === 1 ? times[0]! : null,
            synonyms: synonymsOf(m.key),
          },
        ];
      });
      return {
        model: { key: model.key, name: model.name, revision: snapshot.revision },
        metrics,
        dimensions,
      };
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async insertVersion(
    tx: DbTransaction,
    ctx: TenantContext,
    metricId: string,
    versionNo: number,
    body: VersionBody,
  ) {
    await tx.metricVersion.create({
      data: {
        id: uuidv7(),
        organizationId: ctx.organizationId,
        metricId,
        versionNo,
        type: body.definition.type,
        definition: body.definition,
        label: body.label,
        businessDefinition: body.businessDefinition,
        unit: body.unit,
        format: body.format,
        createdById: ctx.userId,
      },
    });
  }

  private async write(
    ctx: TenantContext,
    work: (tx: DbTransaction) => Promise<string>,
  ): Promise<MetricDetail> {
    return this.prisma
      .runInContext({ organizationId: ctx.organizationId, userId: ctx.userId }, async (tx) =>
        this.detail(tx, await work(tx)),
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictError('This key is already used');
        throw error;
      });
  }

  private async detail(tx: DbTransaction, metricId: string): Promise<MetricDetail> {
    const metric = await this.findMetric(tx, metricId);
    const synonyms = await this.metricSynonyms(tx, metric.semanticModelId);
    return {
      ...toMetricDto(metric, synonyms.get(metric.key) ?? []),
      versions: metric.versions.map(toVersionDto),
    };
  }

  private async metricSynonyms(tx: DbTransaction, modelId: string) {
    const rows = await tx.semanticSynonym.findMany({
      where: { semanticModelId: modelId, memberKind: 'METRIC' },
      orderBy: { phrase: 'asc' },
    });
    const byMember = new Map<string, string[]>();
    for (const r of rows) byMember.set(r.member, [...(byMember.get(r.member) ?? []), r.phrase]);
    return byMember;
  }

  private async findModel(tx: DbTransaction, modelId: string) {
    const model = await tx.semanticModel.findUnique({ where: { id: modelId } });
    if (!model) throw new NotFoundError('Semantic model not found');
    return model;
  }

  private async findMetric(tx: DbTransaction, metricId: string) {
    const metric = await tx.metric.findUnique({ where: { id: metricId }, include: metricInclude });
    if (!metric) throw new NotFoundError('Metric not found');
    return metric;
  }

  private async findDraft(tx: DbTransaction, versionId: string) {
    const version = await tx.metricVersion.findUnique({ where: { id: versionId } });
    if (!version) throw new NotFoundError('Metric version not found');
    if (version.status !== 'DRAFT') throw new ConflictError('Only a draft version can be changed');
    return version;
  }

  private record(
    tx: DbTransaction,
    ctx: TenantContext,
    action: string,
    modelId: string,
    changes: Prisma.InputJsonObject,
  ) {
    return this.audit.record(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'semantic_model',
      resourceId: modelId,
      changes,
      meta: ctx,
    });
  }
}

function toVersionDto(v: MetricVersion): MetricVersionDto {
  return {
    id: v.id,
    versionNo: v.versionNo,
    status: v.status,
    label: v.label,
    businessDefinition: v.businessDefinition,
    unit: v.unit,
    format: v.format as MetricVersionDto['format'],
    definition: metricDefinitionSchema.parse(v.definition),
    publishedAt: v.publishedAt?.toISOString() ?? null,
    createdAt: v.createdAt.toISOString(),
  };
}

function toMetricDto(
  m: {
    id: string;
    semanticModelId: string;
    key: string;
    status: 'ACTIVE' | 'DEPRECATED';
    createdAt: Date;
    versions: MetricVersion[];
  },
  synonyms: string[],
): Metric {
  const published = m.versions.find((v) => v.status === 'PUBLISHED');
  const draft = m.versions.find((v) => v.status === 'DRAFT');
  return {
    id: m.id,
    semanticModelId: m.semanticModelId,
    key: m.key,
    status: m.status,
    published: published ? toVersionDto(published) : null,
    draft: draft ? toVersionDto(draft) : null,
    synonyms,
    createdAt: m.createdAt.toISOString(),
  };
}

const toSynonymDto = (s: {
  id: string;
  memberKind: string;
  member: string;
  phrase: string;
}): Synonym => ({
  id: s.id,
  memberKind: s.memberKind as Synonym['memberKind'],
  member: s.member,
  phrase: s.phrase,
});
