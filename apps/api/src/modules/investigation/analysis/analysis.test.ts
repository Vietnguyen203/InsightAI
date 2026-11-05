import type { QueryColumn, SemanticQueryResult } from '@insightai/contracts';
import { describe, expect, it } from 'vitest';
import { anomaliesFromResult, detectAnomalies } from './anomaly';
import {
  compareValues,
  comparisonsFromCompareResult,
  comparisonsFromTwoResults,
} from './comparison';
import {
  contribution,
  membersFromCompareResult,
  membersFromTwoResults,
  ratioDecomposition,
} from './contribution';
import { add, cmp, dec, ratio, sub, sum, toString } from './decimal';
import { distribution, distributionFromResult, gini } from './distribution';
import { isPartial, missingPeriods, nextPeriod } from './periods';
import { AnalysisInputError, columnIndex, timeIndex } from './result';
import { trend, trendFromResult } from './trend';

// ─── Helpers ────────────────────────────────────────────────────────────────

const col = (key: string, extra: Partial<QueryColumn> = {}): QueryColumn => ({
  key,
  name: key,
  kind: 'metric',
  granularity: null,
  type: 'DECIMAL',
  comparison: false,
  unit: null,
  format: null,
  ...extra,
});
const result = (
  columns: QueryColumn[],
  rows: (string | null)[][],
  extra: Partial<SemanticQueryResult> = {},
): SemanticQueryResult => ({
  columns,
  rows,
  truncated: false,
  dateRange: null,
  compareRange: null,
  metrics: [],
  modelRevision: 1,
  queryHistoryId: null,
  cached: false,
  policiesApplied: [],
  ...extra,
});
const region = col('customer.region', { kind: 'dimension', type: 'TEXT' });
const day = col('order.order_date', { kind: 'time', type: 'DATE', granularity: 'day' });
const revenue = col('revenue');
const revenuePrev = col('revenue', { comparison: true });

/** Deterministic pseudo-random numbers for property tests. */
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}
const days = (n: number, start = '2026-01-01') => {
  const out: string[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    out.push(p);
    p = nextPeriod(p, 'day');
  }
  return out;
};

// ─── decimal ────────────────────────────────────────────────────────────────

describe('decimal', () => {
  it.each([
    ['1', '1'],
    ['-0.50', '-0.5'],
    ['+3.20', '3.2'],
    ['00012.300', '12.3'],
    ['0.000', '0'],
    ['-0.05', '-0.05'],
  ])('parses and prints %s as %s', (input, output) => {
    expect(toString(dec(input))).toBe(output);
  });

  it.each(['', 'abc', '1e5', '1.2.3', '1,5'])('rejects %j', (input) => {
    expect(() => dec(input)).toThrow(RangeError);
  });

  it('adds and subtracts exactly, also beyond float precision', () => {
    expect(toString(add(dec('0.1'), dec('0.2')))).toBe('0.3');
    expect(toString(sub(dec('9007199254740993.01'), dec('0.01')))).toBe('9007199254740993');
    expect(toString(sum(['1.25', '-0.25', '3'].map(dec)))).toBe('4');
  });

  it('compares and divides', () => {
    expect(cmp(dec('2.50'), dec('2.5'))).toBe(0);
    expect(cmp(dec('-1'), dec('0.1'))).toBe(-1);
    expect(ratio(dec('1'), dec('4'))).toBe(0.25);
    expect(ratio(dec('1'), dec('0.00'))).toBeNull();
  });
});

// ─── comparison ─────────────────────────────────────────────────────────────

