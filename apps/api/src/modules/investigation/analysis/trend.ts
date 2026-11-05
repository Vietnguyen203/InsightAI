import type { SemanticQueryResult } from '@insightai/contracts';
import { dec, ratio, sub, toNumber, toString } from './decimal';
import { type Granularity, isPartial, missingPeriods } from './periods';
import {
  columnIndex,
  type Limitation,
  resultLimitations,
  round,
  timeIndex,
  unique,
} from './result';

export interface TrendPoint {
  period: string;
  value: string | null;
}

export interface Trend {
  metric: string;
  granularity: Granularity;
  points: TrendPoint[];
  /** Points used for the line (complete periods with a value). */
  fitted: number;
  /** Least-squares slope per period, intercept and goodness of fit. */
  slope: number | null;
  intercept: number | null;
  r2: number | null;
  /** Change from the first to the last fitted point, exact; and relative to the first. */
  firstLastDelta: string | null;
  firstLastRatio: number | null;
  /** Direction of the fitted line; "flat" when it moves less than 2 % of the mean overall. */
  direction: 'up' | 'down' | 'flat' | null;
  gaps: string[];
  partialPeriod: string | null;
  limitations: Limitation[];
}

const MIN_POINTS = 4;
const FLAT_THRESHOLD = 0.02;

/**
 * Trend of one metric over time buckets. The current, incomplete bucket is shown but not
 * fitted (it would always look like a drop). Missing buckets are reported, never filled.
 */
export function trend(
  points: TrendPoint[],
  granularity: Granularity,
  options: { today?: string; metric?: string } = {},
): Trend {
  const limitations: Limitation[] = [];
  const sorted = [...points].sort((a, b) => a.period.localeCompare(b.period));
  const last = sorted.at(-1);
  const partialPeriod =
    options.today && last && isPartial(last.period, granularity, options.today)
      ? last.period.slice(0, 10)
      : null;
  if (partialPeriod) limitations.push('PARTIAL_PERIOD');
  if (sorted.some((p) => p.value === null)) limitations.push('NULL_VALUES');
  const gaps = missingPeriods(
    sorted.map((p) => p.period),
    granularity,
  );
  if (gaps.length > 0) limitations.push('GAPS');

  const fit = sorted.filter((p) => p.value !== null && p.period.slice(0, 10) !== partialPeriod) as {
    period: string;
    value: string;
  }[];
  const base = {
    metric: options.metric ?? '',
    granularity,
    points: sorted,
    fitted: fit.length,
    gaps,
    partialPeriod,
  };
  if (fit.length < MIN_POINTS) {
    limitations.push('LOW_SAMPLE');
    return {
      ...base,
      slope: null,
      intercept: null,
      r2: null,
      firstLastDelta: null,
      firstLastRatio: null,
      direction: null,
      limitations,
    };
  }

  // x = index of the period on the calendar (gaps keep their place).
  const index = periodIndex(
    fit.map((p) => p.period),
    granularity,
  );
  const xs = fit.map((p) => index.get(p.period.slice(0, 10))!);
  const ys = fit.map((p) => toNumber(dec(p.value)));
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  const first = dec(fit[0]!.value);
  const delta = sub(dec(fit.at(-1)!.value), first);
  const span = xs.at(-1)! - xs[0]!;
  const relativeMove = my === 0 ? 0 : Math.abs((slope * span) / my);
  const firstLastRatio = ratio(delta, first.v < 0n ? { v: -first.v, s: first.s } : first);

  return {
    ...base,
    slope: round(slope),
    intercept: round(intercept),
    r2: round(r2),
    firstLastDelta: toString(delta),
    firstLastRatio: firstLastRatio === null ? null : round(firstLastRatio),
    direction: relativeMove < FLAT_THRESHOLD ? 'flat' : slope > 0 ? 'up' : 'down',
    limitations,
  };
}

/** Position of each period on the calendar, counting missing periods too. */
function periodIndex(periods: string[], g: Granularity): Map<string, number> {
  const sorted = periods.map((p) => p.slice(0, 10)).sort();
  const gaps = new Set(missingPeriods(sorted, g));
  const all = [...new Set([...sorted, ...gaps])].sort();
  return new Map(all.map((p, i) => [p, i]));
}

export function trendFromResult(
  result: SemanticQueryResult,
  metric: string,
  granularity: Granularity,
  today?: string,
): Trend {
  const t = timeIndex(result);
  const m = columnIndex(result, metric);
  const out = trend(
    result.rows.map((r) => ({ period: r[t] ?? '', value: r[m] ?? null })),
    granularity,
    { today, metric },
  );
  return { ...out, limitations: unique([...resultLimitations(result), ...out.limitations]) };
}
