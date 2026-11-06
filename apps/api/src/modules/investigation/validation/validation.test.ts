import type { Hypothesis } from '@insightai/contracts';
import { describe, expect, it } from 'vitest';
import type { ToolOutput } from '../analysis-tools.service';
import { detectAnomalies } from '../analysis/anomaly';
import { compareValues } from '../analysis/comparison';
import { contribution, ratioDecomposition } from '../analysis/contribution';
import { distribution } from '../analysis/distribution';
import { trend } from '../analysis/trend';
import { evidenceValues, outputLimitations } from './evidence-values';
import { deriveFindings } from './findings';
import { evaluateHypothesis } from './hypothesis-rules';

const hyp = (
  expectation: Partial<Hypothesis['expectation']> & { kind: Hypothesis['expectation']['kind'] },
): Hypothesis => ({
  id: 'h1',
  statement: 'x',
  expectation: { stepId: 's1', ...expectation },
});

const additive = (
  rows: { member: string; current: string; baseline: string }[],
  limitations: string[] = [],
): ToolOutput => {
  const c = contribution(rows);
  return {
    tool: 'contribution',
    kind: 'additive',
    contribution: { ...c, limitations: [...c.limitations, ...limitations] as typeof c.limitations },
  };
};
const compare = (current: string | null, baseline: string | null): ToolOutput => ({
  tool: 'compare_periods',
  comparisons: [compareValues('revenue', current, baseline)],
});
const months = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'];
const trendOf = (values: string[]): ToolOutput => ({
  tool: 'trend',
  trends: [
    trend(
      values.map((value, i) => ({ period: months[i]!, value })),
      'month',
      { metric: 'revenue' },
    ),
  ],
});
const daily = (values: number[]) =>
  values.map((v, i) => ({ period: `2026-01-${String(i + 1).padStart(2, '0')}`, value: String(v) }));
const noise = [100, 102, 98, 101, 99, 103, 97, 100, 102, 98, 101, 99, 100, 101, 99, 100];
const anomalyOf = (series: Record<string, number[]>): ToolOutput => ({
  tool: 'anomaly',
  reports: Object.entries(series).map(([member, values]) =>
    detectAnomalies(daily(values), { member }),
  ),
});

const drop = additive([
  { member: 'North', current: '50', baseline: '120' },
  { member: 'South', current: '195', baseline: '200' },
  { member: 'Central', current: '40', baseline: '45' },
]);

