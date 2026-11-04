import { z } from 'zod';
import { semanticQueryFilterSchema } from './semantic-query.js';
import { semanticKeySchema } from './semantic.js';

/**
 * Metrics (docs/SEMANTIC_LAYER_DESIGN.md §3, §7): the business definitions users and the AI query.
 * A metric has a stable key and immutable versions; at most one version is PUBLISHED.
 */
const memberRef = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}\.[a-z][a-z0-9_]{0,62}$/, 'Use entity.member');

export const metricDefinitionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SIMPLE'),
    /** `entity.measure` aggregated by the metric. */
    measure: memberRef,
    /** Conditions on dimensions (same shape as query filters), always applied. */
    filters: z.array(semanticQueryFilterSchema).max(10).default([]),
    /** Default time dimension (`entity.dimension`) for date ranges. */
    timeDimension: memberRef.nullable().default(null),
  }),
  z.object({
    type: z.literal('RATIO'),
    numerator: semanticKeySchema,
    denominator: semanticKeySchema,
  }),
  z.object({
    type: z.literal('DERIVED'),
    /** Expression DSL over other metric keys, e.g. `revenue - cost`. */
    expr: z.string().trim().min(1).max(2000),
  }),
]);
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;
export type MetricDefinitionInput = z.input<typeof metricDefinitionSchema>;

export const metricFormatSchema = z.enum(['number', 'currency', 'percent']);

const versionFields = {
  label: z.string().trim().min(1).max(120),
  /** Plain-language meaning shown to users and given to the AI catalog. */
  businessDefinition: z.string().trim().max(2000).nullable().default(null),
  unit: z.string().trim().max(20).nullable().default(null),
  format: metricFormatSchema.default('number'),
  definition: metricDefinitionSchema,
};

export const createMetricRequestSchema = z.object({ key: semanticKeySchema, ...versionFields });
export type CreateMetricRequest = z.input<typeof createMetricRequestSchema>;

/** A new draft version (copy the published one and change what is needed). */
export const createMetricVersionRequestSchema = z.object(versionFields);
export type CreateMetricVersionRequest = z.input<typeof createMetricVersionRequestSchema>;

export const updateMetricVersionRequestSchema = z
  .object(versionFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateMetricVersionRequest = z.input<typeof updateMetricVersionRequestSchema>;

export const metricVersionStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'DEPRECATED']);

export const metricVersionSchema = z.object({
  id: z.uuid(),
  versionNo: z.number().int(),
  status: metricVersionStatusSchema,
  label: z.string(),
  businessDefinition: z.string().nullable(),
  unit: z.string().nullable(),
  format: metricFormatSchema,
  definition: metricDefinitionSchema,
  publishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type MetricVersion = z.infer<typeof metricVersionSchema>;

export const metricSchema = z.object({
  id: z.uuid(),
  semanticModelId: z.uuid(),
  key: z.string(),
  /** DEPRECATED metrics stay queryable (dashboards) but leave the catalog. */
  status: z.enum(['ACTIVE', 'DEPRECATED']),
  published: metricVersionSchema.nullable(),
  draft: metricVersionSchema.nullable(),
  synonyms: z.array(z.string()),
  createdAt: z.iso.datetime(),
});
export type Metric = z.infer<typeof metricSchema>;

export const metricDetailSchema = metricSchema.extend({ versions: z.array(metricVersionSchema) });
export type MetricDetail = z.infer<typeof metricDetailSchema>;

// ─── Synonyms & catalog ────────────────────────────────────────────────────────

export const createSynonymRequestSchema = z.object({
  /** A metric key or a dimension (`entity.dimension`). */
  member: z.union([semanticKeySchema, memberRef]),
  phrase: z.string().trim().min(1).max(120),
});
export type CreateSynonymRequest = z.input<typeof createSynonymRequestSchema>;

export const synonymSchema = z.object({
  id: z.uuid(),
  memberKind: z.enum(['METRIC', 'DIMENSION']),
  member: z.string(),
  phrase: z.string(),
});
export type Synonym = z.infer<typeof synonymSchema>;

/** What a user (or the AI on their behalf) may query, already filtered by access policies. */
export const catalogSchema = z.object({
  model: z.object({ key: z.string(), name: z.string(), revision: z.number().int() }),
  metrics: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      businessDefinition: z.string().nullable(),
      unit: z.string().nullable(),
      format: metricFormatSchema,
      type: z.enum(['SIMPLE', 'RATIO', 'DERIVED']),
      version: z.number().int(),
      timeDimension: z.string().nullable(),
      synonyms: z.array(z.string()),
    }),
  ),
  dimensions: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      type: z.enum(['CATEGORICAL', 'TIME']),
      granularities: z.array(z.string()),
      synonyms: z.array(z.string()),
    }),
  ),
});
export type Catalog = z.infer<typeof catalogSchema>;

export const catalogQuerySchema = z.object({ model: semanticKeySchema });
