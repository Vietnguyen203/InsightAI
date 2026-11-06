import { type AnalysisPlan, analysisPlanSchema, type Catalog } from '@insightai/contracts';
import { describe, expect, it } from 'vitest';
import { pickMembers } from './orchestrator.service';
import { estimatedQueries, probeQuery, toolInput, validatePlan } from './plan-validator';

const metric = (key: string, extra: Partial<Catalog['metrics'][number]> = {}) => ({
  key,
  label: key,
  businessDefinition: null,
  unit: null,
  format: 'number' as const,
  type: 'SIMPLE' as const,
  version: 1,
  timeDimension: 'order.order_date',
  synonyms: [],
  additive: true,
  ratio: null,
  ...extra,
});

const catalog: Catalog = {
  model: { key: 'sales', name: 'Sales', revision: 3 },
  metrics: [
    metric('revenue'),
    metric('orders'),
    metric('aov', {
      type: 'RATIO',
      additive: false,
      ratio: { numerator: 'revenue', denominator: 'orders' },
    }),
    metric('buyers', { additive: false }),
    metric('stock', { timeDimension: null }),
  ],
  dimensions: [
    {
      key: 'order.order_date',
      name: 'Date',
      description: null,
      type: 'TIME',
      granularities: ['day', 'week', 'month'],
      synonyms: [],
    },
    {
      key: 'customer.region',
      name: 'Region',
      description: null,
      type: 'CATEGORICAL',
      granularities: [],
      synonyms: [],
    },
    {
      key: 'order.channel',
      name: 'Channel',
      description: null,
      type: 'CATEGORICAL',
      granularities: [],
      synonyms: [],
    },
  ],
};

const oct = { from: '2026-10-01', to: '2026-10-31' };
const base = (): AnalysisPlan =>
  analysisPlanSchema.parse({
    version: 1,
    goal: 'Why did revenue drop last month',
    primaryMetric: 'revenue',
    hypotheses: [
      {
        id: 'h1',
        statement: 'The North region drives the drop',
        expectation: {
          kind: 'member_drives_change',
          stepId: 's2',
          member: 'North',
          direction: 'down',
        },
      },
    ],
    steps: [
      {
        id: 's1',
        tool: 'compare_periods',
        purpose: 'Overall change',
        metrics: ['revenue'],
        current: { preset: 'last_month' },
        baseline: 'previous_period',
      },
      {
        id: 's2',
        tool: 'contribution',
        purpose: 'Which regions',
        metric: 'revenue',
        dimension: 'customer.region',
        current: { preset: 'last_month' },
        baseline: 'previous_period',
      },
      {
        id: 's3',
        tool: 'trend',
        purpose: 'Daily trend of the main regions',
        metrics: ['revenue'],
        granularity: 'day',
        period: { preset: 'last_month' },
        scope: { fromStep: 's2', pick: 'top_decliners', k: 2 },
      },
      {
        id: 's4',
        tool: 'anomaly',
        purpose: 'Unusual days',
        metric: 'revenue',
        granularity: 'day',
        period: oct,
        dimension: 'customer.region',
      },
    ],
  });

const codes = (plan: AnalysisPlan) => validatePlan(plan, catalog).map((e) => `${e.code}@${e.path}`);
const withStep = (patch: (plan: AnalysisPlan) => void) => {
  const plan = base();
  patch(plan);
  return codes(plan);
};

