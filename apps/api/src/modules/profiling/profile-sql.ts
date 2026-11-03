import type { ColumnDataType } from '@insightai/contracts';

/**
 * SQL builders for column profiling. Identifiers must already be quoted by the caller
 * (`client.escapeIdentifier`) and come from metadata, never from user input.
 */

export interface ProfiledColumn {
  /** Quoted physical column identifier. */
  ident: string;
  dataType: ColumnDataType;
}

export const isNumeric = (type: ColumnDataType) => type === 'INTEGER' || type === 'DECIMAL';
export const isTemporal = (type: ColumnDataType) => type === 'DATE' || type === 'TIMESTAMP';

/** Rows above which distinct counts, percentiles, top values and histograms use a sample. */
export const SAMPLE_THRESHOLD = 1_000_000;
const SAMPLE_TARGET_ROWS = 500_000;

/** FROM clause: the full table, or a repeatable block sample of ~500k rows for large tables. */
export function sampleSource(table: string, rowCount: number): { from: string; sampled: boolean } {
  if (rowCount <= SAMPLE_THRESHOLD) return { from: table, sampled: false };
  const percent = Math.min(100, Math.max(1, (SAMPLE_TARGET_ROWS / rowCount) * 100)).toFixed(2);
  return { from: `${table} TABLESAMPLE SYSTEM (${percent}) REPEATABLE (42)`, sampled: true };
}

// trim_scale drops trailing zeros: 371166.812500 → 371166.8125.
const round = (expr: string) => `trim_scale(round((${expr})::numeric, 6))::text`;

/** One full scan for exact counts and ranges of every column. Result aliases: n{i}, min{i}, ... */
export function basicStatsQuery(table: string, columns: ProfiledColumn[]): string {
  const parts = ['count(*) AS total'];
  columns.forEach((c, i) => {
    parts.push(`count(${c.ident}) AS n${i}`);
    if (c.dataType === 'TEXT') {
      parts.push(
        `min(length(${c.ident})) AS lmin${i}`,
        `max(length(${c.ident})) AS lmax${i}`,
        `${round(`avg(length(${c.ident}))`)} AS lavg${i}`,
      );
    } else if (c.dataType !== 'BOOLEAN') {
      parts.push(`min(${c.ident})::text AS min${i}`, `max(${c.ident})::text AS max${i}`);
    }
    if (isNumeric(c.dataType)) {
      parts.push(
        `${round(`avg(${c.ident})`)} AS mean${i}`,
        `${round(`stddev_samp(${c.ident})`)} AS sd${i}`,
      );
    }
  });
  return `SELECT ${parts.join(', ')} FROM ${table}`;
}

/** Distinct counts and quartiles (possibly on a sample). Aliases: d{i}, p25_{i}, p50_{i}, p75_{i}. */
export function distributionQuery(from: string, columns: ProfiledColumn[]): string {
  const parts: string[] = [];
  columns.forEach((c, i) => {
    parts.push(`count(DISTINCT ${c.ident}) AS d${i}`);
    if (isNumeric(c.dataType)) {
      for (const [alias, fraction] of [
        ['p25', 0.25],
        ['p50', 0.5],
        ['p75', 0.75],
      ] as const) {
        parts.push(
          `${round(`percentile_cont(${fraction}) WITHIN GROUP (ORDER BY ${c.ident})`)} AS ${alias}_${i}`,
        );
      }
    }
  });
  return `SELECT ${parts.join(', ')} FROM ${from}`;
}

export function topValuesQuery(from: string, ident: string, limit = 10): string {
  return (
    `SELECT ${ident}::text AS value, count(*)::bigint AS n FROM ${from} ` +
    `WHERE ${ident} IS NOT NULL GROUP BY ${ident} ORDER BY n DESC, ${ident} LIMIT ${Math.trunc(limit)}`
  );
}

export const HISTOGRAM_BUCKETS = 20;

/** Equal-width histogram between the (exact) min and max, passed as $1 and $2. */
export function histogramQuery(from: string, ident: string): string {
  return (
    `SELECT least(width_bucket(${ident}::numeric, $1::numeric, $2::numeric, ${HISTOGRAM_BUCKETS}), ${HISTOGRAM_BUCKETS}) AS b, ` +
    `count(*)::bigint AS n FROM ${from} WHERE ${ident} IS NOT NULL GROUP BY 1 ORDER BY 1`
  );
}

/** Rows per month (or per year when the range is long), in chronological order. */
export function timelineQuery(table: string, ident: string, unit: 'month' | 'year'): string {
  const format = unit === 'month' ? 'YYYY-MM' : 'YYYY';
  return (
    `SELECT to_char(date_trunc('${unit}', ${ident}), '${format}') AS period, count(*)::bigint AS n ` +
    `FROM ${table} WHERE ${ident} IS NOT NULL GROUP BY 1 ORDER BY 1`
  );
}

/** Bucket boundaries as exact decimal text. */
export function histogramBounds(
  min: string,
  max: string,
  buckets = HISTOGRAM_BUCKETS,
): { from: string; to: string }[] {
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [{ from: min, to: max }];
  const width = (hi - lo) / buckets;
  const fmt = (n: number) => String(Number(n.toPrecision(12)));
  return Array.from({ length: buckets }, (_, i) => ({
    from: fmt(lo + i * width),
    to: i === buckets - 1 ? max : fmt(lo + (i + 1) * width),
  }));
}
