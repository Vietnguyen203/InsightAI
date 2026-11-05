import type { SemanticQueryResult } from '@insightai/contracts';
import { dec, ratio, sign, sub, toString } from './decimal';
import { columnIndex, type Limitation, resultLimitations, round, unique } from './result';

export interface Comparison {
  metric: string;
  current: string | null;
  baseline: string | null;
  /** current − baseline, exact. */
  delta: string | null;
  /** delta / |baseline|; null when the baseline is zero or missing. */
  deltaRatio: number | null;
  direction: 'up' | 'down' | 'flat' | null;
  limitations: Limitation[];
}

export function compareValues(
  metric: string,
  current: string | null,
  baseline: string | null,
): Comparison {
  const limitations: Limitation[] = [];
  if (current === null || baseline === null) {
    limitations.push('NO_DATA');
    return {
      metric,
      current,
      baseline,
      delta: null,
      deltaRatio: null,
      direction: null,
      limitations,
    };
  }
  const c = dec(current);
  const b = dec(baseline);
  const delta = sub(c, b);
  const r = ratio(delta, b.v < 0n ? { v: -b.v, s: b.s } : b);
  if (r === null) limitations.push('ZERO_BASELINE');
  const s = sign(delta);
  return {
    metric,
    current,
    baseline,
    delta: toString(delta),
    deltaRatio: r === null ? null : round(r),
    direction: s === 0 ? 'flat' : s > 0 ? 'up' : 'down',
    limitations,
  };
}

/** One row with `compareTo`: each metric next to its previous-period column. */
export function comparisonsFromCompareResult(
  result: SemanticQueryResult,
  metrics: string[],
): Comparison[] {
  const row = result.rows[0];
  const common = resultLimitations(result);
  return metrics.map((m) => {
    const c = compareValues(
      m,
      row ? (row[columnIndex(result, m)] ?? null) : null,
      row ? (row[columnIndex(result, m, true)] ?? null) : null,
    );
    return { ...c, limitations: unique([...common, ...c.limitations]) };
  });
}

/** Two single-row results for explicit periods (current, baseline). */
export function comparisonsFromTwoResults(
  current: SemanticQueryResult,
  baseline: SemanticQueryResult,
  metrics: string[],
): Comparison[] {
  const common = resultLimitations(current, baseline);
  return metrics.map((m) => {
    const c = compareValues(
      m,
      current.rows[0]?.[columnIndex(current, m)] ?? null,
      baseline.rows[0]?.[columnIndex(baseline, m)] ?? null,
    );
    return { ...c, limitations: unique([...common, ...c.limitations]) };
  });
}
