import { z } from 'zod';
import { chartSpecSchema } from './ai.js';
import { semanticKeySchema } from './semantic.js';
import {
  dateRangeSchema,
  FILTER_OPERATORS,
  semanticQueryResultSchema,
  semanticQuerySchema,
} from './semantic-query.js';

/**
 * Analysis Plan IR (docs/PHASE6_AI_ANALYST_DESIGN.md §2.3): what the planner (LLM) may propose.
 * Only references to catalog keys, periods and bounded parameters – no SQL, formulas or figures.
 * The server validates it against the user's catalog before anything runs.
 */

export const MAX_PLAN_STEPS = 12;
export const MAX_HYPOTHESES = 5;

const memberRef = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'entity.member');
const stepId = z.string().regex(/^s([1-9]|1[0-2])$/, 's1 … s12');
const hypothesisId = z.string().regex(/^h[1-5]$/, 'h1 … h5');
const text = z.string().trim().min(1).max(300);

export const baselineSchema = z.union([
  dateRangeSchema,
  z.enum(['previous_period', 'same_period_last_year']),
]);

const filterValue = z.union([z.string().max(200), z.number().finite(), z.boolean()]);
export const planFilterSchema = z.strictObject({
  member: memberRef,
  op: z.enum(FILTER_OPERATORS),
  values: z.array(filterValue).max(20).optional(),
});

/** Members chosen from an earlier step's result (resolved by the server, never by the LLM). */
export const memberScopeSchema = z.strictObject({
  fromStep: stepId,
  pick: z.enum(['top_contributors', 'top_decliners', 'anomalous_members']),
  k: z.number().int().min(1).max(5),
});

const metrics = (max: number) => z.array(semanticKeySchema).min(1).max(max);
const common = {
  id: stepId,
  purpose: text,
  filters: z.array(planFilterSchema).max(5).optional(),
};

export const planStepSchema = z.discriminatedUnion('tool', [
  z.strictObject({
    ...common,
    tool: z.literal('metric_snapshot'),
    metrics: metrics(5),
    period: dateRangeSchema.optional(),
  }),
  z.strictObject({
    ...common,
    tool: z.literal('compare_periods'),
    metrics: metrics(3),
    current: dateRangeSchema,
    baseline: baselineSchema,
  }),
  z.strictObject({
    ...common,
    tool: z.literal('contribution'),
    metric: semanticKeySchema,
    dimension: memberRef,
    current: dateRangeSchema,
    baseline: baselineSchema,
    scope: memberScopeSchema.optional(),
  }),
  z.strictObject({
    ...common,
    tool: z.literal('trend'),
    metrics: metrics(3),
    granularity: z.enum(['day', 'week', 'month', 'quarter']),
    period: dateRangeSchema,
    scope: memberScopeSchema.optional(),
  }),
  z.strictObject({
    ...common,
    tool: z.literal('distribution'),
    metric: semanticKeySchema,
    dimension: memberRef,
    period: dateRangeSchema.optional(),
  }),
  z.strictObject({
    ...common,
    tool: z.literal('anomaly'),
    metric: semanticKeySchema,
    granularity: z.enum(['day', 'week']),
    period: dateRangeSchema,
    dimension: memberRef.optional(),
  }),
]);
export type PlanStep = z.infer<typeof planStepSchema>;
export type PlanTool = PlanStep['tool'];

export const hypothesisSchema = z.strictObject({
  id: hypothesisId,
  statement: text,
  expectation: z.strictObject({
    kind: z.enum(['member_drives_change', 'metric_changed', 'trend_direction', 'anomaly_present']),
    stepId,
    member: z.string().max(200).optional(),
    direction: z.enum(['up', 'down']).optional(),
  }),
});
export type Hypothesis = z.infer<typeof hypothesisSchema>;

export const analysisPlanSchema = z.strictObject({
  version: z.literal(1),
  /** The goal as the planner understood it. */
  goal: text,
  primaryMetric: semanticKeySchema,
  hypotheses: z.array(hypothesisSchema).max(MAX_HYPOTHESES).default([]),
  steps: z.array(planStepSchema).min(1).max(MAX_PLAN_STEPS),
});
export type AnalysisPlan = z.infer<typeof analysisPlanSchema>;

/** Stable reasons a plan is rejected (returned to the planner and shown on failure). */
export const PLAN_ERROR_CODES = [
  'PLAN_INVALID',
  'DUPLICATE_STEP',
  'UNKNOWN_STEP',
  'UNKNOWN_METRIC',
  'UNKNOWN_MEMBER',
  'NOT_ADDITIVE',
  'TIME_DIMENSION_REQUIRED',
  'GRANULARITY_NOT_ALLOWED',
  'SCOPE_NOT_SUPPORTED',
  'BUDGET_EXCEEDED',
  'HYPOTHESIS_UNTESTABLE',
  'TEXT_NOT_ALLOWED',
  'QUERY_REJECTED',
] as const;
export type PlanErrorCode = (typeof PLAN_ERROR_CODES)[number];
export interface PlanError {
  code: PlanErrorCode;
  /** Where in the plan (`steps.2.metric`, `hypotheses.0`). */
  path: string;
  message: string;
}

