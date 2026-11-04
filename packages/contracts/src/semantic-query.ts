import { z } from 'zod';
import { columnDataTypeSchema } from './dataset.js';
import { semanticKeySchema, timeGranularitySchema } from './semantic.js';

/**
 * Semantic Query IR (docs/SEMANTIC_LAYER_DESIGN.md §5): the only way to query data. It references
 * members by key and never contains SQL or expressions. Phase 4b queries measures
 * (`entity.measure`); metrics (4c) build on the same engine.
 */
const memberRef = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}\.[a-z][a-z0-9_]{0,62}$/, 'Use entity.member');

export const DATE_RANGE_PRESETS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
] as const;
export const dateRangePresetSchema = z.enum(DATE_RANGE_PRESETS);

const isoDate = z.iso.date();

export const dateRangeSchema = z.union([
  z.object({ preset: dateRangePresetSchema }),
  /** Inclusive calendar dates in the organization time zone. */
  z
    .object({ from: isoDate, to: isoDate })
    .refine((v) => v.from <= v.to, { message: 'from must not be after to', path: ['to'] }),
]);
export type DateRange = z.infer<typeof dateRangeSchema>;

export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'is_null',
  'not_null',
] as const;

const filterValue = z.union([z.string().max(500), z.number().finite(), z.boolean()]);

export const semanticQueryFilterSchema = z
  .object({
    /** A dimension (`entity.dimension`). */
    member: memberRef,
    op: z.enum(FILTER_OPERATORS),
    values: z.array(filterValue).max(500).optional(),
  })
  .superRefine((f, ctx) => {
    const n = f.values?.length ?? 0;
    const expected =
      f.op === 'is_null' || f.op === 'not_null'
        ? n === 0
        : f.op === 'in' || f.op === 'not_in'
          ? n >= 1
          : n === 1;
    if (!expected) {
      ctx.addIssue({
        code: 'custom',
        message: `Wrong number of values for "${f.op}"`,
        path: ['values'],
      });
    }
  });
export type SemanticQueryFilter = z.infer<typeof semanticQueryFilterSchema>;

export const SEMANTIC_QUERY_MAX_LIMIT = 1000;

export const semanticQuerySchema = z
  .object({
    model: semanticKeySchema,
    /** Published metric keys (the normal way to query). */
    metrics: z.array(semanticKeySchema).max(5).default([]),
    /** Raw measures (`entity.measure`), e.g. for testing a model. */
    measures: z.array(memberRef).max(5).default([]),
    dimensions: z.array(memberRef).max(3).default([]),
    timeDimension: z
      .object({
        /** Defaults to the time dimension of the queried metrics. */
        dimension: memberRef.optional(),
        /** Groups the result by this period; omit to only filter by the date range. */
        granularity: timeGranularitySchema.optional(),
        dateRange: dateRangeSchema.optional(),
        /** Adds the same figures for an earlier period (needs a date range, no granularity). */
        compareTo: z.enum(['previous_period', 'same_period_last_year']).optional(),
      })
      .optional(),
    filters: z.array(semanticQueryFilterSchema).max(10).default([]),
    orderBy: z
      .array(
        z.object({
          /** A requested metric, measure or dimension, or the time column. */
          member: z.union([semanticKeySchema, memberRef]),
          dir: z.enum(['asc', 'desc']).default('asc'),
        }),
      )
      .max(3)
      .default([]),
    limit: z.number().int().min(1).max(SEMANTIC_QUERY_MAX_LIMIT).default(100),
  })
  .refine((q) => q.metrics.length + q.measures.length >= 1, {
    message: 'Query at least one metric or measure',
    path: ['metrics'],
  })
  .refine((q) => q.metrics.length + q.measures.length <= 5, {
    message: 'At most 5 metrics and measures',
    path: ['metrics'],
  });
export type SemanticQuery = z.input<typeof semanticQuerySchema>;
export type SemanticQueryParsed = z.output<typeof semanticQuerySchema>;

