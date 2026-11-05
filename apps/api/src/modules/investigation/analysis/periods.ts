/** Calendar periods of a time series (ISO dates, UTC arithmetic; bucket starts from PostgreSQL). */

export type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`);

/** Start of the next bucket after `start`. */
export function nextPeriod(start: string, g: Granularity): string {
  const d = parse(start);
  switch (g) {
    case 'day':
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case 'week':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'month':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case 'quarter':
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case 'year':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  return iso(d);
}

/** Bucket starts missing between the first and the last given period. */
export function missingPeriods(periods: string[], g: Granularity, max = 1000): string[] {
  if (periods.length < 2) return [];
  const sorted = [...periods].map((p) => p.slice(0, 10)).sort();
  const present = new Set(sorted);
  const missing: string[] = [];
  for (let p = sorted[0]!; p < sorted.at(-1)! && missing.length < max; p = nextPeriod(p, g)) {
    if (!present.has(p)) missing.push(p);
  }
  return missing;
}

/** Whether the bucket starting at `start` still contains `today` (not complete yet). */
export const isPartial = (start: string, g: Granularity, today: string) =>
  start.slice(0, 10) <= today && today < nextPeriod(start, g);
