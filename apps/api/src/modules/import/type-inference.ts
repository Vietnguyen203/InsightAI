/**
 * Column type inference (docs/DATA_QUALITY_DESIGN.md §2.3).
 *
 * Detection runs in PostgreSQL over the raw (text) table: for every column, one aggregate
 * query counts the non-empty values matching each candidate pattern. This module owns the
 * patterns, the decision rule and the cast expressions; it is pure and unit-tested.
 * All SQL produced here is built from fixed fragments and server-generated identifiers only.
 */

export type ColumnType = 'TEXT' | 'INTEGER' | 'DECIMAL' | 'BOOLEAN' | 'DATE' | 'TIMESTAMP';
export type NumberLocale = 'vi' | 'en';

/** A value shape we can recognise, and how to convert it. */
export interface Candidate {
  key: string;
  type: Exclude<ColumnType, 'TEXT'>;
  /** PostgreSQL regex (case-insensitive match `~*`) applied to btrim(value). */
  pattern: string;
  /** Human-readable format, stored as `detected_format`. */
  format: string;
  /** SQL expression converting `$v` (the trimmed text) to the target type; NULL when impossible. */
  cast: (v: string) => string;
}

// A leading zero (phone numbers, codes such as "00123") means the value is an identifier:
// such columns must stay TEXT, so numeric patterns exclude it explicitly.
const NO_LEADING_ZERO = '(?!0[0-9])';

const BOOLEAN_WORDS = "'true','false','yes','no','y','n','có','co','không','khong'";

function numberCandidates(locale: NumberLocale): Candidate[] {
  // vi: 1.234.567,89   en: 1,234,567.89
  const [thousands, decimal] = locale === 'vi' ? ['\\.', ','] : [',', '\\.'];
  const integerPart = `${NO_LEADING_ZERO}([0-9]{1,3}(${thousands}[0-9]{3})+|[0-9]+)`;
  const normalize = (v: string) =>
    locale === 'vi' ? `replace(replace(${v}, '.', ''), ',', '.')` : `replace(${v}, ',', '')`;
  return [
    {
      key: `integer_${locale}`,
      type: 'INTEGER',
      // Up to 18 digits fits a bigint safely.
      pattern: `^[+-]?${integerPart}$`,
      format: locale === 'vi' ? '1.234' : '1,234',
      cast: (v) => `dp.try_bigint(${normalize(v)})`,
    },
    {
      key: `decimal_${locale}`,
      type: 'DECIMAL',
      pattern: `^[+-]?(${integerPart}|0)(${decimal}[0-9]+)?$|^[+-]?${decimal}[0-9]+$`,
      format: locale === 'vi' ? '1.234,56' : '1,234.56',
      cast: (v) => `dp.try_numeric(${normalize(v)})`,
    },
  ];
}

function dateCandidates(locale: NumberLocale): Candidate[] {
  const dayFirst = locale === 'vi';
  return [
    {
      key: 'date_iso',
      type: 'DATE',
      pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
      format: 'yyyy-MM-dd',
      cast: (v) => `dp.try_date(${v}, 'YYYY-MM-DD')`,
    },
    {
      key: dayFirst ? 'date_dmy' : 'date_mdy',
      type: 'DATE',
      pattern: '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$',
      format: dayFirst ? 'dd/MM/yyyy' : 'MM/dd/yyyy',
      cast: (v) => `dp.try_date(${v}, '${dayFirst ? 'DD/MM/YYYY' : 'MM/DD/YYYY'}')`,
    },
    {
      key: 'timestamp_iso',
      type: 'TIMESTAMP',
      pattern:
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?$',
      format: 'ISO 8601',
      cast: (v) => `dp.try_timestamp_iso(${v}, $tz)`,
    },
    {
      key: dayFirst ? 'timestamp_dmy' : 'timestamp_mdy',
      type: 'TIMESTAMP',
      pattern: '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4} [0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$',
      format: dayFirst ? 'dd/MM/yyyy HH:mm[:ss]' : 'MM/dd/yyyy HH:mm[:ss]',
      cast: (v) =>
        `dp.try_timestamp(${v}, '${dayFirst ? 'DD/MM/YYYY HH24:MI:SS' : 'MM/DD/YYYY HH24:MI:SS'}')`,
    },
  ];
}