describe('member_drives_change', () => {
  it.each([
    [
      'the named driver',
      { member: 'north', direction: 'down' as const },
      'SUPPORTED',
      'MEMBER_SHARE_ABOVE',
    ],
    ['the largest driver when none is named', {}, 'SUPPORTED', 'MEMBER_SHARE_ABOVE'],
    ['a minor member', { member: 'South' }, 'NOT_SUPPORTED', 'MEMBER_SHARE_BELOW'],
    [
      'the wrong direction',
      { member: 'North', direction: 'up' as const },
      'NOT_SUPPORTED',
      'DIRECTION_DIFFERS',
    ],
    ['an absent member', { member: 'West' }, 'NOT_SUPPORTED', 'MEMBER_ABSENT'],
  ])('%s', (_name, expectation, status, reason) => {
    const r = evaluateHypothesis(hyp({ kind: 'member_drives_change', ...expectation }), drop);
    expect([r.status, r.rule.reason]).toEqual([status, reason]);
  });

  it('records what it observed and the thresholds it used', () => {
    const r = evaluateHypothesis(hyp({ kind: 'member_drives_change', member: 'North' }), drop);
    expect(r.rule).toMatchObject({
      name: 'member_drives_change',
      thresholds: { memberShare: 0.4, minTotalChange: 0.01 },
      observed: { member: 'North', share: 0.875, totalDelta: -80, members: 3 },
    });
  });

  it.each([
    [
      'no change',
      additive([
        { member: 'A', current: '5', baseline: '5' },
        { member: 'B', current: '1', baseline: '1' },
      ]),
      'NO_CHANGE',
    ],
    [
      'a tiny change',
      additive([
        { member: 'A', current: '1000', baseline: '1001' },
        { member: 'B', current: '5', baseline: '5' },
      ]),
      'CHANGE_TOO_SMALL',
    ],
    [
      'a single member',
      additive([{ member: 'A', current: '5', baseline: '1' }]),
      'TOO_FEW_MEMBERS',
    ],
    [
      'a member hidden by a policy',
      additive(
        [
          { member: 'A', current: '5', baseline: '1' },
          { member: 'B', current: '1', baseline: '2' },
        ],
        ['POLICY_FILTERED'],
      ),
      'MEMBER_NOT_VISIBLE',
    ],
  ])('is inconclusive with %s', (_name, output, reason) => {
    const r = evaluateHypothesis(hyp({ kind: 'member_drives_change', member: 'Z' }), output);
    expect([r.status, r.rule.reason]).toEqual(['INCONCLUSIVE', reason]);
  });

  it('works on ratio decompositions', () => {
    const d = ratioDecomposition([
      {
        member: 'North',
        numerator: { current: '200', baseline: '100' },
        denominator: { current: '10', baseline: '10' },
      },
      {
        member: 'South',
        numerator: { current: '100', baseline: '100' },
        denominator: { current: '10', baseline: '10' },
      },
    ]);
    const r = evaluateHypothesis(
      hyp({ kind: 'member_drives_change', member: 'North', direction: 'up' }),
      {
        tool: 'contribution',
        kind: 'ratio',
        decomposition: d,
      },
    );
    expect(r.status).toBe('SUPPORTED');
  });
});

describe('metric_changed', () => {
  it.each([
    ['80', '100', 'down', 'SUPPORTED', 'CHANGE_ABOVE'],
    ['130', '100', undefined, 'SUPPORTED', 'CHANGE_ABOVE'],
    ['130', '100', 'down', 'NOT_SUPPORTED', 'DIRECTION_DIFFERS'],
    ['101', '100', 'up', 'NOT_SUPPORTED', 'CHANGE_BELOW'],
    ['5', '0', 'up', 'INCONCLUSIVE', 'ZERO_BASELINE'],
    [null, '100', 'down', 'INCONCLUSIVE', 'NO_DATA'],
  ] as const)('%s vs %s expecting %s', (current, baseline, direction, status, reason) => {
    const r = evaluateHypothesis(
      hyp({ kind: 'metric_changed', ...(direction ? { direction } : {}) }),
      compare(current, baseline),
    );
    expect([r.status, r.rule.reason]).toEqual([status, reason]);
  });
});

describe('trend_direction', () => {
  it.each([
    [['100', '110', '120', '130', '140', '150'], 'up', 'SUPPORTED', 'TREND_FITS'],
    [['100', '110', '120', '130', '140', '150'], 'down', 'NOT_SUPPORTED', 'DIRECTION_DIFFERS'],
    [['100', '100.5', '100', '100.5', '100', '100.5'], undefined, 'NOT_SUPPORTED', 'FLAT'],
    [['100', '160', '90', '170', '95', '180'], 'up', 'INCONCLUSIVE', 'WEAK_FIT'],
    [['100', '110', '120'], 'up', 'INCONCLUSIVE', 'TOO_FEW_POINTS'],
  ] as const)('%j expecting %s', (values, direction, status, reason) => {
    const r = evaluateHypothesis(
      hyp({ kind: 'trend_direction', ...(direction ? { direction } : {}) }),
      trendOf([...values]),
    );
    expect([r.status, r.rule.reason]).toEqual([status, reason]);
  });
});

