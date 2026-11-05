import type { SemanticQueryResult } from '@insightai/contracts';
import { abs, cmp, type Dec, dec, ratio, sub, sum, toNumber, toString, ZERO } from './decimal';
import { columnIndex, type Limitation, resultLimitations, round } from './result';

/** A member's values in the two periods (null = no data for it in that period). */
export interface MemberValues {
  member: string | null;
  current: string | null;
  baseline: string | null;
}

export interface MemberContribution {
  member: string | null;
  current: string;
  baseline: string;
  delta: string;
  /** delta / total delta; null when the total did not change. */
  share: number | null;
}

export interface Contribution {
  totalCurrent: string;
  totalBaseline: string;
  totalDelta: string;
  /** Every member, largest absolute change first. */
  members: MemberContribution[];
  top: MemberContribution[];
  /** The remaining members together. */
  others: (Omit<MemberContribution, 'member'> & { count: number }) | null;
  limitations: Limitation[];
}

/**
 * Splits the change of an additive metric into the change of each member. Totals are computed
 * from the members with exact decimals, so the parts always add up to the whole; a total
 * reported separately (query without the dimension) is compared and a mismatch reported.
 */
export function contribution(
  rows: MemberValues[],
  options: {
    k?: number;
    reportedTotal?: { current: string | null; baseline: string | null };
  } = {},
): Contribution {
  const k = options.k ?? 5;
  const limitations: Limitation[] = [];
  if (rows.some((r) => r.current === null || r.baseline === null)) limitations.push('NULL_VALUES');
  const values = rows.map((r) => {
    const current = r.current === null ? ZERO : dec(r.current);
    const baseline = r.baseline === null ? ZERO : dec(r.baseline);
    return { member: r.member, current, baseline, delta: sub(current, baseline) };
  });
  const totalCurrent = sum(values.map((v) => v.current));
  const totalBaseline = sum(values.map((v) => v.baseline));
  const totalDelta = sub(totalCurrent, totalBaseline);
  if (totalDelta.v === 0n) limitations.push('ZERO_TOTAL');
  if (values.length === 0) limitations.push('NO_DATA');

  if (options.reportedTotal) {
    const { current, baseline } = options.reportedTotal;
    const matches =
      current !== null &&
      baseline !== null &&
      cmp(dec(current), totalCurrent) === 0 &&
      cmp(dec(baseline), totalBaseline) === 0;
    if (!matches) limitations.push('TOTAL_MISMATCH');
  }

  const toMember = (v: (typeof values)[number]): MemberContribution => ({
    member: v.member,
    current: toString(v.current),
    baseline: toString(v.baseline),
    delta: toString(v.delta),
    share: shareOf(v.delta, totalDelta),
  });
  const sorted = [...values].sort(
    (a, b) => cmp(abs(b.delta), abs(a.delta)) || String(a.member).localeCompare(String(b.member)),
  );
  const members = sorted.map(toMember);
  const rest = sorted.slice(k);
  const others =
    rest.length === 0
      ? null
      : (() => {
          const current = sum(rest.map((v) => v.current));
          const baseline = sum(rest.map((v) => v.baseline));
          const delta = sub(current, baseline);
          return {
            count: rest.length,
            current: toString(current),
            baseline: toString(baseline),
            delta: toString(delta),
            share: shareOf(delta, totalDelta),
          };
        })();

  return {
    totalCurrent: toString(totalCurrent),
    totalBaseline: toString(totalBaseline),
    totalDelta: toString(totalDelta),
    members,
    top: members.slice(0, k),
    others,
    limitations,
  };
}

function shareOf(delta: Dec, total: Dec): number | null {
  const r = ratio(delta, total);
  return r === null ? null : round(r);
}

/** Rows from one grouped query with `compareTo` (dimension, metric, metric previous). */
export function membersFromCompareResult(
  result: SemanticQueryResult,
  metric: string,
  dimension: string,
): MemberValues[] {
  const d = columnIndex(result, dimension);
  const c = columnIndex(result, metric);
  const p = columnIndex(result, metric, true);
  return result.rows.map((r) => ({
    member: r[d] ?? null,
    current: r[c] ?? null,
    baseline: r[p] ?? null,
  }));
}

/** Rows from two grouped queries (current period, baseline period), joined by member. */
export function membersFromTwoResults(
  current: SemanticQueryResult,
  baseline: SemanticQueryResult,
  metric: string,
  dimension: string,
): MemberValues[] {
  const byMember = new Map<string | null, MemberValues>();
  const take = (result: SemanticQueryResult, field: 'current' | 'baseline') => {
    const d = columnIndex(result, dimension);
    const m = columnIndex(result, metric);
    for (const r of result.rows) {
      const member = r[d] ?? null;
      const entry = byMember.get(member) ?? { member, current: null, baseline: null };
      entry[field] = r[m] ?? null;
      byMember.set(member, entry);
    }
  };
  take(current, 'current');
  take(baseline, 'baseline');
  return [...byMember.values()];
}