export const queryColumnSchema = z.object({
  /** Member key; the time column is `entity.dimension` too (bucketed by `granularity`). */
  key: z.string(),
  name: z.string(),
  kind: z.enum(['dimension', 'time', 'measure', 'metric']),
  /** True for the earlier-period column of `compareTo`. */
  comparison: z.boolean(),
  unit: z.string().nullable(),
  format: z.enum(['number', 'currency', 'percent']).nullable(),
  granularity: timeGranularitySchema.nullable(),
  /** Value type of the column in the result. */
  type: columnDataTypeSchema,
});
export type QueryColumn = z.infer<typeof queryColumnSchema>;

export const semanticQueryResultSchema = z.object({
  columns: z.array(queryColumnSchema),
  /** Values as PostgreSQL renders them (exact decimals, ISO dates); null for missing. */
  rows: z.array(z.array(z.string().nullable())),
  /** True when more rows existed than `limit`. */
  truncated: z.boolean(),
  /** The resolved date range (inclusive), when the query had one. */
  dateRange: z.object({ from: isoDate, to: isoDate }).nullable(),
  /** The earlier period of `compareTo`. */
  compareRange: z.object({ from: isoDate, to: isoDate }).nullable(),
  /** Metric versions that answered the query (provenance). */
  metrics: z.array(z.object({ key: z.string(), version: z.number().int() })),
  modelRevision: z.number().int(),
  cached: z.boolean(),
  /** Names of the access policies that restricted this query. */
  policiesApplied: z.array(z.string()),
});
export type SemanticQueryResult = z.infer<typeof semanticQueryResultSchema>;

export const compiledQuerySchema = z.object({
  sql: z.string(),
  /** Bound parameter values, in order ($1, $2, …). */
  params: z.array(
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.union([z.string(), z.number(), z.boolean()])),
    ]),
  ),
  columns: z.array(queryColumnSchema),
  dateRange: z.object({ from: isoDate, to: isoDate }).nullable(),
  compareRange: z.object({ from: isoDate, to: isoDate }).nullable(),
  metrics: z.array(z.object({ key: z.string(), version: z.number().int() })),
  modelRevision: z.number().int(),
  policiesApplied: z.array(z.string()),
});
export type CompiledQuery = z.infer<typeof compiledQuerySchema>;

// ─── Access policies (§8) ──────────────────────────────────────────────────────

/** `entity.*`, `entity.member`, `metric:*` or `metric:<key>`. */
const memberPattern = z
  .string()
  .regex(/^(?:[a-z][a-z0-9_]{0,62}\.(\*|[a-z][a-z0-9_]{0,62})|metric:(\*|[a-z][a-z0-9_]{0,62}))$/);

const policyFields = {
  name: z.string().trim().min(1).max(120),
  /** System role keys the policy applies to. */
  roles: z.array(z.enum(['owner', 'admin', 'analyst', 'viewer'])).min(1),
  memberAccess: z
    .object({
      include: z.array(memberPattern).max(200).optional(),
      exclude: z.array(memberPattern).max(200).optional(),
    })
    .nullable()
    .optional(),
  /** Rows the role may see: Expression DSL on one entity's columns. */
  rowFilter: z
    .object({ entity: semanticKeySchema, expr: z.string().trim().min(1).max(2000) })
    .nullable()
    .optional(),
  enabled: z.boolean().default(true),
};

export const createAccessPolicyRequestSchema = z.object(policyFields);
export type CreateAccessPolicyRequest = z.input<typeof createAccessPolicyRequestSchema>;
export const updateAccessPolicyRequestSchema = z
  .object(policyFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateAccessPolicyRequest = z.input<typeof updateAccessPolicyRequestSchema>;

export const accessPolicySchema = z.object({
  id: z.uuid(),
  semanticModelId: z.uuid(),
  name: z.string(),
  roles: z.array(z.string()),
  memberAccess: z
    .object({ include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() })
    .nullable(),
  rowFilter: z.object({ entity: z.string(), expr: z.string() }).nullable(),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AccessPolicy = z.infer<typeof accessPolicySchema>;