// ─── API ─────────────────────────────────────────────────────────────────────

export const INVESTIGATION_STATUSES = [
  'QUEUED',
  'PLANNING',
  'AWAITING_APPROVAL',
  'RUNNING',
  'VALIDATING',
  'REPORTING',
  'COMPLETED',
  'PARTIAL',
  'CANCELLED',
  'FAILED',
] as const;
export const investigationStatusSchema = z.enum(INVESTIGATION_STATUSES);
export type InvestigationStatus = z.infer<typeof investigationStatusSchema>;
export const TERMINAL_INVESTIGATION_STATUSES: readonly InvestigationStatus[] = [
  'COMPLETED',
  'PARTIAL',
  'CANCELLED',
  'FAILED',
];

export const STEP_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'] as const;
export const stepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const createInvestigationRequestSchema = z.object({
  model: semanticKeySchema,
  goal: z.string().trim().min(5).max(1000),
  /** Stop after planning until the user approves the plan. */
  requireApproval: z.boolean().default(false),
});
export type CreateInvestigationRequest = z.input<typeof createInvestigationRequestSchema>;

export const investigationBudgetSchema = z.object({
  maxSteps: z.number().int(),
  maxQueries: z.number().int(),
  maxTokens: z.number().int(),
  maxDurationMs: z.number().int(),
});
export const investigationUsageSchema = z.object({
  steps: z.number().int(),
  queries: z.number().int(),
  tokens: z.number().int(),
  durationMs: z.number().int(),
});

export const investigationStepSchema = z.object({
  id: z.uuid(),
  stepKey: z.string(),
  tool: z.string(),
  purpose: z.string(),
  status: stepStatusSchema,
  attempt: z.number().int(),
  /** Deterministic result of the analysis engine (null until the step succeeded). */
  output: z.unknown().nullable(),
  queryHistoryIds: z.array(z.uuid()),
  errorCode: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type InvestigationStep = z.infer<typeof investigationStepSchema>;

export const investigationSummarySchema = z.object({
  id: z.uuid(),
  model: z.string(),
  goal: z.string(),
  status: investigationStatusSchema,
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type InvestigationSummary = z.infer<typeof investigationSummarySchema>;

// ─── Evidence, hypotheses, findings (Phase 6E) ───────────────────────────────

/**
 * What a step proved, frozen at the time it ran: the queries (IR), the versions of the model,
 * metrics and datasets, the policies applied and the result rows. Shown as is later – never
 * re-run against newer definitions.
 */
export const evidenceSchema = z.object({
  id: z.uuid(),
  stepKey: z.string(),
  kind: z.string(),
  queries: z.array(semanticQuerySchema),
  queryHistoryIds: z.array(z.uuid()),
  versions: z.object({
    modelRevision: z.number().int(),
    metrics: z.array(z.object({ key: z.string(), version: z.number().int() })),
    datasets: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        versionNo: z.number().int(),
        qualityScore: z.number().nullable(),
      }),
    ),
  }),
  policiesApplied: z.array(z.string()),
  results: z.array(semanticQueryResultSchema),
  /** Named figures for the report (`{{ev:<id>.<name>}}`): exact decimals or rounded statistics. */
  values: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  limitations: z.array(z.string()),
  createdAt: z.iso.datetime(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const HYPOTHESIS_STATUSES = [
  'SUPPORTED',
  'NOT_SUPPORTED',
  'INCONCLUSIVE',
  'UNTESTED',
] as const;
export const hypothesisStatusSchema = z.enum(HYPOTHESIS_STATUSES);
export type HypothesisStatus = z.infer<typeof hypothesisStatusSchema>;

export const hypothesisResultSchema = z.object({
  key: z.string(),
  statement: z.string(),
  status: hypothesisStatusSchema,
  /** Deterministic rule, its thresholds and what was observed. */
  rule: z.object({
    name: z.string(),
    reason: z.string(),
    thresholds: z.record(z.string(), z.number()),
    observed: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  }),
  evidenceIds: z.array(z.uuid()),
});
export type HypothesisResult = z.infer<typeof hypothesisResultSchema>;

export const findingSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  /** Deterministic sentence template (6F renders it with the parameters). */
  templateKey: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  evidenceIds: z.array(z.uuid()),
  /** False when no evidence backs it: shown as "not verified". */
  verified: z.boolean(),
  importance: z.number(),
  limitations: z.array(z.string()),
});
export type Finding = z.infer<typeof findingSchema>;

export const investigationDetailSchema = investigationSummarySchema.extend({
  requireApproval: z.boolean(),
  plan: analysisPlanSchema.nullable(),
  /** Model revision and metric versions the investigation is pinned to. */
  pinned: z
    .object({ modelRevision: z.number().int(), metrics: z.record(z.string(), z.number().int()) })
    .nullable(),
  budget: investigationBudgetSchema,
  usage: investigationUsageSchema,
  cancelRequested: z.boolean(),
  errorMessage: z.string().nullable(),
  steps: z.array(investigationStepSchema),
  hypotheses: z.array(hypothesisResultSchema),
  /** Most important first. */
  findings: z.array(findingSchema),
  startedAt: z.iso.datetime().nullable(),
});
export type InvestigationDetail = z.infer<typeof investigationDetailSchema>;

// ─── Report (Phase 6F) ───────────────────────────────────────────────────────

/**
 * Text of the report as segments: every figure is a `value` segment tied to the evidence it
 * comes from (the UI opens that evidence), so no number in the report stands on its own.
 */
export const reportSegmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('value'),
    text: z.string(),
    evidenceId: z.uuid(),
    /** Name of the figure in the evidence or finding (`total.delta`, `share`). */
    name: z.string(),
  }),
]);
export type ReportSegment = z.infer<typeof reportSegmentSchema>;