export const contributionLimitations = (...results: SemanticQueryResult[]) =>
  resultLimitations(...results);

// ─── Ratio metrics: mix / rate decomposition ───────────────────────────────────

export interface RatioMemberValues {
  member: string | null;
  numerator: { current: string | null; baseline: string | null };
  denominator: { current: string | null; baseline: string | null };
}

export interface RatioMemberEffect {
  member: string | null;
  rateCurrent: number | null;
  rateBaseline: number | null;
  weightCurrent: number;
  weightBaseline: number;
  /** Change of the member's own ratio, weighted by its average share of the denominator. */
  rateEffect: number;
  /** Change of the member's share of the denominator, valued at its average ratio. */
  mixEffect: number;
  effect: number;
}

export interface RatioDecomposition {
  ratioCurrent: number | null;
  ratioBaseline: number | null;
  delta: number | null;
  members: RatioMemberEffect[];
  rateEffect: number;
  mixEffect: number;
  /**
   * Part of the change the decomposition cannot attribute: a member with a numerator but no
   * denominator in a period (inconsistent data) adds to N without a ratio of its own.
   */
  residual: number;
  limitations: Limitation[];
}

/**
 * R = N / D = Σ wᵢ·rᵢ with wᵢ = Dᵢ / D and rᵢ = Nᵢ / Dᵢ. The change splits exactly (up to float
 * rounding) into Σ Δrᵢ·w̄ᵢ (rate) + Σ Δwᵢ·r̄ᵢ (mix), with averages of the two periods. A member
 * without denominator in one period takes its ratio from the other period (its rate effect is 0).
 */
export function ratioDecomposition(rows: RatioMemberValues[]): RatioDecomposition {
  const limitations: Limitation[] = [];
  const val = (s: string | null) => (s === null ? ZERO : dec(s));
  if (
    rows.some(
      (r) =>
        r.numerator.current === null ||
        r.numerator.baseline === null ||
        r.denominator.current === null ||
        r.denominator.baseline === null,
    )
  ) {
    limitations.push('NULL_VALUES');
  }
  const n1 = sum(rows.map((r) => val(r.numerator.current)));
  const n0 = sum(rows.map((r) => val(r.numerator.baseline)));
  const d1 = sum(rows.map((r) => val(r.denominator.current)));
  const d0 = sum(rows.map((r) => val(r.denominator.baseline)));
  const ratioCurrent = ratio(n1, d1);
  const ratioBaseline = ratio(n0, d0);
  if (ratioCurrent === null || ratioBaseline === null) {
    limitations.push('ZERO_BASELINE');
    return {
      ratioCurrent,
      ratioBaseline,
      delta: null,
      members: [],
      rateEffect: 0,
      mixEffect: 0,
      residual: 0,
      limitations,
    };
  }
  const D1 = toNumber(d1);
  const D0 = toNumber(d0);
  const members = rows.map((r): RatioMemberEffect => {
    const nc = val(r.numerator.current);
    const nb = val(r.numerator.baseline);
    const dc = val(r.denominator.current);
    const db = val(r.denominator.baseline);
    let r1 = ratio(nc, dc);
    let r0 = ratio(nb, db);
    const w1 = toNumber(dc) / D1;
    const w0 = toNumber(db) / D0;
    if (r1 === null) r1 = r0 ?? 0;
    if (r0 === null) r0 = r1;
    const rateEffect = (r1 - r0) * ((w1 + w0) / 2);
    const mixEffect = (w1 - w0) * ((r1 + r0) / 2);
    return {
      member: r.member,
      rateCurrent: ratio(nc, dc),
      rateBaseline: ratio(nb, db),
      weightCurrent: round(w1),
      weightBaseline: round(w0),
      rateEffect: round(rateEffect, 9),
      mixEffect: round(mixEffect, 9),
      effect: round(rateEffect + mixEffect, 9),
    };
  });
  members.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  const delta = ratioCurrent - ratioBaseline;
  const rateEffect = members.reduce((s, m) => s + m.rateEffect, 0);
  const mixEffect = members.reduce((s, m) => s + m.mixEffect, 0);
  const residual = delta - rateEffect - mixEffect;
  if (Math.abs(residual) > 1e-9 * Math.max(1, Math.abs(delta))) limitations.push('TOTAL_MISMATCH');
  return {
    ratioCurrent,
    ratioBaseline,
    delta: round(delta, 9),
    members,
    rateEffect: round(rateEffect, 9),
    mixEffect: round(mixEffect, 9),
    residual: round(residual, 9),
    limitations,
  };
}