export function candidatesFor(locale: NumberLocale): Candidate[] {
  return [
    {
      key: 'boolean',
      type: 'BOOLEAN',
      pattern: '^(true|false|yes|no|y|n|có|co|không|khong)$',
      format: 'true/false',
      cast: (v) =>
        `CASE WHEN lower(${v}) IN ('true','yes','y','có','co') THEN true ` +
        `WHEN lower(${v}) IN (${BOOLEAN_WORDS}) THEN false END`,
    },
    ...numberCandidates(locale),
    ...dateCandidates(locale),
  ];
}

/** Narrowest first: when several candidates qualify, the earlier one wins. */
const PRIORITY: ColumnType[] = ['BOOLEAN', 'INTEGER', 'DECIMAL', 'DATE', 'TIMESTAMP'];

export interface ColumnStats {
  nonEmpty: number;
  /** Matches per candidate key. */
  matches: Record<string, number>;
}

export interface InferredType {
  type: ColumnType;
  candidate: Candidate | null;
  /** Share of non-empty values matching (1 for TEXT). */
  confidence: number;
}

/** Minimum share of non-empty values that must match for a type to be chosen. */
export const DEFAULT_MATCH_THRESHOLD = 0.95;

export function inferType(
  stats: ColumnStats,
  candidates: Candidate[],
  threshold = DEFAULT_MATCH_THRESHOLD,
): InferredType {
  if (stats.nonEmpty === 0) return { type: 'TEXT', candidate: null, confidence: 1 };

  for (const type of PRIORITY) {
    const best = candidates
      .filter((c) => c.type === type)
      .map((c) => ({ candidate: c, ratio: (stats.matches[c.key] ?? 0) / stats.nonEmpty }))
      .sort((a, b) => b.ratio - a.ratio)[0];
    if (best && best.ratio >= threshold) {
      return { type, candidate: best.candidate, confidence: best.ratio };
    }
  }
  return { type: 'TEXT', candidate: null, confidence: 1 };
}

/** Best candidate of a type the user forced, even below the threshold. */
export function candidateForOverride(
  type: ColumnType,
  stats: ColumnStats,
  candidates: Candidate[],
): InferredType {
  if (type === 'TEXT') return { type, candidate: null, confidence: 1 };
  const best = candidates
    .filter((c) => c.type === type)
    .map((c) => ({
      candidate: c,
      ratio: stats.nonEmpty ? (stats.matches[c.key] ?? 0) / stats.nonEmpty : 1,
    }))
    .sort((a, b) => b.ratio - a.ratio)[0];
  if (!best) throw new Error(`No candidate for type ${type}`);
  return { type, candidate: best.candidate, confidence: best.ratio };
}

export const SQL_TYPE: Record<ColumnType, string> = {
  TEXT: 'text',
  INTEGER: 'bigint',
  DECIMAL: 'numeric',
  BOOLEAN: 'boolean',
  DATE: 'date',
  TIMESTAMP: 'timestamp',
};

/**
 * SQL expression producing the typed value for one raw column. Empty strings become NULL.
 * A value that matches the pattern but still cannot be converted (31/02/2026) also becomes
 * NULL; it is counted as invalid and surfaced by data quality checks (raw value is kept).
 * `$tz` placeholders are replaced by the caller with a bind parameter.
 */
export function castExpression(rawColumn: string, inferred: InferredType): string {
  const trimmed = `NULLIF(btrim(${rawColumn}), '')`;
  if (inferred.type === 'TEXT' || !inferred.candidate) return `NULLIF(${rawColumn}, '')`;
  const { pattern, cast } = inferred.candidate;
  return `CASE WHEN ${trimmed} ~* '${pattern}' THEN ${cast(trimmed)} END`;
}
