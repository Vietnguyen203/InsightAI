/**
 * Exact decimal arithmetic on the strings returned by the query engine (PostgreSQL numeric).
 * Additions and subtractions of business figures must not go through float64; ratios and
 * statistics derived from them may (they are rounded where shown).
 */

export interface Dec {
  /** Unscaled integer value. */
  readonly v: bigint;
  /** Number of decimal places. */
  readonly s: number;
}

const DECIMAL = /^([+-])?(\d+)(?:\.(\d+))?$/;

export function dec(text: string): Dec {
  const m = DECIMAL.exec(text.trim());
  if (!m) throw new RangeError(`Not a decimal: ${text}`);
  const fraction = m[3] ?? '';
  const v = BigInt(`${m[2]}${fraction}`);
  return normalize({ v: m[1] === '-' ? -v : v, s: fraction.length });
}

export const ZERO: Dec = { v: 0n, s: 0 };

function normalize(d: Dec): Dec {
  let { v, s } = d;
  while (s > 0 && v % 10n === 0n) {
    v /= 10n;
    s -= 1;
  }
  return { v, s };
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const s = Math.max(a.s, b.s);
  return [a.v * 10n ** BigInt(s - a.s), b.v * 10n ** BigInt(s - b.s), s];
}

export function add(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return normalize({ v: x + y, s });
}

export function sub(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return normalize({ v: x - y, s });
}

export const neg = (a: Dec): Dec => ({ v: -a.v, s: a.s });
export const abs = (a: Dec): Dec => (a.v < 0n ? neg(a) : a);
export const sign = (a: Dec): -1 | 0 | 1 => (a.v === 0n ? 0 : a.v < 0n ? -1 : 1);

export function cmp(a: Dec, b: Dec): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x === y ? 0 : x < y ? -1 : 1;
}

export const sum = (values: Dec[]): Dec => values.reduce(add, ZERO);

export function toString(a: Dec): string {
  const negative = a.v < 0n;
  const digits = (negative ? -a.v : a.v).toString().padStart(a.s + 1, '0');
  const int = digits.slice(0, digits.length - a.s);
  const fraction = a.s > 0 ? `.${digits.slice(digits.length - a.s)}` : '';
  return `${negative ? '-' : ''}${int}${fraction}`;
}

/** For statistics only (shares, slopes, z-scores); never for figures shown as exact. */
export const toNumber = (a: Dec): number => Number(toString(a));

/** a / b as float64, or null when b is zero. */
export function ratio(a: Dec, b: Dec): number | null {
  return b.v === 0n ? null : toNumber(a) / toNumber(b);
}