describe('comparison', () => {
  it.each([
    ['150', '100', '50', 0.5, 'up'],
    ['80', '100', '-20', -0.2, 'down'],
    ['100.0', '100', '0', 0, 'flat'],
    ['-50', '-100', '50', 0.5, 'up'],
    ['0.3', '0.1', '0.2', 2, 'up'],
    ['1234567.89', '1234567.90', '-0.01', -0, 'down'],
    ['0', '50', '-50', -1, 'down'],
  ] as const)('%s vs %s', (current, baseline, delta, deltaRatio, direction) => {
    expect(compareValues('revenue', current, baseline)).toMatchObject({
      delta,
      deltaRatio,
      direction,
      limitations: [],
    });
  });

  it('reports a zero baseline and missing values', () => {
    expect(compareValues('m', '5', '0')).toMatchObject({
      delta: '5',
      deltaRatio: null,
      limitations: ['ZERO_BASELINE'],
    });
    expect(compareValues('m', null, '1')).toMatchObject({ delta: null, limitations: ['NO_DATA'] });
  });

  it('reads compareTo results and two-period results', () => {
    const r = result([revenue, revenuePrev], [['300', '200']], {
      policiesApplied: ['North only'],
    });
    expect(comparisonsFromCompareResult(r, ['revenue'])[0]).toMatchObject({
      delta: '100',
      deltaRatio: 0.5,
      limitations: ['POLICY_FILTERED'],
    });
    const two = comparisonsFromTwoResults(
      result([revenue], [['10']]),
      result([revenue], [], { truncated: true }),
      ['revenue'],
    );
    expect(two[0]).toMatchObject({ delta: null });
    expect(two[0]!.limitations).toEqual(expect.arrayContaining(['TRUNCATED', 'NO_DATA']));
  });
});

// ─── contribution ───────────────────────────────────────────────────────────

describe('contribution', () => {
  const rows = [
    { member: 'North', current: '50', baseline: '120' },
    { member: 'South', current: '210', baseline: '200' },
    { member: 'Central', current: '40', baseline: '45' },
    { member: 'West', current: '1', baseline: '1' },
  ];

  it('splits the change exactly, largest change first', () => {
    const c = contribution(rows, { k: 2 });
    expect(c).toMatchObject({ totalCurrent: '301', totalBaseline: '366', totalDelta: '-65' });
    expect(c.members.map((m) => m.member)).toEqual(['North', 'South', 'Central', 'West']);
    expect(c.top.map((m) => [m.member, m.delta, m.share])).toEqual([
      ['North', '-70', 1.076923],
      ['South', '10', -0.153846],
    ]);
    expect(c.others).toEqual({
      count: 2,
      current: '41',
      baseline: '46',
      delta: '-5',
      share: 0.076923,
    });
  });

  it('always adds up to the total (property)', () => {
    const random = rng(7);
    for (let run = 0; run < 50; run++) {
      const members = Array.from({ length: 1 + Math.floor(random() * 12) }, (_, i) => ({
        member: `m${i}`,
        current: (Math.floor(random() * 1e8) / 100).toFixed(2),
        baseline: (Math.floor(random() * 1e8) / 100).toFixed(2),
      }));
      const c = contribution(members, { k: 3 });
      expect(toString(sum(c.members.map((m) => dec(m.delta))))).toBe(c.totalDelta);
      const parts = [...c.top.map((m) => m.delta), c.others?.delta ?? '0'];
      expect(toString(sum(parts.map(dec)))).toBe(c.totalDelta);
      if (c.totalDelta !== '0') {
        const shares = c.members.reduce((s, m) => s + (m.share ?? 0), 0);
        expect(shares).toBeCloseTo(1, 4);
      }
    }
  });

  it('reports no change, missing values and totals that do not match', () => {
    expect(contribution([{ member: 'a', current: '1', baseline: '1' }]).limitations).toEqual([
      'ZERO_TOTAL',
    ]);
    const c = contribution([{ member: 'a', current: null, baseline: '3' }], {
      reportedTotal: { current: '10', baseline: '3' },
    });
    expect(c.totalDelta).toBe('-3');
    expect(c.limitations).toEqual(['NULL_VALUES', 'TOTAL_MISMATCH']);
    expect(
      contribution(rows, { reportedTotal: { current: '301.00', baseline: '366' } }).limitations,
    ).toEqual([]);
    expect(contribution([]).limitations).toEqual(['ZERO_TOTAL', 'NO_DATA']);
  });

  it('reads grouped results', () => {
    const grouped = result(
      [region, revenue, revenuePrev],
      [
        ['North', '5', '7'],
        [null, '1', null],
      ],
    );
    expect(membersFromCompareResult(grouped, 'revenue', 'customer.region')).toEqual([
      { member: 'North', current: '5', baseline: '7' },
      { member: null, current: '1', baseline: null },
    ]);
    const joined = membersFromTwoResults(
      result(
        [region, revenue],
        [
          ['North', '5'],
          ['East', '2'],
        ],
      ),
      result(
        [region, revenue],
        [
          ['North', '7'],
          ['West', '3'],
        ],
      ),
      'revenue',
      'customer.region',
    );
    expect(joined).toEqual([
      { member: 'North', current: '5', baseline: '7' },
      { member: 'East', current: '2', baseline: null },
      { member: 'West', current: null, baseline: '3' },
    ]);
    expect(() => membersFromCompareResult(grouped, 'nope', 'customer.region')).toThrow(
      AnalysisInputError,
    );
  });
});

