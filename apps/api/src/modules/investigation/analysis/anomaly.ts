import type { SemanticQueryResult } from '@insightai/contracts';
import { dec, toNumber } from './decimal';
import {
  columnIndex,
  type Limitation,
  resultLimitations,
  round,
  timeIndex,
  unique,
} from './result';

export interface Anomaly {
  period: string;
  value: string;
  /** Robust z-score: 0.6745 · (x − median) / MAD. */
  z: number;
  direction: 'high' | 'low';
}

export interface AnomalyReport {
  member: string | null;
  points: number;
  median: number | null;
  mad: number | null;
  anomalies: Anomaly[];
  limitations: Limitation[];
}

export const MIN_POINTS = 14;
export const Z_THRESHOLD = 3.5;

const median = (sorted: number[]) => {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
};

/**
 * Outliers of a series with the median/MAD rule (Iglewicz & Hoaglin), robust to the outliers
 * themselves. Needs at least 14 points; a constant series has no outliers.
 */
export function detectAnomalies(
  points: { period: string; value: string | null }[],
  options: { threshold?: number; minPoints?: number; member?: string | null } = {},
): AnomalyReport {
  const threshold = options.threshold ?? Z_THRESHOLD;
  const minPoints = options.minPoints ?? MIN_POINTS;
  const limitations: Limitation[] = [];
  if (points.some((p) => p.value === null)) limitations.push('NULL_VALUES');
  const series = points
    .filter((p) => p.value !== null)
    .map((p) => ({ period: p.period, value: p.value!, x: toNumber(dec(p.value!)) }))
    .sort((a, b) => a.period.localeCompare(b.period));
  const member = options.member ?? null;
  if (series.length < minPoints) {
    limitations.push('LOW_SAMPLE');
    return { member, points: series.length, median: null, mad: null, anomalies: [], limitations };
  }
  const xs = series.map((p) => p.x).sort((a, b) => a - b);
  const med = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - med)).sort((a, b) => a - b));
  if (mad === 0) {
    limitations.push('CONSTANT_SERIES');
    return {
      member,
      points: series.length,
      median: round(med),
      mad: 0,
      anomalies: [],
      limitations,
    };
  }
  const anomalies = series
    .map((p) => ({ ...p, z: (0.6745 * (p.x - med)) / mad }))
    .filter((p) => Math.abs(p.z) >= threshold)
    .map((p): Anomaly => ({
      period: p.period,
      value: p.value,
      z: round(p.z, 3),
      direction: p.z > 0 ? 'high' : 'low',
    }));
  return {
    member,
    points: series.length,
    median: round(med),
    mad: round(mad),
    anomalies,
    limitations,
  };
}

/** One series, or one per member when the result is also grouped by a dimension. */
export function anomaliesFromResult(
  result: SemanticQueryResult,
  metric: string,
  dimension?: string,
): AnomalyReport[] {
  const t = timeIndex(result);
  const m = columnIndex(result, metric);
  const d = dimension ? columnIndex(result, dimension) : -1;
  const groups = new Map<string | null, { period: string; value: string | null }[]>();
  for (const r of result.rows) {
    const key = d >= 0 ? (r[d] ?? null) : null;
    const list = groups.get(key) ?? [];
    list.push({ period: r[t] ?? '', value: r[m] ?? null });
    groups.set(key, list);
  }
  const common = resultLimitations(result);
  return [...groups.entries()].map(([member, points]) => {
    const report = detectAnomalies(points, { member });
    return { ...report, limitations: unique([...common, ...report.limitations]) };
  });
}