export const reportParagraphSchema = z.object({
  /** `llm` when the model's wording passed the guard, `template` for the deterministic text. */
  source: z.enum(['llm', 'template']),
  segments: z.array(reportSegmentSchema),
});
export type ReportParagraph = z.infer<typeof reportParagraphSchema>;

export const investigationReportSchema = z.object({
  investigationId: z.uuid(),
  lang: z.enum(['vi', 'en']),
  /** `llm` when the model wrote at least part of the text, otherwise `deterministic`. */
  renderer: z.enum(['llm', 'deterministic']),
  /** How the run ended (COMPLETED or PARTIAL). */
  status: investigationStatusSchema,
  goal: z.string(),
  summary: reportParagraphSchema,
  findings: z.array(
    z.object({
      findingId: z.uuid(),
      kind: z.string(),
      templateKey: z.string(),
      verified: z.boolean(),
      importance: z.number(),
      evidenceIds: z.array(z.uuid()),
      text: reportParagraphSchema,
      /** Drawn from the frozen evidence result (`results[resultIndex]`), never re-run. */
      chart: z
        .object({ evidenceId: z.uuid(), resultIndex: z.number().int(), spec: chartSpecSchema })
        .nullable(),
      limitations: z.array(z.string()),
    }),
  ),
  hypotheses: z.array(
    z.object({
      key: z.string(),
      statement: z.string(),
      status: hypothesisStatusSchema,
      /** Wording of the status (correlation, never causation). */
      label: z.string(),
      evidenceIds: z.array(z.uuid()),
    }),
  ),
  /** Suggestions only, each tied to at least one finding. */
  recommendations: z.array(
    z.object({ text: reportParagraphSchema, findingIds: z.array(z.uuid()).min(1) }),
  ),
  /** Generated from the evidence limitations, data quality and steps that did not run. */
  limitations: z.array(
    z.object({ code: z.string(), text: z.string(), evidenceIds: z.array(z.uuid()) }),
  ),
  createdAt: z.iso.datetime(),
});
export type InvestigationReport = z.infer<typeof investigationReportSchema>;

/** Server-sent events of GET /investigations/:id/events (`id:` = sequence for resuming). */
export const investigationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), status: investigationStatusSchema }),
  z.object({
    type: z.literal('plan_ready'),
    steps: z.number().int(),
    requiresApproval: z.boolean(),
  }),
  z.object({ type: z.literal('step_started'), stepKey: z.string(), tool: z.string() }),
  z.object({ type: z.literal('step_completed'), stepKey: z.string() }),
  z.object({ type: z.literal('step_failed'), stepKey: z.string(), code: z.string() }),
  z.object({ type: z.literal('step_skipped'), stepKey: z.string(), code: z.string() }),
  z.object({ type: z.literal('budget'), usage: investigationUsageSchema }),
  z.object({
    type: z.literal('hypothesis'),
    key: z.string(),
    status: hypothesisStatusSchema,
  }),
  z.object({ type: z.literal('findings'), count: z.number().int() }),
  z.object({ type: z.literal('report_ready'), renderer: z.enum(['llm', 'deterministic']) }),
  z.object({ type: z.literal('error'), code: z.string() }),
  z.object({ type: z.literal('done'), status: investigationStatusSchema }),
]);
export type InvestigationEvent = z.infer<typeof investigationEventSchema>;