describe('ratio decomposition (mix / rate)', () => {
  const row = (member: string, n1: string, d1: string, n0: string, d0: string) => ({
    member,
    numerator: { current: n1, baseline: n0 },
    denominator: { current: d1, baseline: d0 },
  });

  it('explains a pure rate change', () => {
    // Same weights, North's average order value doubles.
    const r = ratioDecomposition([
      row('North', '200', '10', '100', '10'),
      row('South', '100', '10', '100', '10'),
    ]);
    expect(r).toMatchObject({
      ratioBaseline: 10,
      ratioCurrent: 15,
      delta: 5,
      mixEffect: 0,
      rateEffect: 5,
    });
    expect(r.members[0]).toMatchObject({ member: 'North', rateEffect: 5, mixEffect: 0 });
  });

  it('explains a pure mix change', () => {
    // Rates stay 10 and 20; orders shift towards the cheaper region.
    const r = ratioDecomposition([
      row('A', '300', '30', '100', '10'),
      row('B', '200', '10', '600', '30'),
    ]);
    expect(r.rateEffect).toBeCloseTo(0, 9);
    expect(r.mixEffect).toBeCloseTo(r.delta!, 9);
    expect(r.delta).toBeCloseTo(12.5 - 17.5, 9);
  });

  it('effects always add up to the change (property)', () => {
    const random = rng(11);
    for (let run = 0; run < 50; run++) {
      // Consistent data: no numerator without denominator (a member may be new).
      const rows = Array.from({ length: 2 + Math.floor(random() * 6) }, (_, i) => {
        const newMember = random() < 0.15;
        return row(
          `m${i}`,
          String(Math.floor(random() * 10000)),
          String(1 + Math.floor(random() * 300)),
          newMember ? '0' : String(Math.floor(random() * 10000)),
          newMember ? '0' : String(1 + Math.floor(random() * 300)),
        );
      });
      const r = ratioDecomposition(rows);
      expect(r.rateEffect + r.mixEffect).toBeCloseTo(r.delta!, 6);
      expect(r.residual).toBeCloseTo(0, 6);
      expect(r.limitations).not.toContain('TOTAL_MISMATCH');
      expect(r.members.reduce((s, m) => s + m.effect, 0)).toBeCloseTo(r.delta!, 6);
    }
  });

  it('handles members without a denominator and an empty baseline', () => {
    const r = ratioDecomposition([
      row('New', '50', '5', '0', '0'),
      row('Old', '100', '10', '100', '10'),
    ]);
    expect(r.members.find((m) => m.member === 'New')).toMatchObject({
      rateEffect: 0,
      rateBaseline: null,
    });
    // A numerator without denominator cannot be attributed: reported, not hidden.
    const odd = ratioDecomposition([
      row('A', '100', '10', '100', '10'),
      row('B', '50', '0', '0', '5'),
    ]);
    expect(odd.residual).not.toBe(0);
    expect(odd.limitations).toContain('TOTAL_MISMATCH');
    expect(ratioDecomposition([row('x', '1', '1', '0', '0')])).toMatchObject({
      delta: null,
      limitations: ['ZERO_BASELINE'],
    });
    expect(
      ratioDecomposition([
        {
          member: 'x',
          numerator: { current: null, baseline: '1' },
          denominator: { current: '1', baseline: '1' },
        },
      ]).limitations,
    ).toContain('NULL_VALUES');
  });
});

// ─── periods & trend ────────────────────────────────────────────────────────

