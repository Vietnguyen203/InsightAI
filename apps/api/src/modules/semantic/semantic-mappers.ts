import type {
  Dimension,
  Entity,
  Measure,
  MeasureAggregation,
  Relationship,
  SemanticModelDetail,
  SemanticModelSummary,
  SemanticValidationReport,
  TimeGranularity,
} from '@insightai/contracts';
import type {
  SemanticDimension,
  SemanticEntity,
  SemanticMeasure,
  SemanticModel,
  SemanticRelationship,
} from '../../generated/prisma/client';

export type ModelWithMembers = SemanticModel & {
  entities: (SemanticEntity & {
    dataset: { name: string };
    dimensions: SemanticDimension[];
    measures: SemanticMeasure[];
  })[];
  relationships: SemanticRelationship[];
};

/** Prisma include that loads a model with every member, in a stable order. */
export const modelInclude = {
  entities: {
    orderBy: { createdAt: 'asc' },
    include: {
      dataset: { select: { name: true } },
      dimensions: { orderBy: { createdAt: 'asc' } },
      measures: { orderBy: { createdAt: 'asc' } },
    },
  },
  relationships: { orderBy: { createdAt: 'asc' } },
} as const;

export function toModelSummary(
  model: SemanticModel & { _count?: { entities: number }; entities?: unknown[] },
): SemanticModelSummary {
  return {
    id: model.id,
    key: model.key,
    name: model.name,
    description: model.description,
    status: model.status,
    hasDraftChanges: model.hasDraftChanges,
    validationStatus: model.validationStatus,
    revision: model.revision,
    publishedAt: model.publishedAt?.toISOString() ?? null,
    entityCount: model._count?.entities ?? model.entities?.length ?? 0,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}

export const toDimensionDto = (d: SemanticDimension): Dimension => ({
  id: d.id,
  key: d.key,
  name: d.name,
  description: d.description,
  type: d.type,
  expr: d.expr,
  granularities: d.granularities as TimeGranularity[],
  hidden: d.hidden,
});

export const toMeasureDto = (m: SemanticMeasure): Measure => ({
  id: m.id,
  key: m.key,
  name: m.name,
  description: m.description,
  agg: m.agg as MeasureAggregation,
  expr: m.expr,
});

export const toRelationshipDto = (r: SemanticRelationship): Relationship => ({
  id: r.id,
  fromEntityId: r.fromEntityId,
  toEntityId: r.toEntityId,
  joinColumns: r.joinColumns as Relationship['joinColumns'],
  cardinality: r.cardinality,
  preferred: r.preferred,
});

export function toEntityDto(e: ModelWithMembers['entities'][number]): Entity {
  return {
    id: e.id,
    key: e.key,
    name: e.name,
    description: e.description,
    datasetId: e.datasetId,
    datasetName: e.dataset.name,
    primaryKey: e.primaryKey,
    dimensions: e.dimensions.map(toDimensionDto),
    measures: e.measures.map(toMeasureDto),
  };
}

export function toModelDetail(model: ModelWithMembers): SemanticModelDetail {
  return {
    ...toModelSummary(model),
    entities: model.entities.map(toEntityDto),
    relationships: model.relationships.map(toRelationshipDto),
    validationReport: (model.validationReport as SemanticValidationReport | null) ?? null,
  };
}

/**
 * Immutable copy of a published model (`semantic_models.published_snapshot`). The query engine
 * (Phase 4b) reads only this, so draft edits never change what queries see until republished.
 */
export interface SemanticSnapshot {
  revision: number;
  publishedAt: string;
  entities: Entity[];
  relationships: Relationship[];
}

export function toSnapshot(model: ModelWithMembers, revision: number, at: Date): SemanticSnapshot {
  return {
    revision,
    publishedAt: at.toISOString(),
    entities: model.entities.map(toEntityDto),
    relationships: model.relationships.map(toRelationshipDto),
  };
}
