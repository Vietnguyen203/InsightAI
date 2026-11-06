import { z } from 'zod';
import { chartSpecSchema } from './ai.js';
import { semanticQuerySchema } from './semantic-query.js';

export const MAX_DASHBOARDS_PER_ORG = 200;
export const MAX_WIDGETS_PER_DASHBOARD = 30;
/** Columns of the dashboard grid. */
export const DASHBOARD_GRID_COLUMNS = 12;

export const dashboardVisibilitySchema = z.enum(['PRIVATE', 'ORG']);
export type DashboardVisibility = z.infer<typeof dashboardVisibilitySchema>;

/** Position on a 12-column grid; heights are in grid rows. */
export const widgetPositionSchema = z
  .object({
    x: z
      .number()
      .int()
      .min(0)
      .max(DASHBOARD_GRID_COLUMNS - 1),
    y: z.number().int().min(0).max(1000),
    w: z.number().int().min(1).max(DASHBOARD_GRID_COLUMNS),
    h: z.number().int().min(1).max(20),
  })
  .refine((p) => p.x + p.w <= DASHBOARD_GRID_COLUMNS, {
    message: 'The widget must fit in the grid',
    path: ['w'],
  });
export type WidgetPosition = z.infer<typeof widgetPositionSchema>;

const nameSchema = z.string().trim().min(1).max(120);
const descriptionSchema = z.string().trim().max(1000).nullable();

export const createDashboardRequestSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional(),
  visibility: dashboardVisibilitySchema.default('PRIVATE'),
});
export type CreateDashboardRequest = z.input<typeof createDashboardRequestSchema>;

export const updateDashboardRequestSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    /** Only the dashboard's owner may change it. */
    visibility: dashboardVisibilitySchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateDashboardRequest = z.input<typeof updateDashboardRequestSchema>;

/**
 * A widget stores the Semantic Query IR and how to draw it – never SQL or results. It always
 * runs with the permissions and access policies of the person viewing the dashboard.
 */
export const createWidgetRequestSchema = z.union([
  z.object({
    title: z.string().trim().min(1).max(120),
    query: semanticQuerySchema,
    chart: chartSpecSchema,
    position: widgetPositionSchema.optional(),
  }),
  /** Pins an answer of one of the caller's own AI conversations. */
  z.object({
    fromMessageId: z.uuid(),
    title: z.string().trim().min(1).max(120).optional(),
    position: widgetPositionSchema.optional(),
  }),
  /** Pins a finding: the query of one of the caller's own investigation evidence. */
  z.object({
    fromEvidenceId: z.uuid(),
    title: z.string().trim().min(1).max(120).optional(),
    position: widgetPositionSchema.optional(),
  }),
]);
export type CreateWidgetRequest = z.input<typeof createWidgetRequestSchema>;

export const updateWidgetRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    query: semanticQuerySchema.optional(),
    chart: chartSpecSchema.optional(),
    position: widgetPositionSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateWidgetRequest = z.input<typeof updateWidgetRequestSchema>;

export const updateLayoutRequestSchema = z.object({
  widgets: z
    .array(z.object({ id: z.uuid(), position: widgetPositionSchema }))
    .max(MAX_WIDGETS_PER_DASHBOARD),
});
export type UpdateLayoutRequest = z.infer<typeof updateLayoutRequestSchema>;

export const dashboardWidgetSchema = z.object({
  id: z.uuid(),
  dashboardId: z.uuid(),
  title: z.string(),
  query: semanticQuerySchema,
  chart: chartSpecSchema,
  position: widgetPositionSchema,
  /** The AI answer the widget was pinned from, if any. */
  sourceMessageId: z.uuid().nullable(),
  /** Model revision and metric versions when the widget was saved (to flag later changes). */
  savedModelRevision: z.number().int(),
  savedMetricVersions: z.array(z.object({ key: z.string(), version: z.number().int() })),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;

export const dashboardSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  visibility: dashboardVisibilitySchema,
  ownerId: z.uuid(),
  ownerName: z.string().nullable(),
  widgetCount: z.number().int(),
  /** Whether the caller may edit it (owner, or organization owner/admin for ORG dashboards). */
  canEdit: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

export const dashboardDetailSchema = dashboardSummarySchema.extend({
  widgets: z.array(dashboardWidgetSchema),
});
export type DashboardDetail = z.infer<typeof dashboardDetailSchema>;
