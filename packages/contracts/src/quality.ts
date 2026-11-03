import { z } from 'zod';

export const qualityDimensionSchema = z.enum([
  'completeness',
  'uniqueness',
  'validity',
  'consistency',
  'referential_integrity',
]);
export type QualityDimension = z.infer<typeof qualityDimensionSchema>;

export const severitySchema = z.enum(['info', 'warning', 'error']);
export type Severity = z.infer<typeof severitySchema>;

const columnName = z.string().min(1).max(60);

/**
 * Rule definitions (docs/DATA_QUALITY_DESIGN.md §4). Columns are referenced by their normalized
 * name, which is stable across dataset versions. Bounds are strings so numbers and dates stay exact.
 */
export const ruleDefinitionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('not_null'), column: columnName }),
  z.object({ type: z.literal('unique'), columns: z.array(columnName).min(1).max(5) }),
  z.object({ type: z.literal('duplicate_rows') }),
  z.object({ type: z.literal('type_castable'), column: columnName }),
  z.object({ type: z.literal('regex'), column: columnName, pattern: z.string().min(1).max(500) }),
  z.object({
    type: z.literal('allowed_values'),
    column: columnName,
    values: z.array(z.string().max(200)).min(1).max(500),
    caseSensitive: z.boolean().default(true),
  }),
  z
    .object({
      type: z.literal('range'),
      column: columnName,
      min: z.string().max(40).optional(),
      max: z.string().max(40).optional(),
    })
    .refine((v) => v.min !== undefined || v.max !== undefined, 'min or max is required'),
  z
    .object({
      type: z.literal('length'),
      column: columnName,
      min: z.number().int().min(0).max(100_000).optional(),
      max: z.number().int().min(0).max(100_000).optional(),
    })
    .refine((v) => v.min !== undefined || v.max !== undefined, 'min or max is required'),
  /** Row passes when the expression is true (or NULL: unknown is not a violation). */
  z.object({ type: z.literal('expression'), expr: z.string().min(1).max(2000) }),
  z.object({
    type: z.literal('foreign_key'),
    column: columnName,
    refDatasetId: z.uuid(),
    refColumn: columnName,
  }),
]);
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;
export type RuleType = RuleDefinition['type'];

/** Each rule type belongs to exactly one quality dimension. */
export const RULE_DIMENSION: Record<RuleType, QualityDimension> = {
  not_null: 'completeness',
  unique: 'uniqueness',
  duplicate_rows: 'uniqueness',
  type_castable: 'validity',
  regex: 'validity',
  allowed_values: 'validity',
  range: 'validity',
  length: 'validity',
  expression: 'consistency',
  foreign_key: 'referential_integrity',
};

export const createRuleRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  definition: ruleDefinitionSchema,
  severity: severitySchema.default('warning'),
  weight: z.number().int().min(1).max(10).default(1),
  /** The rule passes when at least this share of evaluated rows pass (1 = every row). */
  threshold: z.number().min(0).max(1).default(1),
  enabled: z.boolean().default(true),
});
export type CreateRuleRequest = z.input<typeof createRuleRequestSchema>;

export const updateRuleRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    definition: ruleDefinitionSchema,
    severity: severitySchema,
    weight: z.number().int().min(1).max(10),
    threshold: z.number().min(0).max(1),
    enabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateRuleRequest = z.input<typeof updateRuleRequestSchema>;

export const qualityRuleSchema = z.object({
  id: z.uuid(),
  datasetId: z.uuid(),
  name: z.string(),
  dimension: qualityDimensionSchema,
  definition: ruleDefinitionSchema,
  severity: severitySchema,
  weight: z.number().int(),
  threshold: z.number(),
  enabled: z.boolean(),
  /** System rules are created automatically; they can be disabled or re-weighted, not deleted. */
  origin: z.enum(['system', 'user']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type QualityRule = z.infer<typeof qualityRuleSchema>;

export const qualityStatusSchema = z.enum(['UNCHECKED', 'PASSED', 'WARNING', 'FAILED']);
export type QualityStatus = z.infer<typeof qualityStatusSchema>;

export const checkStatusSchema = z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']);

export const qualityCheckSummarySchema = z.object({
  id: z.uuid(),
  datasetId: z.uuid(),
  versionId: z.uuid(),
  versionNo: z.number().int(),
  trigger: z.enum(['IMPORT', 'MANUAL', 'CLEANING']),
  status: checkStatusSchema,
  /** 0–100, null until the check succeeded. */
  score: z.number().nullable(),
  qualityStatus: qualityStatusSchema,
  dimensionScores: z.record(qualityDimensionSchema, z.number().nullable()),
  rulesTotal: z.number().int(),
  rulesFailed: z.number().int(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type QualityCheckSummary = z.infer<typeof qualityCheckSummarySchema>;

export const ruleResultSchema = z.object({
  id: z.uuid(),
  ruleId: z.uuid().nullable(),
  /** The rule as it was when the check ran. */
  ruleName: z.string(),
  dimension: qualityDimensionSchema,
  definition: ruleDefinitionSchema,
  severity: severitySchema,
  weight: z.number().int(),
  threshold: z.number(),
  status: z.enum(['PASSED', 'FAILED', 'SKIPPED', 'ERROR']),
  evaluatedCount: z.number().int(),
  failedCount: z.number().int(),
  passRate: z.number().nullable(),
  message: z.string().nullable(),
  sampleCount: z.number().int(),
});
export type RuleResult = z.infer<typeof ruleResultSchema>;

export const qualityCheckDetailSchema = qualityCheckSummarySchema.extend({
  results: z.array(ruleResultSchema),
});
export type QualityCheckDetail = z.infer<typeof qualityCheckDetailSchema>;

export const qualityIssueSchema = z.object({
  rowId: z.number().int(),
  column: z.string().nullable(),
  /** Value in the typed version (exact text). */
  value: z.string().nullable(),
  /** Original text from the imported file, when it differs from `value`. */
  rawValue: z.string().nullable(),
});
export type QualityIssue = z.infer<typeof qualityIssueSchema>;

export const issuesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.coerce.number().int().min(0).default(0),
});

export const validateExpressionRequestSchema = z.object({ expr: z.string().max(2000) });
export const validateExpressionResponseSchema = z.object({
  valid: z.boolean(),
  type: z.string().optional(),
  columns: z.array(z.string()).optional(),
  error: z.object({ message: z.string(), position: z.number().int().optional() }).optional(),
});
export type ValidateExpressionResponse = z.infer<typeof validateExpressionResponseSchema>;