describe('periods', () => {
  it.each([
    ['2026-01-31', 'day', '2026-02-01'],
    ['2026-02-23', 'week', '2026-03-02'],
    ['2026-01-01', 'month', '2026-02-01'],
    ['2026-10-01', 'quarter', '2027-01-01'],
    ['2026-01-01', 'year', '2027-01-01'],
  ] as const)('after %s (%s) comes %s', (start, g, next) => {
    expect(nextPeriod(start, g)).toBe(next);
  });

  it('finds missing buckets and the incomplete current one', () => {
    expect(missingPeriods(['2026-01-01', '2026-04-01', '2026-02-01'], 'month')).toEqual([
      '2026-03-01',
    ]);
    expect(missingPeriods(['2026-01-01'], 'month')).toEqual([]);
    expect(isPartial('2026-11-01', 'month', '2026-11-05')).toBe(true);
    expect(isPartial('2026-10-01', 'month', '2026-11-05')).toBe(false);
  });

  it.each([
    ['2026-11-05', 'day', '2026-11-05', true],
    ['2026-11-04', 'day', '2026-11-05', false],
    ['2026-11-02', 'week', '2026-11-08', true],
    ['2026-10-01', 'quarter', '2026-12-31', true],
    ['2026-01-01', 'year', '2027-01-01', false],
  ] as const)('bucket %s (%s) on %s is partial: %s', (start, g, today, partial) => {
    expect(isPartial(start, g, today)).toBe(partial);
  });
});

describe('trend', () => {
  const months = [
    '2026-01-01',
    '2026-02-01',
    '2026-03-01',
    '2026-04-01',
    '2026-05-01',
    '2026-06-01',
  ];
  const series = (values: (string | null)[]) =>
    values.map((value, i) => ({ period: months[i]!, value }));

  it('fits a perfect line', () => {
    const t = trend(series(['100', '110', '120', '130', '140', '150']), 'month');
    expect(t).toMatchObject({
      slope: 10,
      intercept: 100,
      r2: 1,
      direction: 'up',
      firstLastDelta: '50',
      firstLastRatio: 0.5,
      fitted: 6,
    });
  });

  it.each([
    [['150', '140', '130', '120', '110', '100'], 'down'],
    [['100', '100.5', '100', '100.5', '100', '100.5'], 'flat'],
  ] as const)('direction of %j is %s', (values, direction) => {
    expect(trend(series([...values]), 'month').direction).toBe(direction);
  });

  it('keeps calendar positions across gaps and reports them', () => {
    const t = trend(
      [
        { period: '2026-01-01', value: '10' },
        { period: '2026-02-01', value: '20' },
        { period: '2026-04-01', value: '40' },
        { period: '2026-05-01', value: '50' },
      ],
      'month',
    );
    expect(t.gaps).toEqual(['2026-03-01']);
    expect(t.limitations).toEqual(['GAPS']);
    expect(t.slope).toBe(10);
  });

  it('does not fit the incomplete current period', () => {
    const t = trend(series(['100', '110', '120', '130', '140', '5']), 'month', {
      today: '2026-06-03',
    });
    expect(t).toMatchObject({ partialPeriod: '2026-06-01', fitted: 5, slope: 10, direction: 'up' });
    expect(t.limitations).toContain('PARTIAL_PERIOD');
  });

  it('needs at least four points', () => {
    const t = trend(series(['1', null, '3']), 'month');
    expect(t).toMatchObject({ slope: null, direction: null, fitted: 2 });
    expect(t.limitations).toEqual(['NULL_VALUES', 'LOW_SAMPLE']);
  });

  it('reads a time series result', () => {
    const month = col('order.order_date', { kind: 'time', type: 'DATE', granularity: 'month' });
    const r = result(
      [month, revenue],
      months.map((m, i) => [m, String(100 + i * 10)]),
      {
        policiesApplied: ['p'],
      },
    );
    const t = trendFromResult(r, 'revenue', 'month', '2026-12-01');
    expect(t).toMatchObject({ metric: 'revenue', slope: 10 });
    expect(t.limitations).toEqual(['POLICY_FILTERED']);
    expect(() => timeIndex(result([revenue], []))).toThrow(AnalysisInputError);
  });
});

// ─── distribution ───────────────────────────────────────────────────────────

