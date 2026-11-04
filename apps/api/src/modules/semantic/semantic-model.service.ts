import { Injectable } from '@nestjs/common';
import {
  type createDimensionRequestSchema,
  type createEntityRequestSchema,
  type createMeasureRequestSchema,
  type createRelationshipRequestSchema,
  type createSemanticModelRequestSchema,
  type SemanticModelDetail,
  type SemanticModelSummary,
  TIME_GRANULARITIES,
  type updateDimensionRequestSchema,
  type updateEntityRequestSchema,
  type updateMeasureRequestSchema,
  type updateRelationshipRequestSchema,
  type updateSemanticModelRequestSchema,
} from '@insightai/contracts';
import type { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { uuidv7 } from '../../platform/crypto/ids';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { isUniqueViolation } from '../../platform/prisma/prisma-errors';
import { type DbTransaction, PrismaService } from '../../platform/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { modelInclude, toModelDetail, toModelSummary } from './semantic-mappers';

type Body<T extends z.ZodType> = z.output<T>;

/**
 * Draft editing of semantic models (docs/SEMANTIC_LAYER_DESIGN.md §3, §7). Every change marks the
 * model as having draft changes and clears its validation; queries keep using the published
 * snapshot until the model is validated and published again.
 */
@Injectable()
export class SemanticModelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext): Promise<SemanticModelSummary[]> {
    const models = await this.prisma.runInTenant(ctx.organizationId, (tx) =>
      tx.semanticModel.findMany({
        include: { _count: { select: { entities: true } } },
        orderBy: { updatedAt: 'desc' },
      }),
    );
    return models.map(toModelSummary);
  }

  async get(ctx: TenantContext, modelId: string): Promise<SemanticModelDetail> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) =>
      toModelDetail(await this.findModel(tx, modelId)),
    );
  }

  async create(
    ctx: TenantContext,
    body: Body<typeof createSemanticModelRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      const id = uuidv7();
      await tx.semanticModel.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          key: body.key,
          name: body.name,
          description: body.description ?? null,
          createdById: ctx.userId,
        },
      });
      await this.record(tx, ctx, 'semantic.model_created', id, { key: body.key });
      return id;
    });
  }

  async update(
    ctx: TenantContext,
    modelId: string,
    body: Body<typeof updateSemanticModelRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      await this.findModel(tx, modelId);
      await tx.semanticModel.update({
        where: { id: modelId },
        data: { ...body, ...DRAFT_CHANGED },
      });
      await this.record(tx, ctx, 'semantic.model_updated', modelId, body);
      return modelId;
    });
  }

  // ─── Entities ──────────────────────────────────────────────────────────────

  async createEntity(
    ctx: TenantContext,
    modelId: string,
    body: Body<typeof createEntityRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      await this.findModel(tx, modelId);
      await this.assertDataset(tx, body.datasetId);
      const id = uuidv7();
      await tx.semanticEntity.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          semanticModelId: modelId,
          key: body.key,
          name: body.name,
          description: body.description ?? null,
          datasetId: body.datasetId,
          primaryKey: unique(body.primaryKey, 'primaryKey'),
        },
      });
      await this.changed(tx, ctx, modelId, { entity: body.key, op: 'created' });
      return modelId;
    });
  }

  async updateEntity(
    ctx: TenantContext,
    entityId: string,
    body: Body<typeof updateEntityRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      const entity = await this.findEntity(tx, entityId);
      if (body.datasetId) await this.assertDataset(tx, body.datasetId);
      await tx.semanticEntity.update({
        where: { id: entityId },
        data: {
          ...body,
          ...(body.primaryKey ? { primaryKey: unique(body.primaryKey, 'primaryKey') } : {}),
        },
      });
      await this.changed(tx, ctx, entity.semanticModelId, { entity: entity.key, op: 'updated' });
      return entity.semanticModelId;
    });
  }

  async deleteEntity(ctx: TenantContext, entityId: string): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      const entity = await this.findEntity(tx, entityId);
      // Dimensions, measures and relationships of the entity are removed with it (FK cascade).
      await tx.semanticEntity.delete({ where: { id: entityId } });
      await this.changed(tx, ctx, entity.semanticModelId, { entity: entity.key, op: 'deleted' });
      return entity.semanticModelId;
    });
  }

  // ─── Dimensions & measures (one key namespace per entity) ──────────────────

  async createDimension(
    ctx: TenantContext,
    entityId: string,
    body: Body<typeof createDimensionRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      const entity = await this.findEntity(tx, entityId);
      await this.assertMemberKeyFree(tx, entityId, body.key);
      await tx.semanticDimension.create({
        data: {
          id: uuidv7(),
          organizationId: ctx.organizationId,
          entityId,
          key: body.key,
          name: body.name,
          description: body.description ?? null,
          type: body.type,
          expr: body.expr,
          granularities: granularitiesFor(body.type, body.granularities),
          hidden: body.hidden,
        },
      });
      await this.changed(tx, ctx, entity.semanticModelId, {
        dimension: `${entity.key}.${body.key}`,
        op: 'created',
      });
      return entity.semanticModelId;
    });
  }

  async updateDimension(
    ctx: TenantContext,
    dimensionId: string,
    body: Body<typeof updateDimensionRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      const dimension = await tx.semanticDimension.findUnique({
        where: { id: dimensionId },
        include: { entity: true },
      });
      if (!dimension) throw new NotFoundError('Dimension not found');
      const type = body.type ?? dimension.type;
      await tx.semanticDimension.update({
        where: { id: dimensionId },
        data: {
          ...body,
          granularities:
            body.type !== undefined || body.granularities !== undefined
              ? granularitiesFor(type, body.granularities)
              : undefined,
        },
      });
      await this.changed(tx, ctx, dimension.entity.semanticModelId, {
        dimension: `${dimension.entity.key}.${dimension.key}`,
        op: 'updated',
      });
      return dimension.entity.semanticModelId;
    });
  }

  async deleteDimension(ctx: TenantContext, dimensionId: string): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      const dimension = await tx.semanticDimension.findUnique({
        where: { id: dimensionId },
        include: { entity: true },
      });
      if (!dimension) throw new NotFoundError('Dimension not found');
      await tx.semanticDimension.delete({ where: { id: dimensionId } });
      await this.changed(tx, ctx, dimension.entity.semanticModelId, {
        dimension: `${dimension.entity.key}.${dimension.key}`,
        op: 'deleted',
      });
      return dimension.entity.semanticModelId;
    });
  }

  async createMeasure(
    ctx: TenantContext,
    entityId: string,
    body: Body<typeof createMeasureRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      const entity = await this.findEntity(tx, entityId);
      await this.assertMemberKeyFree(tx, entityId, body.key);
      await tx.semanticMeasure.create({
        data: {
          id: uuidv7(),
          organizationId: ctx.organizationId,
          entityId,
          key: body.key,
          name: body.name,
          description: body.description ?? null,
          agg: body.agg,
          expr: body.expr ?? null,
        },
      });
      await this.changed(tx, ctx, entity.semanticModelId, {
        measure: `${entity.key}.${body.key}`,
        op: 'created',
      });
      return entity.semanticModelId;
    });
  }

  async updateMeasure(
    ctx: TenantContext,
    measureId: string,
    body: Body<typeof updateMeasureRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      const measure = await tx.semanticMeasure.findUnique({
        where: { id: measureId },
        include: { entity: true },
      });
      if (!measure) throw new NotFoundError('Measure not found');
      const agg = body.agg ?? measure.agg;
      const expr = body.expr !== undefined ? body.expr : measure.expr;
      if (agg !== 'count' && expr === null) {
        throw new ValidationError('expr is required for this aggregation', [
          { path: 'expr', message: 'expr is required for this aggregation' },
        ]);
      }
      await tx.semanticMeasure.update({ where: { id: measureId }, data: body });
      await this.changed(tx, ctx, measure.entity.semanticModelId, {
        measure: `${measure.entity.key}.${measure.key}`,
        op: 'updated',
      });
      return measure.entity.semanticModelId;
    });
  }

  async deleteMeasure(ctx: TenantContext, measureId: string): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      const measure = await tx.semanticMeasure.findUnique({
        where: { id: measureId },
        include: { entity: true },
      });
      if (!measure) throw new NotFoundError('Measure not found');
      await tx.semanticMeasure.delete({ where: { id: measureId } });
      await this.changed(tx, ctx, measure.entity.semanticModelId, {
        measure: `${measure.entity.key}.${measure.key}`,
        op: 'deleted',
      });
      return measure.entity.semanticModelId;
    });
  }

  // ─── Relationships ─────────────────────────────────────────────────────────

  async createRelationship(
    ctx: TenantContext,
    modelId: string,
    body: Body<typeof createRelationshipRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      await this.findModel(tx, modelId);
      await this.assertRelationshipEntities(tx, modelId, body.fromEntityId, body.toEntityId);
      const id = uuidv7();
      await tx.semanticRelationship.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          semanticModelId: modelId,
          fromEntityId: body.fromEntityId,
          toEntityId: body.toEntityId,
          joinColumns: body.joinColumns,
          cardinality: body.cardinality,
          preferred: body.preferred,
        },
      });
      await this.changed(tx, ctx, modelId, { relationship: id, op: 'created' });
      return modelId;
    });
  }

  async updateRelationship(
    ctx: TenantContext,
    relationshipId: string,
    body: Body<typeof updateRelationshipRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      const relationship = await tx.semanticRelationship.findUnique({
        where: { id: relationshipId },
      });
      if (!relationship) throw new NotFoundError('Relationship not found');
      await this.assertRelationshipEntities(
        tx,
        relationship.semanticModelId,
        body.fromEntityId ?? relationship.fromEntityId,
        body.toEntityId ?? relationship.toEntityId,
      );
      await tx.semanticRelationship.update({
        where: { id: relationshipId },
        data: {
          ...body,
          joinColumns: body.joinColumns,
        },
      });
      await this.changed(tx, ctx, relationship.semanticModelId, {
        relationship: relationshipId,
        op: 'updated',
      });
      return relationship.semanticModelId;
    });
  }

  async deleteRelationship(
    ctx: TenantContext,
    relationshipId: string,
  ): Promise<SemanticModelDetail> {
    return this.write(ctx, async (tx) => {
      const relationship = await tx.semanticRelationship.findUnique({
        where: { id: relationshipId },
      });
      if (!relationship) throw new NotFoundError('Relationship not found');
      await tx.semanticRelationship.delete({ where: { id: relationshipId } });
      await this.changed(tx, ctx, relationship.semanticModelId, {
        relationship: relationshipId,
        op: 'deleted',
      });
      return relationship.semanticModelId;
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Runs a change and returns the model as it is afterwards. */
  private async write(
    ctx: TenantContext,
    work: (tx: DbTransaction) => Promise<string>,
  ): Promise<SemanticModelDetail> {
    return this.prisma
      .runInContext({ organizationId: ctx.organizationId, userId: ctx.userId }, async (tx) => {
        const modelId = await work(tx);
        return toModelDetail(await this.findModel(tx, modelId));
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictError('This key is already used');
        throw error;
      });
  }

  async findModel(tx: DbTransaction, modelId: string) {
    // RLS limits the lookup to the current organization: other tenants' ids look missing.
    const model = await tx.semanticModel.findUnique({
      where: { id: modelId },
      include: modelInclude,
    });
    if (!model) throw new NotFoundError('Semantic model not found');
    return model;
  }

  private async findEntity(tx: DbTransaction, entityId: string) {
    const entity = await tx.semanticEntity.findUnique({ where: { id: entityId } });
    if (!entity) throw new NotFoundError('Entity not found');
    return entity;
  }

  private async assertDataset(tx: DbTransaction, datasetId: string): Promise<void> {
    const dataset = await tx.dataset.findUnique({ where: { id: datasetId } });
    if (!dataset) throw new NotFoundError('Dataset not found');
    if (dataset.archivedAt) throw new ConflictError('Archived datasets cannot be used');
  }

  /** Dimension and measure keys share one namespace per entity (`entity.member` in the IR). */
  private async assertMemberKeyFree(tx: DbTransaction, entityId: string, key: string) {
    const [dimension, measure] = [
      await tx.semanticDimension.findUnique({ where: { entityId_key: { entityId, key } } }),
      await tx.semanticMeasure.findUnique({ where: { entityId_key: { entityId, key } } }),
    ];
    if (dimension || measure) throw new ConflictError(`"${key}" is already used in this entity`);
  }

  private async assertRelationshipEntities(
    tx: DbTransaction,
    modelId: string,
    fromEntityId: string,
    toEntityId: string,
  ): Promise<void> {
    if (fromEntityId === toEntityId) {
      throw new ValidationError('A relationship needs two different entities');
    }
    const count = await tx.semanticEntity.count({
      where: { id: { in: [fromEntityId, toEntityId] }, semanticModelId: modelId },
    });
    if (count !== 2) throw new NotFoundError('Both entities must belong to this model');
  }

  /** Marks the draft as changed: validation must run again before publishing. */
  private async changed(
    tx: DbTransaction,
    ctx: TenantContext,
    modelId: string,
    changes: Prisma.InputJsonObject,
  ): Promise<void> {
    await tx.semanticModel.update({ where: { id: modelId }, data: DRAFT_CHANGED });
    await this.record(tx, ctx, 'semantic.model_changed', modelId, changes);
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

const DRAFT_CHANGED = {
  hasDraftChanges: true,
  validationStatus: 'UNVALIDATED',
  validationReport: Prisma.DbNull,
} as const;

function unique(values: string[], field: string): string[] {
  if (new Set(values).size !== values.length) {
    throw new ValidationError(`${field} lists a column more than once`, [
      { path: field, message: 'Duplicate column' },
    ]);
  }
  return values;
}

/** TIME dimensions default to every granularity; categorical ones have none. */
function granularitiesFor(type: 'CATEGORICAL' | 'TIME', requested?: string[]): string[] {
  if (type === 'CATEGORICAL') return [];
  return requested ? [...new Set(requested)] : [...TIME_GRANULARITIES];
}
