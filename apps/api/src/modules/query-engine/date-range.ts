import type { DateRange } from '@insightai/contracts';

/** Inclusive calendar dates (yyyy-MM-dd). */
export interface ResolvedRange {
  from: string;
  to: string;
}

/** Today's calendar date in the organization time zone. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  // en-CA formats as yyyy-MM-dd.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, days: number) => {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
};

/** First day of the month containing `iso`, shifted by `months`. */
const monthStart = (iso: string, months = 0) => {
  const d = toDate(iso);
  return fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1)));
};

/**
 * Resolves a date range on the server (docs/SEMANTIC_LAYER_DESIGN.md §5): presets use the
 * organization's time zone and the server's clock, so clients (and the LLM) never compute dates.
 * Weeks start on Monday (ISO).
 */
export function resolveDateRange(range: DateRange, timezone: string, now?: Date): ResolvedRange {
  if ('from' in range) return { from: range.from, to: range.to };
  const today = todayIn(timezone, now);
  const weekday = (toDate(today).getUTCDay() + 6) % 7; // Monday = 0
  const quarterStart = (shift: number) => {
    const d = toDate(today);
    const q = Math.floor(d.getUTCMonth() / 3) + shift;
    return fmt(new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1)));
  };
  const year = toDate(today).getUTCFullYear();

  switch (range.preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'this_week':
      return { from: addDays(today, -weekday), to: today };
    case 'last_week':
      return { from: addDays(today, -weekday - 7), to: addDays(today, -weekday - 1) };
    case 'this_month':
      return { from: monthStart(today), to: today };
    case 'last_month':
      return { from: monthStart(today, -1), to: addDays(monthStart(today), -1) };
    case 'last_7_days':
      return { from: addDays(today, -6), to: today };
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    case 'last_90_days':
      return { from: addDays(today, -89), to: today };
    case 'this_quarter':
      return { from: quarterStart(0), to: today };
    case 'last_quarter':
      return { from: quarterStart(-1), to: addDays(quarterStart(0), -1) };
    case 'this_year':
      return { from: `${year}-01-01`, to: today };
    case 'last_year':
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
  }
}

/** Exclusive upper bound for SQL (`< to + 1 day`), so timestamps on the last day are included. */
export const exclusiveEnd = (range: ResolvedRange) => addDays(range.to, 1);

/** The period `compareTo` compares with: the same length just before, or one year earlier. */
export function compareRangeFor(
  range: ResolvedRange,
  compareTo: 'previous_period' | 'same_period_last_year',
): ResolvedRange {
  if (compareTo === 'previous_period') {
    const days =
      Math.round((toDate(range.to).getTime() - toDate(range.from).getTime()) / 86_400_000) + 1;
    return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
  }
  const yearEarlier = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
    // 29 February → 28 February.
    const day = Math.min(d, new Date(Date.UTC(y - 1, m, 0)).getUTCDate());
    return fmt(new Date(Date.UTC(y - 1, m - 1, day)));
  };
  return { from: yearEarlier(range.from), to: yearEarlier(range.to) };
}
