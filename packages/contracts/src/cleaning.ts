import { z } from 'zod';
import { columnDataTypeSchema } from './dataset.js';
import { qualityStatusSchema } from './quality.js';

const columnName = z.string().min(1).max(60);

/** Same shape as normalized import names: snake_case ASCII starting with a letter. */
export const COLUMN_NAME_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

/** Date layouts `parse_date` can try, in the order given by the user. */
export const DATE_FORMATS = [
  'yyyy-MM-dd',
  'dd/MM/yyyy',
  'MM/dd/yyyy',
  'dd-MM-yyyy',
  'dd.MM.yyyy',
  'yyyy/MM/dd',
  'yyyyMMdd',
] as const;
export const dateFormatSchema = z.enum(DATE_FORMATS);
export type DateFormat = z.infer<typeof dateFormatSchema>;

export const MAX_CLEANING_OPERATIONS = 30;

/**
 * Cleaning operations (docs/DATA_QUALITY_DESIGN.md §6.1). They run in order on the source
 * version and always produce a NEW version; the source is never modified. Columns are referenced
 * by their current name (a rename applies to the operations that follow it).
 */
export const cleaningOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('trim_whitespace'),
    columns: z.array(columnName).min(1).max(300),
    /** Also replace runs of inner whitespace with a single space. */
    collapseInner: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('change_case'),
    columns: z.array(columnName).min(1).max(300),
    mode: z.enum(['lower', 'upper', 'title']),
  }),
  z.object({
    type: z.literal('replace_values'),
    column: columnName,
    mapping: z
      .array(z.object({ from: z.string().max(500), to: z.string().max(500).nullable() }))
      .min(1)
      .max(500),
    caseSensitive: z.boolean().default(true),
  }),
  z
    .object({
      type: z.literal('fill_null'),
      column: columnName,
      strategy: z.enum(['constant', 'mean', 'median', 'mode', 'previous']),
      /** Required for `constant`; written like a rule bound (number, yyyy-MM-dd, true/false, text). */
      value: z.string().max(500).optional(),
    })
    .refine((v) => v.strategy !== 'constant' || v.value !== undefined, {
      message: 'value is required for the constant strategy',
      path: ['value'],
    }),
  z.object({
    type: z.literal('cast_column'),
    column: columnName,
    targetType: columnDataTypeSchema,
    /** Number/date layout to read; defaults to the organization locale. */
    locale: z.enum(['vi', 'en']).optional(),
  }),
  z.object({
    type: z.literal('parse_date'),
    column: columnName,
    formats: z.array(dateFormatSchema).min(1).max(DATE_FORMATS.length),
  }),
  z
    .object({
      type: z.literal('drop_rows'),
      /** Expression DSL; rows where it is true are removed (NULL keeps the row). */
      condition: z.string().min(1).max(2000).optional(),
      /** Remove the rows failing this row-level quality rule. */
      ruleId: z.uuid().optional(),
    })
    .refine((v) => (v.condition === undefined) !== (v.ruleId === undefined), {
      message: 'Exactly one of condition or ruleId is required',
    }),
  z.object({
    type: z.literal('deduplicate'),
    /** Empty or omitted: rows identical in every column. */
    keyColumns: z.array(columnName).max(10).default([]),
    keep: z.enum(['first', 'last']).default('first'),
  }),
  z.object({
    type: z.literal('rename_column'),
    column: columnName,
    newName: z.string().regex(COLUMN_NAME_PATTERN, 'Use lowercase letters, digits and _'),
  }),
  z.object({ type: z.literal('drop_column'), column: columnName }),
]);
export type CleaningOperation = z.infer<typeof cleaningOperationSchema>;
export type CleaningOperationInput = z.input<typeof cleaningOperationSchema>;
export type CleaningOperationType = CleaningOperation['type'];

export const cleaningRequestSchema = z.object({
  /** Defaults to the active version. */
  sourceVersionId: z.uuid().optional(),
  operations: z.array(cleaningOperationSchema).min(1).max(MAX_CLEANING_OPERATIONS),
});
export type CleaningRequest = z.input<typeof cleaningRequestSchema>;

/** Rows changed (or removed) by one operation, counted on the whole table. */
export const operationImpactSchema = z.object({
  index: z.number().int(),
  type: z.string(),
  /** Rows whose value changed; null for schema-only operations (rename/drop column). */
  affectedRows: z.number().int().nullable(),
  removedRows: z.number().int(),
});
export type OperationImpact = z.infer<typeof operationImpactSchema>;