describe('distribution', () => {
  it('computes shares, Pareto count and concentration', () => {
    const d = distribution([
      { member: 'A', value: '50' },
      { member: 'B', value: '30' },
      { member: 'C', value: '15' },
      { member: 'D', value: '5' },
    ]);
    expect(d.total).toBe('100');
    expect(d.members.map((m) => [m.member, m.share, m.cumulativeShare])).toEqual([
      ['A', 0.5, 0.5],
      ['B', 0.3, 0.8],
      ['C', 0.15, 0.95],
      ['D', 0.05, 1],
    ]);
    expect(d).toMatchObject({ membersFor80: 2, topShare: 0.5, hhi: 0.365 });
    expect(d.gini).toBeCloseTo(0.375, 6);
  });

  it.each([
    [[1, 1, 1, 1], 0],
    [[0, 0, 0, 10], 0.75],
    [[], 0],
  ])('Gini of %j is %s', (values, expected) => {
    expect(gini(values)).toBeCloseTo(expected, 9);
  });

  it('even members: HHI = 1/n', () => {
    const d = distribution(['a', 'b', 'c', 'd', 'e'].map((m) => ({ member: m, value: '2' })));
    expect(d.hhi).toBeCloseTo(0.2, 6);
    expect(d.membersFor80).toBe(4);
  });

  it('leaves shares out for negative values or a zero total', () => {
    const negative = distribution([
      { member: 'a', value: '10' },
      { member: 'b', value: '-4' },
    ]);
    expect(negative).toMatchObject({ hhi: null, gini: null, topShare: null, membersFor80: null });
    expect(negative.limitations).toEqual(['NEGATIVE_VALUES']);
    expect(distribution([{ member: 'a', value: '0' }]).limitations).toEqual(['ZERO_TOTAL']);
    expect(distribution([{ member: 'a', value: null }]).limitations).toEqual([
      'NULL_VALUES',
      'NO_DATA',
    ]);
  });

  it('reads a grouped result and keeps its limitations', () => {
    const d = distributionFromResult(
      result(
        [region, revenue],
        [
          ['North', '30'],
          ['South', '10'],
        ],
        { truncated: true },
      ),
      'revenue',
      'customer.region',
      1,
    );
    expect(d.top).toEqual([{ member: 'North', value: '30', share: 0.75, cumulativeShare: 0.75 }]);
    expect(d.limitations).toEqual(['TRUNCATED']);
  });
});

// ─── anomaly ────────────────────────────────────────────────────────────────

describe('anomaly', () => {
  const base = [100, 102, 98, 101, 99, 103, 97, 100, 102, 98, 101, 99, 100, 101, 99, 100];
  const points = (values: number[]) =>
    days(values.length).map((period, i) => ({ period, value: String(values[i]) }));

  it('finds planted spikes and dips, nothing else', () => {
    const values = [...base];
    values[5] = 180;
    values[11] = 40;
    const r = detectAnomalies(points(values));
    expect(r.anomalies.map((a) => [a.period, a.direction])).toEqual([
      ['2026-01-06', 'high'],
      ['2026-01-12', 'low'],
    ]);
    expect(r.median).toBe(100);
    expect(r.anomalies[0]!.z).toBeGreaterThan(3.5);
  });

  it('finds nothing in normal noise', () => {
    expect(detectAnomalies(points(base)).anomalies).toEqual([]);
  });

  it('needs enough points and variation', () => {
    expect(detectAnomalies(points(base.slice(0, 13))).limitations).toEqual(['LOW_SAMPLE']);
    const flat = detectAnomalies(points(Array(20).fill(5)));
    expect(flat).toMatchObject({ mad: 0, anomalies: [] });
    expect(flat.limitations).toEqual(['CONSTANT_SERIES']);
  });

  it('respects a custom threshold and ignores missing values', () => {
    const values = points([...base]);
    values[2] = { period: values[2]!.period, value: null as unknown as string };
    const r = detectAnomalies(values, { threshold: 1 });
    expect(r.points).toBe(base.length - 1);
    expect(r.limitations).toEqual(['NULL_VALUES']);
    expect(r.anomalies.length).toBeGreaterThan(0);
  });

  it('analyses each member of a grouped series', () => {
    const rows: (string | null)[][] = [];
    days(16).forEach((d, i) => {
      rows.push([d, 'North', String(i === 8 ? 500 : base[i])]);
      rows.push([d, 'South', String(base[i])]);
    });
    const reports = anomaliesFromResult(
      result([day, region, revenue], rows),
      'revenue',
      'customer.region',
    );
    expect(reports.map((r) => [r.member, r.anomalies.length])).toEqual([
      ['North', 1],
      ['South', 0],
    ]);
    expect(columnIndex(result([day, region, revenue], rows), 'customer.region')).toBe(1);
  });
});
