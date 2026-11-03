import { z } from 'zod';
import { userSummarySchema } from './auth.js';

export const columnDataTypeSchema = z.enum([
  'TEXT',
  'INTEGER',
  'DECIMAL',
  'BOOLEAN',
  'DATE',
  'TIMESTAMP',
]);
export type ColumnDataType = z.infer<typeof columnDataTypeSchema>;

export const datasetStatusSchema = z.enum(['DRAFT', 'READY', 'ARCHIVED']);
export const importStatusSchema = z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']);
export type ImportStatus = z.infer<typeof importStatusSchema>;

/** Upload limits (also enforced server-side; assumption A1 in docs/ARCHITECTURE.md). */
export const IMPORT_LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxRows: 2_000_000,
  maxColumns: 300,
  acceptedExtensions: ['.csv', '.txt', '.xlsx'],
} as const;

export const importOptionsSchema = z
  .object({
    /** CSV only. Auto-detected among , ; tab | when omitted. */
    delimiter: z.enum([',', ';', '\t', '|']).optional(),
    /** CSV only. UTF-8 (with or without BOM) and UTF-16 with BOM are detected automatically. */
    encoding: z.enum(['utf-8', 'utf-16le', 'windows-1258', 'windows-1252']).optional(),
    hasHeader: z.boolean().default(true),
    /** XLSX only: worksheet to import (default: the first one). */
    sheetName: z.string().max(100).optional(),
    /** CSV number/date style. vi: 1.234,5 and dd/MM/yyyy; en: 1,234.5 and MM/dd/yyyy. Default: organization locale. */
    locale: z.enum(['vi', 'en']).optional(),
    /** Force column types by normalized column name, overriding inference. */
    columnTypes: z.record(z.string().max(60), columnDataTypeSchema).optional(),
  })
  .strict();
export type ImportOptions = z.input<typeof importOptionsSchema>;

export const createDatasetRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
});
export type CreateDatasetRequest = z.input<typeof createDatasetRequestSchema>;

export const updateDatasetRequestSchema = createDatasetRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export type UpdateDatasetRequest = z.input<typeof updateDatasetRequestSchema>;

export const reimportRequestSchema = z.object({
  dataSourceId: z.uuid(),
  options: importOptionsSchema.default({ hasHeader: true }),
});
export type ReimportRequest = z.input<typeof reimportRequestSchema>;

export const importErrorSchema = z.object({ code: z.string(), message: z.string() });

export const importJobSchema = z.object({
  id: z.uuid(),
  datasetId: z.uuid(),
  dataSource: z.object({
    id: z.uuid(),
    originalFilename: z.string(),
    fileFormat: z.enum(['csv', 'xlsx']),
    sizeBytes: z.number().int(),
  }),
  status: importStatusSchema,
  options: z.record(z.string(), z.unknown()),
  rowsRead: z.number().int().nullable(),
  warnings: z.array(
    z.object({ code: z.string(), message: z.string(), count: z.number().int().optional() }),
  ),
  error: importErrorSchema.nullable(),
  versionId: z.uuid().nullable(),
  requestedBy: userSummarySchema.nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ImportJob = z.infer<typeof importJobSchema>;

export const datasetColumnSchema = z.object({
  ordinal: z.number().int(),
  name: z.string(),
  originalName: z.string(),
  dataType: columnDataTypeSchema,
  inferredType: columnDataTypeSchema,
  typeConfidence: z.number(),
  detectedFormat: z.string().nullable(),
  nonEmptyCount: z.number().int(),
  invalidCount: z.number().int(),
});
export type DatasetColumn = z.infer<typeof datasetColumnSchema>;

export const datasetVersionSchema = z.object({
  id: z.uuid(),
  versionNo: z.number().int(),
  origin: z.enum(['IMPORT', 'CLEANING']),
  rowCount: z.number().int(),
  importJobId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type DatasetVersion = z.infer<typeof datasetVersionSchema>;

export const datasetSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  status: datasetStatusSchema,
  activeVersion: datasetVersionSchema.nullable(),
  columnCount: z.number().int().nullable(),
  latestImport: z
    .object({ id: z.uuid(), status: importStatusSchema, createdAt: z.iso.datetime() })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DatasetSummary = z.infer<typeof datasetSummarySchema>;

export const datasetDetailSchema = datasetSummarySchema.extend({
  columns: z.array(datasetColumnSchema),
  versions: z.array(datasetVersionSchema),
});
export type DatasetDetail = z.infer<typeof datasetDetailSchema>;

export const rowsQuerySchema = z.object({
  versionId: z.uuid().optional(),
  /** Keyset pagination on the row id. */
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type RowsQuery = z.input<typeof rowsQuerySchema>;

/**
 * Cell values are returned as text exactly as PostgreSQL renders them (numbers and dates are
 * never converted to JS numbers/Dates, which would lose precision or shift time zones).
 */
export const rowsPageSchema = z.object({
  versionId: z.uuid(),
  columns: z.array(datasetColumnSchema.pick({ name: true, originalName: true, dataType: true })),
  rows: z.array(z.object({ rowId: z.number().int(), values: z.array(z.string().nullable()) })),
  nextAfter: z.number().int().nullable(),
});
export type RowsPage = z.infer<typeof rowsPageSchema>;