export const cleaningPreviewSchema = z.object({
  sourceVersionId: z.uuid(),
  rowCountBefore: z.number().int(),
  rowCountAfter: z.number().int(),
  operations: z.array(operationImpactSchema),
  columns: z.array(
    z.object({
      name: z.string(),
      dataType: columnDataTypeSchema,
      /** Name in the source version when it was renamed. */
      previousName: z.string().nullable(),
      previousType: columnDataTypeSchema.nullable(),
      status: z.enum(['unchanged', 'modified', 'renamed', 'removed']),
    }),
  ),
  /** Before/after values of the changed columns for a sample of changed rows. */
  sample: z.object({
    columns: z.array(z.string()),
    rows: z.array(
      z.object({
        rowId: z.number().int(),
        removed: z.boolean(),
        before: z.array(z.string().nullable()),
        /** Null when the row is removed. */
        after: z.array(z.string().nullable()).nullable(),
      }),
    ),
  }),
});
export type CleaningPreview = z.infer<typeof cleaningPreviewSchema>;

export const cleaningJobStatusSchema = z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']);
export type CleaningJobStatus = z.infer<typeof cleaningJobStatusSchema>;

export const cleaningJobSchema = z.object({
  id: z.uuid(),
  datasetId: z.uuid(),
  sourceVersionId: z.uuid(),
  sourceVersionNo: z.number().int(),
  /** The version created by the job, once it succeeded. */
  targetVersionId: z.uuid().nullable(),
  status: cleaningJobStatusSchema,
  operations: z.array(
    z.object({
      seq: z.number().int(),
      operation: cleaningOperationSchema,
      affectedRows: z.number().int().nullable(),
      removedRows: z.number().int().nullable(),
    }),
  ),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  requestedById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type CleaningJob = z.infer<typeof cleaningJobSchema>;

/**
 * Deterministic suggestions derived from quality results and the data (never applied
 * automatically). `rationale.code` is translated by the client; `message` is an English fallback.
 */
export const cleaningSuggestionSchema = z.object({
  id: z.string(),
  operation: cleaningOperationSchema,
  source: z.enum(['RULE']),
  rationale: z.object({
    code: z.string(),
    message: z.string(),
    params: z.record(z.string(), z.union([z.string(), z.number()])),
  }),
  /** Rows the operation is expected to change or remove. */
  estimatedRows: z.number().int().nullable(),
});
export type CleaningSuggestion = z.infer<typeof cleaningSuggestionSchema>;

export const cleaningSuggestionsSchema = z.object({
  versionId: z.uuid(),
  /** The quality check the suggestions are based on (latest successful one), if any. */
  qualityCheckId: z.uuid().nullable(),
  suggestions: z.array(cleaningSuggestionSchema),
});
export type CleaningSuggestions = z.infer<typeof cleaningSuggestionsSchema>;

// ─── Version comparison ────────────────────────────────────────────────────────

export const compareVersionsQuerySchema = z.object({ base: z.uuid(), target: z.uuid() });

const versionSide = z.object({
  id: z.uuid(),
  versionNo: z.number().int(),
  origin: z.enum(['IMPORT', 'CLEANING']),
  rowCount: z.number().int(),
  qualityStatus: qualityStatusSchema,
  qualityScore: z.number().nullable(),
});

export const versionComparisonSchema = z.object({
  base: versionSide,
  target: versionSide,
  rows: z.object({
    /** Rows (by stable row id) present in base but not in target. */
    removed: z.number().int(),
    added: z.number().int(),
    /** Rows present in both with a different value in at least one shared column. */
    changed: z.number().int(),
  }),
  columns: z.array(
    z.object({
      name: z.string(),
      baseType: columnDataTypeSchema.nullable(),
      targetType: columnDataTypeSchema.nullable(),
      status: z.enum(['unchanged', 'added', 'removed', 'retyped']),
      /** Rows whose value differs (shared columns only). */
      changedRows: z.number().int().nullable(),
    }),
  ),
  /** Latest successful check of each side, matched by rule. */
  rules: z.array(
    z.object({
      ruleId: z.uuid().nullable(),
      ruleName: z.string(),
      baseFailed: z.number().int().nullable(),
      targetFailed: z.number().int().nullable(),
      basePassRate: z.number().nullable(),
      targetPassRate: z.number().nullable(),
    }),
  ),
});
export type VersionComparison = z.infer<typeof versionComparisonSchema>;
