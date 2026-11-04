import { z } from 'zod';

/**
 * Semantic model metadata (docs/SEMANTIC_LAYER_DESIGN.md §3). Keys are the stable names used by
 * the Semantic Query IR (`entity.dimension`, `entity.measure`); they never change after creation.
 */
export const SEMANTIC_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
export const semanticKeySchema = z
  .string()
  .regex(SEMANTIC_KEY_PATTERN, 'Use lowercase letters, digits and _, starting with a letter');

export const TIME_GRANULARITIES = ['day', 'week', 'month', 'quarter', 'year'] as const;
export const timeGranularitySchema = z.enum(TIME_GRANULARITIES);
export type TimeGranularity = z.infer<typeof timeGranularitySchema>;

export const MEASURE_AGGREGATIONS = [
  'sum',
  'count',
  'count_distinct',
  'avg',
  'min',
  'max',
] as const;
export const measureAggregationSchema = z.enum(MEASURE_AGGREGATIONS);
export type MeasureAggregation = z.infer<typeof measureAggregationSchema>;

export const semanticModelStatusSchema = z.enum(['DRAFT', 'PUBLISHED']);
export const semanticValidationStatusSchema = z.enum([
  'UNVALIDATED',
  'VALID',
  'WARNING',
  'INVALID',
]);
export type SemanticValidationStatus = z.infer<typeof semanticValidationStatusSchema>;

const name = z.string().trim().min(1).max(120);
const description = z.string().trim().max(2000).nullable().optional();
const columnName = z.string().min(1).max(60);
const expression = z.string().trim().min(1).max(2000);

// ─── Requests ────────────────────────────────────────────────────────────────

export const createSemanticModelRequestSchema = z.object({
  key: semanticKeySchema,
  name,
  description,
});
export type CreateSemanticModelRequest = z.input<typeof createSemanticModelRequestSchema>;

export const updateSemanticModelRequestSchema = z
  .object({ name, description })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateSemanticModelRequest = z.input<typeof updateSemanticModelRequestSchema>;

export const createEntityRequestSchema = z.object({
  key: semanticKeySchema,
  name,
  description,
  datasetId: z.uuid(),
  /** Columns identifying one row of the dataset (the entity grain). */
  primaryKey: z.array(columnName).min(1).max(5),
});
export type CreateEntityRequest = z.input<typeof createEntityRequestSchema>;

export const updateEntityRequestSchema = z
  .object({ name, description, datasetId: z.uuid(), primaryKey: z.array(columnName).min(1).max(5) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateEntityRequest = z.input<typeof updateEntityRequestSchema>;

const dimensionFields = {
  name,
  description,
  type: z.enum(['CATEGORICAL', 'TIME']),
  /** Expression DSL over the entity's columns; usually just a column name. */
  expr: expression,
  /** TIME only: granularities queries may use (default: all). */
  granularities: z.array(timeGranularitySchema).min(1).max(TIME_GRANULARITIES.length).optional(),
  hidden: z.boolean().default(false),
};
export const createDimensionRequestSchema = z.object({
  key: semanticKeySchema,
  ...dimensionFields,
});
export type CreateDimensionRequest = z.input<typeof createDimensionRequestSchema>;
export const updateDimensionRequestSchema = z
  .object(dimensionFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateDimensionRequest = z.input<typeof updateDimensionRequestSchema>;

const measureFields = {
  name,
  description,
  agg: measureAggregationSchema,
  /** Expression DSL over the entity's columns; optional only for `count` (counts rows). */
  expr: expression.nullable().optional(),
};
export const createMeasureRequestSchema = z
  .object({ key: semanticKeySchema, ...measureFields })
  .refine((v) => v.agg === 'count' || (v.expr ?? null) !== null, {
    message: 'expr is required for this aggregation',
    path: ['expr'],
  });
export type CreateMeasureRequest = z.input<typeof createMeasureRequestSchema>;
export const updateMeasureRequestSchema = z
  .object(measureFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateMeasureRequest = z.input<typeof updateMeasureRequestSchema>;

export const relationshipCardinalitySchema = z.enum(['MANY_TO_ONE', 'ONE_TO_ONE']);
const relationshipFields = {
  fromEntityId: z.uuid(),
  toEntityId: z.uuid(),
  /** Column pairs: `from` in the "many" entity, `to` in the "one" entity. */
  joinColumns: z
    .array(z.object({ from: columnName, to: columnName }))
    .min(1)
    .max(5),
  cardinality: relationshipCardinalitySchema,
  /** Chosen when several relationships connect the same two entities. */
  preferred: z.boolean().default(false),
};
export const createRelationshipRequestSchema = z.object(relationshipFields);
export type CreateRelationshipRequest = z.input<typeof createRelationshipRequestSchema>;
export const updateRelationshipRequestSchema = z
  .object(relationshipFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateRelationshipRequest = z.input<typeof updateRelationshipRequestSchema>;

// ─── Responses ───────────────────────────────────────────────────────────────

export const semanticValidationIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  /** Stable code, translated by clients (message is an English fallback). */
  code: z.string(),
  message: z.string(),
  /** Where the issue is, e.g. "order.total_amount" or "relationship:<id>". */
  path: z.string().nullable(),
});
export type SemanticValidationIssue = z.infer<typeof semanticValidationIssueSchema>;

export const semanticValidationReportSchema = z.object({
  status: semanticValidationStatusSchema,
  checkedAt: z.iso.datetime(),
  issues: z.array(semanticValidationIssueSchema),
});
export type SemanticValidationReport = z.infer<typeof semanticValidationReportSchema>;

export const dimensionSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(['CATEGORICAL', 'TIME']),
  expr: z.string(),
  granularities: z.array(timeGranularitySchema),
  hidden: z.boolean(),
});
export type Dimension = z.infer<typeof dimensionSchema>;

export const measureSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  agg: measureAggregationSchema,
  expr: z.string().nullable(),
});
export type Measure = z.infer<typeof measureSchema>;

export const entitySchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  datasetId: z.uuid(),
  datasetName: z.string(),
  primaryKey: z.array(z.string()),
  dimensions: z.array(dimensionSchema),
  measures: z.array(measureSchema),
});
export type Entity = z.infer<typeof entitySchema>;

export const relationshipSchema = z.object({
  id: z.uuid(),
  fromEntityId: z.uuid(),
  toEntityId: z.uuid(),
  joinColumns: z.array(z.object({ from: z.string(), to: z.string() })),
  cardinality: relationshipCardinalitySchema,
  preferred: z.boolean(),
});
export type Relationship = z.infer<typeof relationshipSchema>;

export const semanticModelSummarySchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: semanticModelStatusSchema,
  /** True when the draft differs from the published revision. */
  hasDraftChanges: z.boolean(),
  validationStatus: semanticValidationStatusSchema,
  /** Published revision number (0 = never published). */
  revision: z.number().int(),
  publishedAt: z.iso.datetime().nullable(),
  entityCount: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SemanticModelSummary = z.infer<typeof semanticModelSummarySchema>;

export const semanticModelDetailSchema = semanticModelSummarySchema.extend({
  entities: z.array(entitySchema),
  relationships: z.array(relationshipSchema),
  validationReport: semanticValidationReportSchema.nullable(),
});
export type SemanticModelDetail = z.infer<typeof semanticModelDetailSchema>;
