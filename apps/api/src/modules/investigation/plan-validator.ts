import {
  type AnalysisPlan,
  type Catalog,
  type DateRange,
  MAX_PLAN_STEPS,
  type PlanError,
  type PlanStep,
  type SemanticQueryParsed,
} from '@insightai/contracts';
import type { ToolInput } from './analysis-tools.service';

/** Limits of one investigation (docs/PHASE6_AI_ANALYST_DESIGN.md §2.4). */
export interface PlanBudget {
  maxSteps: number;
  maxQueries: number;
}

export const DEFAULT_BUDGET = {
  maxSteps: MAX_PLAN_STEPS,
  maxQueries: 30,
  maxTokens: 60_000,
  maxDurationMs: 5 * 60_000,
};

const MAX_RANGE_DAYS = 3 * 366;
const MAX_DAILY_POINTS = 400;
const DIGIT = /\p{Nd}/u;
const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|vn|io)\b/i;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

const PICKS_FROM = {
  top_contributors: 'contribution',
  top_decliners: 'contribution',
  anomalous_members: 'anomaly',
} as const;

const HYPOTHESIS_TOOL = {
  member_drives_change: 'contribution',
  metric_changed: 'compare_periods',
  trend_direction: 'trend',
  anomaly_present: 'anomaly',
} as const;

/**
 * Checks a plan against the user's (policy-filtered) catalog and the budget, without running
 * anything. Returns every problem with a stable code, so the planner can correct the plan.
 */
export function validatePlan(
  plan: AnalysisPlan,
  catalog: Catalog,
  budget: PlanBudget = DEFAULT_BUDGET,
): PlanError[] {
  const errors: PlanError[] = [];
  const err = (code: PlanError['code'], path: string, message: string) =>
    errors.push({ code, path, message });
  const metrics = new Map(catalog.metrics.map((m) => [m.key, m]));
  const dimensions = new Map(catalog.dimensions.map((d) => [d.key, d]));
  const steps = new Map<string, { step: PlanStep; index: number }>();

  if (!metrics.has(plan.primaryMetric)) {
    err('UNKNOWN_METRIC', 'primaryMetric', `Unknown metric "${plan.primaryMetric}"`);
  }
  checkText(plan.goal, 'goal', err);
  if (plan.steps.length > budget.maxSteps) {
    err('BUDGET_EXCEEDED', 'steps', `At most ${budget.maxSteps} steps`);
  }

  plan.steps.forEach((step, index) => {
    const path = `steps.${index}`;
    if (steps.has(step.id)) err('DUPLICATE_STEP', `${path}.id`, `Step id ${step.id} is used twice`);
    steps.set(step.id, { step, index });
    checkText(step.purpose, `${path}.purpose`, err);

    const metricKeys = 'metrics' in step ? step.metrics : [step.metric];
    for (const key of metricKeys) {
      if (!metrics.has(key)) err('UNKNOWN_METRIC', `${path}.metrics`, `Unknown metric "${key}"`);
    }
    const dimension = 'dimension' in step ? step.dimension : undefined;
    if (dimension !== undefined) {
      const d = dimensions.get(dimension);
      if (!d) err('UNKNOWN_MEMBER', `${path}.dimension`, `Unknown dimension "${dimension}"`);
      else if (d.type === 'TIME') {
        err('UNKNOWN_MEMBER', `${path}.dimension`, `"${dimension}" is a time dimension`);
      }
    }
    for (const [i, f] of (step.filters ?? []).entries()) {
      if (!dimensions.has(f.member)) {
        err('UNKNOWN_MEMBER', `${path}.filters.${i}`, `Unknown dimension "${f.member}"`);
      }
    }

    // Periods need the metrics' time dimension, at a granularity it allows.
    const period = periodOf(step);
    const known = metricKeys.map((k) => metrics.get(k)).filter((m) => m !== undefined);
    if (period || step.tool === 'trend' || step.tool === 'anomaly') {
      for (const m of known) {
        if (!m.timeDimension) {
          err('TIME_DIMENSION_REQUIRED', path, `Metric "${m.key}" has no time dimension`);
          continue;
        }
        if ('granularity' in step) {
          const allowed = dimensions.get(m.timeDimension)?.granularities ?? [];
          if (allowed.length > 0 && !allowed.includes(step.granularity)) {
            err(
              'GRANULARITY_NOT_ALLOWED',
              `${path}.granularity`,
              `${step.granularity} not allowed`,
            );
          }
        }
      }
    }
    for (const range of [period, 'baseline' in step ? step.baseline : undefined]) {
      if (range && typeof range === 'object' && 'from' in range) {
        const days = spanDays(range);
        const max =
          'granularity' in step && step.granularity === 'day' ? MAX_DAILY_POINTS : MAX_RANGE_DAYS;
        if (days > max) err('BUDGET_EXCEEDED', path, `The period spans ${days} days (max ${max})`);
      }
    }

    if (step.tool === 'contribution') {
      const m = metrics.get(step.metric);
      const partsAdditive =
        m?.ratio &&
        metrics.get(m.ratio.numerator)?.additive === true &&
        metrics.get(m.ratio.denominator)?.additive === true;
      if (m && !m.additive && !partsAdditive) {
        err(
          'NOT_ADDITIVE',
          `${path}.metric`,
          `"${step.metric}" cannot be split into contributions`,
        );
      }
    }

    if ('scope' in step && step.scope) {
      const ref = steps.get(step.scope.fromStep);
      if (!ref || ref.index >= index) {
        err(
          'UNKNOWN_STEP',
          `${path}.scope.fromStep`,
          `Step ${step.scope.fromStep} must come earlier`,
        );
      } else if (
        ref.step.tool !== PICKS_FROM[step.scope.pick] ||
        (ref.step.tool === 'anomaly' && !ref.step.dimension)
      ) {
        err(
          'SCOPE_NOT_SUPPORTED',
          `${path}.scope`,
          `${step.scope.pick} needs a ${PICKS_FROM[step.scope.pick]} step by a dimension`,
        );
      }
    }
  });

  const queries = plan.steps.reduce((n, s) => n + estimatedQueries(s, catalog), 0);
  if (queries > budget.maxQueries) {
    err('BUDGET_EXCEEDED', 'steps', `About ${queries} queries (max ${budget.maxQueries})`);
  }

  plan.hypotheses.forEach((h, i) => {
    checkText(h.statement, `hypotheses.${i}.statement`, err);
    const ref = steps.get(h.expectation.stepId);
    if (!ref || ref.step.tool !== HYPOTHESIS_TOOL[h.expectation.kind]) {
      err(
        'HYPOTHESIS_UNTESTABLE',
        `hypotheses.${i}`,
        `${h.expectation.kind} needs a ${HYPOTHESIS_TOOL[h.expectation.kind]} step`,
      );
    }
  });
  return errors;
}

