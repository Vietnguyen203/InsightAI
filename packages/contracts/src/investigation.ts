import { z } from 'zod';
import { semanticKeySchema } from './semantic.js';
import { dateRangeSchema, FILTER_OPERATORS } from './semantic-query.js';

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
  startedAt: z.iso.datetime().nullable(),
});
export type InvestigationDetail = z.infer<typeof investigationDetailSchema>;

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
  z.object({ type: z.literal('error'), code: z.string() }),
  z.object({ type: z.literal('done'), status: investigationStatusSchema }),
]);
export type InvestigationEvent = z.infer<typeof investigationEventSchema>;