describe('validatePlan', () => {
  it('accepts a well-formed plan', () => {
    expect(codes(base())).toEqual([]);
  });

  it.each([
    [
      'unknown primary metric',
      (p: AnalysisPlan) => (p.primaryMetric = 'profit'),
      'UNKNOWN_METRIC@primaryMetric',
    ],
    [
      'unknown step metric',
      (p: AnalysisPlan) => ((p.steps[0] as { metrics: string[] }).metrics = ['profit']),
      'UNKNOWN_METRIC@steps.0.metrics',
    ],
    [
      'unknown dimension',
      (p: AnalysisPlan) => ((p.steps[1] as { dimension: string }).dimension = 'customer.city'),
      'UNKNOWN_MEMBER@steps.1.dimension',
    ],
    [
      'time dimension as breakdown',
      (p: AnalysisPlan) => ((p.steps[1] as { dimension: string }).dimension = 'order.order_date'),
      'UNKNOWN_MEMBER@steps.1.dimension',
    ],
    [
      'unknown filter member',
      (p: AnalysisPlan) => (p.steps[0]!.filters = [{ member: 'x.y', op: 'eq', values: ['a'] }]),
      'UNKNOWN_MEMBER@steps.0.filters.0',
    ],
    [
      'duplicate step id',
      (p: AnalysisPlan) => (p.steps[1]!.id = 's1'),
      'DUPLICATE_STEP@steps.1.id',
    ],
    [
      'non-additive contribution',
      (p: AnalysisPlan) => ((p.steps[1] as { metric: string }).metric = 'buyers'),
      'NOT_ADDITIVE@steps.1.metric',
    ],
    [
      'metric without time dimension',
      (p: AnalysisPlan) => ((p.steps[0] as { metrics: string[] }).metrics = ['stock']),
      'TIME_DIMENSION_REQUIRED@steps.0',
    ],
    [
      'granularity not allowed',
      (p: AnalysisPlan) => ((p.steps[2] as { granularity: string }).granularity = 'quarter'),
      'GRANULARITY_NOT_ALLOWED@steps.2.granularity',
    ],
    [
      'scope from a later step',
      (p: AnalysisPlan) => ((p.steps[2] as { scope: { fromStep: string } }).scope.fromStep = 's4'),
      'UNKNOWN_STEP@steps.2.scope.fromStep',
    ],
    [
      'scope from a missing step',
      (p: AnalysisPlan) => ((p.steps[2] as { scope: { fromStep: string } }).scope.fromStep = 's9'),
      'UNKNOWN_STEP@steps.2.scope.fromStep',
    ],
    [
      'scope pick of the wrong tool',
      (p: AnalysisPlan) =>
        ((p.steps[2] as { scope: { pick: string } }).scope.pick = 'anomalous_members'),
      'SCOPE_NOT_SUPPORTED@steps.2.scope',
    ],
    [
      'hypothesis on the wrong tool',
      (p: AnalysisPlan) => (p.hypotheses[0]!.expectation.stepId = 's1'),
      'HYPOTHESIS_UNTESTABLE@hypotheses.0',
    ],
    [
      'hypothesis on a missing step',
      (p: AnalysisPlan) => (p.hypotheses[0]!.expectation.stepId = 's9'),
      'HYPOTHESIS_UNTESTABLE@hypotheses.0',
    ],
    [
      'figures in the goal',
      (p: AnalysisPlan) => (p.goal = 'Revenue fell by 12 percent'),
      'TEXT_NOT_ALLOWED@goal',
    ],
    [
      'full-width figures in a purpose',
      (p: AnalysisPlan) => (p.steps[0]!.purpose = 'Down １２'),
      'TEXT_NOT_ALLOWED@steps.0.purpose',
    ],
    [
      'a link in a statement',
      (p: AnalysisPlan) => (p.hypotheses[0]!.statement = 'See evil.com'),
      'TEXT_NOT_ALLOWED@hypotheses.0.statement',
    ],
    [
      'too long a period',
      (p: AnalysisPlan) =>
        ((p.steps[0] as { current: unknown }).current = { from: '2020-01-01', to: '2026-01-01' }),
      'BUDGET_EXCEEDED@steps.0',
    ],
    [
      'too many days at daily granularity',
      (p: AnalysisPlan) =>
        ((p.steps[3] as { period: unknown }).period = { from: '2025-01-01', to: '2026-06-30' }),
      'BUDGET_EXCEEDED@steps.3',
    ],
  ])('rejects %s', (_name, patch, expected) => {
    expect(withStep(patch)).toContain(expected);
  });

  it('allows ISO dates in descriptions', () => {
    expect(withStep((p) => (p.steps[0]!.purpose = 'Compare 2026-10-01 with 2026-09-01'))).toEqual(
      [],
    );
  });

  it('accepts ratio metrics with additive parts for contribution', () => {
    expect(withStep((p) => ((p.steps[1] as { metric: string }).metric = 'aov'))).toEqual([]);
  });

  it('checks the step and query budgets', () => {
    const plan = base();
    expect(validatePlan(plan, catalog, { maxSteps: 3, maxQueries: 30 }).map((e) => e.code)).toEqual(
      ['BUDGET_EXCEEDED'],
    );
    expect(
      validatePlan(plan, catalog, { maxSteps: 12, maxQueries: 4 }).map((e) => e.message),
    ).toEqual(['About 5 queries (max 4)']);
  });

  it('rejects anything but the Plan IR shape', () => {
    const plan = base() as unknown as Record<string, unknown>;
    expect(analysisPlanSchema.safeParse({ ...plan, sql: 'DROP TABLE x' }).success).toBe(false);
    const step = { ...(plan.steps as object[])[0], expr: 'revenue * 2' };
    expect(analysisPlanSchema.safeParse({ ...plan, steps: [step] }).success).toBe(false);
    expect(analysisPlanSchema.safeParse({ ...plan, steps: [] }).success).toBe(false);
    expect(
      analysisPlanSchema.safeParse({
        ...plan,
        steps: Array.from({ length: 13 }, (_, i) => ({
          ...(plan.steps as object[])[0],
          id: `s${i + 1}`,
        })),
      }).success,
    ).toBe(false);
  });
});