function checkText(
  text: string,
  path: string,
  err: (code: PlanError['code'], path: string, message: string) => void,
) {
  const withoutDates = text.replace(ISO_DATE, '');
  if (DIGIT.test(withoutDates) || LINK.test(withoutDates)) {
    err('TEXT_NOT_ALLOWED', path, 'Write descriptions without figures or links');
  }
}

function periodOf(step: PlanStep): DateRange | undefined {
  if ('current' in step) return step.current;
  if ('period' in step) return step.period;
  return undefined;
}

function spanDays(range: { from: string; to: string }): number {
  return Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
}

/** Queries a step will run (see AnalysisToolsService). */
export function estimatedQueries(step: PlanStep, catalog: Catalog): number {
  const twoPeriods = 'baseline' in step && typeof step.baseline !== 'string';
  switch (step.tool) {
    case 'compare_periods':
      return twoPeriods ? 2 : 1;
    case 'contribution': {
      const ratio = catalog.metrics.find((m) => m.key === step.metric)?.ratio;
      if (ratio) return twoPeriods ? 2 : 1;
      return twoPeriods ? 4 : 2;
    }
    default:
      return 1;
  }
}

/** A query that exercises the members, filters and period of a step (compiled, not run). */
export function probeQuery(model: string, step: PlanStep): SemanticQueryParsed {
  const metrics = 'metrics' in step ? step.metrics : [step.metric];
  const dimension = 'dimension' in step && step.dimension ? [step.dimension] : [];
  const period = periodOf(step);
  return {
    model,
    metrics,
    measures: [],
    dimensions: dimension,
    filters: step.filters ?? [],
    orderBy: [],
    limit: 1,
    ...(period || 'granularity' in step
      ? {
          timeDimension: {
            ...(period ? { dateRange: period } : {}),
            ...('granularity' in step ? { granularity: step.granularity } : {}),
          },
        }
      : {}),
  };
}

/** The tool input of a step, with members picked from earlier results already resolved. */
export function toolInput(
  model: string,
  step: PlanStep,
  scopeFilter?: { member: string; values: string[] },
): ToolInput {
  const filters = [
    ...((step.filters ?? []) as SemanticQueryParsed['filters']),
    ...(scopeFilter
      ? [{ member: scopeFilter.member, op: 'in' as const, values: scopeFilter.values }]
      : []),
  ];
  const base = { model, filters };
  switch (step.tool) {
    case 'metric_snapshot':
      return {
        ...base,
        tool: step.tool,
        metrics: step.metrics,
        ...(step.period ? { period: step.period } : {}),
      };
    case 'compare_periods':
      return {
        ...base,
        tool: step.tool,
        metrics: step.metrics,
        current: step.current,
        baseline: step.baseline,
      };
    case 'contribution':
      return {
        ...base,
        tool: step.tool,
        metric: step.metric,
        dimension: step.dimension,
        current: step.current,
        baseline: step.baseline,
      };
    case 'trend':
      return {
        ...base,
        tool: step.tool,
        metrics: step.metrics,
        granularity: step.granularity,
        period: step.period,
      };
    case 'distribution':
      return {
        ...base,
        tool: step.tool,
        metric: step.metric,
        dimension: step.dimension,
        ...(step.period ? { period: step.period } : {}),
      };
    case 'anomaly':
      return {
        ...base,
        tool: step.tool,
        metric: step.metric,
        granularity: step.granularity,
        period: step.period,
        ...(step.dimension ? { dimension: step.dimension } : {}),
      };
  }
}
