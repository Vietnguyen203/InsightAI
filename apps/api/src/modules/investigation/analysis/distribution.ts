import type { SemanticQueryResult } from '@insightai/contracts';
import { cmp, dec, ratio, sum, toString, ZERO } from './decimal';
import { columnIndex, type Limitation, resultLimitations, round, unique } from './result';

export interface DistributionMember {
  member: string | null;
  value: string;
  share: number | null;
  cumulativeShare: number | null;
}

export interface Distribution {
  total: string;
  members: DistributionMember[];
  top: DistributionMember[];
  /** Fewest members that together make 80 % of the total (Pareto). */
  membersFor80: number | null;
  /** Share of the largest member. */
  topShare: number | null;
  /** Herfindahl–Hirschman index (Σ share²): 1/n even … 1 one member. */
  hhi: number | null;
  /** Gini coefficient of the members' values: 0 even … close to 1 concentrated. */
  gini: number | null;
  limitations: Limitation[];
}

/**
 * How a metric is spread over the members of a dimension. Shares and concentration measures are
 * only meaningful for non-negative values; with negative values they are left out.
 */
export function distribution(
  rows: { member: string | null; value: string | null }[],
  k = 5,
): Distribution {
  const limitations: Limitation[] = [];
  if (rows.some((r) => r.value === null)) limitations.push('NULL_VALUES');
  const values = rows
    .filter((r) => r.value !== null)
    .map((r) => ({ member: r.member, value: dec(r.value!) }))
    .sort((a, b) => cmp(b.value, a.value) || String(a.member).localeCompare(String(b.member)));
  const total = sum(values.map((v) => v.value));
  const negative = values.some((v) => v.value.v < 0n);
  if (negative) limitations.push('NEGATIVE_VALUES');
  if (values.length === 0) limitations.push('NO_DATA');
  if (!negative && values.length > 0 && cmp(total, ZERO) === 0) limitations.push('ZERO_TOTAL');
  const usable = !negative && cmp(total, ZERO) > 0;

  let cumulative = 0;
  const members = values.map((v): DistributionMember => {
    const share = usable ? ratio(v.value, total) : null;
    if (share !== null) cumulative += share;
    return {
      member: v.member,
      value: toString(v.value),
      share: share === null ? null : round(share),
      cumulativeShare: share === null ? null : round(Math.min(cumulative, 1)),
    };
  });
  const shares = members.map((m) => m.share ?? 0);
  return {
    total: toString(total),
    members,
    top: members.slice(0, k),
    membersFor80: usable
      ? members.findIndex((m) => (m.cumulativeShare ?? 0) >= 0.8 - 1e-9) + 1 || members.length
      : null,
    topShare: usable ? (members[0]?.share ?? null) : null,
    hhi: usable ? round(shares.reduce((s, x) => s + x * x, 0)) : null,
    gini: usable ? round(gini(shares)) : null,
    limitations,
  };
}

/** Gini coefficient of non-negative values (order does not matter). */
export function gini(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((s, x) => s + x, 0);
  if (total === 0) return 0;
  const weighted = sorted.reduce((s, x, i) => s + (i + 1) * x, 0);
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

export function distributionFromResult(
  result: SemanticQueryResult,
  metric: string,
  dimension: string,
  k = 5,
): Distribution {
  const d = columnIndex(result, dimension);
  const m = columnIndex(result, metric);
  const out = distribution(
    result.rows.map((r) => ({ member: r[d] ?? null, value: r[m] ?? null })),
    k,
  );
  return { ...out, limitations: unique([...resultLimitations(result), ...out.limitations]) };
}
