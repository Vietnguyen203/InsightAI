import type { SemanticQueryResult } from '@insightai/contracts';

/**
 * Why a finding may be weaker than it looks. Every analysis returns the ones that apply; the
 * report shows them under "Limitations" (docs/PHASE6_AI_ANALYST_DESIGN.md §2.7).
 */
export type Limitation =
  | 'NO_DATA'
  | 'TRUNCATED'
  | 'NULL_VALUES'
  | 'ZERO_BASELINE'
  | 'ZERO_TOTAL'
  | 'TOTAL_MISMATCH'
  | 'NOT_ADDITIVE'
  | 'NEGATIVE_VALUES'
  | 'LOW_SAMPLE'
  | 'GAPS'
  | 'PARTIAL_PERIOD'
  | 'CONSTANT_SERIES'
  | 'POLICY_FILTERED';

export class AnalysisInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisInputError';
  }
}

/** Index of a column by key; `comparison` selects the previous-period column of a metric. */
export function columnIndex(result: SemanticQueryResult, key: string, comparison = false): number {
  const i = result.columns.findIndex((c) => c.key === key && c.comparison === comparison);
  if (i < 0) {
    throw new AnalysisInputError(`Column ${key}${comparison ? ' (previous)' : ''} not in result`);
  }
  return i;
}

export function timeIndex(result: SemanticQueryResult): number {
  const i = result.columns.findIndex((c) => c.kind === 'time');
  if (i < 0) throw new AnalysisInputError('The result has no time column');
  return i;
}

/** Limitations that come from the query result itself. */
export function resultLimitations(...results: SemanticQueryResult[]): Limitation[] {
  const out = new Set<Limitation>();
  for (const r of results) {
    if (r.truncated) out.add('TRUNCATED');
    if (r.policiesApplied.length > 0) out.add('POLICY_FILTERED');
    if (r.rows.length === 0) out.add('NO_DATA');
  }
  return [...out];
}

export const unique = <T>(values: T[]): T[] => [...new Set(values)];

/** Rounds a derived statistic for storage/display (shares, slopes, z-scores). */
export const round = (value: number, digits = 6): number =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