describe('anomaly_present', () => {
  const spiked = [...noise];
  spiked[7] = 400;

  it.each([
    [{ North: spiked, South: noise }, 'North', 'SUPPORTED', 'ANOMALY_FOUND'],
    [{ North: spiked, South: noise }, undefined, 'SUPPORTED', 'ANOMALY_FOUND'],
    [{ North: spiked, South: noise }, 'South', 'NOT_SUPPORTED', 'NO_ANOMALY'],
    [{ North: noise.slice(0, 10) }, 'North', 'INCONCLUSIVE', 'TOO_FEW_POINTS'],
  ] as const)('series %#, member %s', (series, member, status, reason) => {
    const r = evaluateHypothesis(
      hyp({ kind: 'anomaly_present', ...(member ? { member } : {}) }),
      anomalyOf(series),
    );
    expect([r.status, r.rule.reason]).toEqual([status, reason]);
  });
});

describe('untested hypotheses', () => {
  it('when the step did not run or is of another kind', () => {
    expect(evaluateHypothesis(hyp({ kind: 'metric_changed' }), null).rule.reason).toBe(
      'STEP_NOT_RUN',
    );
    const r = evaluateHypothesis(hyp({ kind: 'trend_direction' }), compare('1', '2'));
    expect([r.status, r.rule.reason]).toEqual(['UNTESTED', 'WRONG_STEP']);
  });
});

describe('findings', () => {
  it('names the main driver of a change, tied to its evidence', () => {
    const [f] = deriveFindings(drop, 'ev-1', []);
    expect(f).toMatchObject({
      kind: 'driver',
      templateKey: 'driver.same_direction',
      params: {
        evidenceId: 'ev-1',
        member: 'North',
        delta: '-70',
        share: 0.875,
        totalDelta: '-80',
      },
      evidenceIds: ['ev-1'],
      verified: true,
      importance: 0.875,
    });
  });

  it('weakens findings on unreliable evidence and marks missing data as unverified', () => {
    expect(deriveFindings(drop, 'ev', ['TRUNCATED'])[0]!.importance).toBe(0.4375);
    const empty = deriveFindings(compare(null, '1'), 'ev', ['NO_DATA']);
    expect(empty).toEqual([]);
    const snapshot = deriveFindings(
      {
        tool: 'metric_snapshot',
        result: {
          columns: [],
          rows: [],
          truncated: false,
          dateRange: null,
          compareRange: null,
          metrics: [],
          modelRevision: 1,
          queryHistoryId: null,
          cached: false,
          policiesApplied: [],
        },
      },
      'ev',
      ['NO_DATA'],
    );
    expect(snapshot[0]).toMatchObject({ verified: false });
  });

  it.each([
    [compare('80', '100'), 'metric_change.down'],
    [trendOf(['100', '110', '120', '130', '140', '150']), 'trend.up'],
    [
      {
        tool: 'distribution' as const,
        distribution: distribution([
          { member: 'A', value: '90' },
          { member: 'B', value: '10' },
        ]),
      },
      'concentration.high',
    ],
    [
      anomalyOf({
        North: (() => {
          const s = [...noise];
          s[3] = 10;
          return s;
        })(),
      }),
      'anomaly.low',
    ],
  ])('derives %#: %s', (output, templateKey) => {
    expect(deriveFindings(output, 'ev', [])[0]!.templateKey).toBe(templateKey);
  });

  it('calls a trend with a weak fit unclear, whatever its slope, and ranks it low', () => {
    const [weak] = deriveFindings(trendOf(['100', '160', '90', '170', '95', '180']), 'ev', []);
    expect(weak).toMatchObject({ kind: 'trend', templateKey: 'trend.unclear', importance: 0.1 });
    expect(weak!.params.r2).toBeLessThan(0.5);
  });
});

describe('evidence values', () => {
  it('keeps exact figures and names members as values', () => {
    expect(evidenceValues(drop)).toMatchObject({
      'total.delta': '-80',
      'top.0.member': 'North',
      'top.0.delta': '-70',
      'top.0.share': 0.875,
      members: 3,
    });
    expect(evidenceValues(compare('80', '100'))).toMatchObject({
      'revenue.delta': '-20',
      'revenue.deltaRatio': -0.2,
    });
    expect(outputLimitations(compare('5', '0'))).toEqual(['ZERO_BASELINE']);
  });
});