describe('estimatedQueries and tool inputs', () => {
  it.each([
    [0, 1],
    [1, 2],
    [2, 1],
    [3, 1],
  ])('step %i runs about %i queries', (index, expected) => {
    expect(estimatedQueries(base().steps[index]!, catalog)).toBe(expected);
  });

  it('counts explicit baselines and ratio contributions', () => {
    const plan = base();
    const contribution = plan.steps[1] as { baseline: unknown; metric: string };
    contribution.baseline = { from: '2026-09-01', to: '2026-09-30' };
    expect(estimatedQueries(plan.steps[1]!, catalog)).toBe(4);
    contribution.metric = 'aov';
    expect(estimatedQueries(plan.steps[1]!, catalog)).toBe(2);
  });

  it('builds probe queries and tool inputs with resolved scopes', () => {
    const plan = base();
    expect(probeQuery('sales', plan.steps[3]!)).toMatchObject({
      metrics: ['revenue'],
      dimensions: ['customer.region'],
      timeDimension: { dateRange: oct, granularity: 'day' },
      limit: 1,
    });
    expect(
      toolInput('sales', plan.steps[2]!, { member: 'customer.region', values: ['North'] }),
    ).toMatchObject({
      tool: 'trend',
      filters: [{ member: 'customer.region', op: 'in', values: ['North'] }],
    });
  });
});

describe('pickMembers', () => {
  const contribution = {
    tool: 'contribution' as const,
    kind: 'additive' as const,
    contribution: {
      totalCurrent: '0',
      totalBaseline: '0',
      totalDelta: '0',
      top: [],
      others: null,
      limitations: [],
      members: [
        { member: 'North', current: '1', baseline: '9', delta: '-8', share: null },
        { member: 'South', current: '5', baseline: '1', delta: '4', share: null },
        { member: null, current: '0', baseline: '3', delta: '-3', share: null },
        { member: 'West', current: '2', baseline: '3', delta: '-1', share: null },
      ],
    },
  };

  it('picks contributors and decliners, never the empty member', () => {
    expect(pickMembers(contribution, 'top_decliners', 5)).toEqual(['North', 'West']);
    expect(pickMembers(contribution, 'top_contributors', 1)).toEqual(['South']);
    expect(pickMembers(contribution, 'anomalous_members', 3)).toEqual([]);
    expect(pickMembers(null, 'top_decliners', 3)).toEqual([]);
  });

  it('picks members with anomalies', () => {
    const report = (member: string | null, n: number) => ({
      member,
      points: 30,
      median: 1,
      mad: 1,
      limitations: [],
      anomalies: Array.from({ length: n }, () => ({
        period: '2026-10-01',
        value: '9',
        z: 4,
        direction: 'high' as const,
      })),
    });
    expect(
      pickMembers(
        { tool: 'anomaly', reports: [report('A', 0), report('B', 2), report('C', 1)] },
        'anomalous_members',
        5,
      ),
    ).toEqual(['B', 'C']);
  });
});
