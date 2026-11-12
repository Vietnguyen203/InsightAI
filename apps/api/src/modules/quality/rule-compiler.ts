import type {
  ColumnDataType,
  QualityDimension,
  RuleDefinition,
  Severity,
} from '@insightai/contracts';
import {
  type ColumnBinding,
  compileExpression,
  ExpressionError,
  sqlString,
  type ValueType,
} from '../expression/expression';

/**
 * Turns quality rule definitions into SQL (docs/DATA_QUALITY_DESIGN.md §4–5). Pure: identifiers
 * come from metadata and are quoted by the caller; literals from rules are escaped here.
 *
 * Row-level rules become a pair of predicates evaluated in ONE scan of the version table:
 *   evaluated = count(*) FILTER (WHERE applies)
 *   failed    = count(*) FILTER (WHERE applies AND fails)
 * Set-level rules (unique, duplicate rows, foreign key) need their own query.
 */

export class RuleDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleDefinitionError';
  }
}

export interface VersionColumn {
  name: string;
  dataType: ColumnDataType;
  /** Quoted reference into the typed table, e.g. t."c_3". */
  typedSql: string;
  /** Quoted reference into the raw (text) table, e.g. r."c_3", when the version has one. */
  rawSql: string | null;
}

export const VALUE_TYPE: Record<ColumnDataType, Exclude<ValueType, 'null'>> = {
  TEXT: 'text',
  INTEGER: 'number',
  DECIMAL: 'number',
  BOOLEAN: 'boolean',
  DATE: 'date',
  TIMESTAMP: 'timestamp',
};

export type CompiledRule =
  | {
      kind: 'row';
      applies: string;
      fails: string;
      sampleColumn: VersionColumn | null;
      needsRaw: boolean;
    }
  | { kind: 'groups'; keySql: string[]; sampleColumns: VersionColumn[] }
  | {
      kind: 'foreign_key';
      column: VersionColumn;
      /** Fully qualified, quoted reference table and column (same tenant schema). */
      refTable: string;
      refColumnSql: string;
    };

export interface ForeignKeyTarget {
  table: string;
  columnSql: string;
}

const NUMBER = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

function boundLiteral(column: VersionColumn, value: string): string {
  switch (column.dataType) {
    case 'INTEGER':
    case 'DECIMAL':
      if (!NUMBER.test(value)) throw new RuleDefinitionError(`"${value}" is not a number`);
      return `${value}::numeric`;
    case 'DATE':
      if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        throw new RuleDefinitionError(`"${value}" is not a date (yyyy-MM-dd)`);
      }
      return `DATE ${sqlString(value)}`;
    case 'TIMESTAMP':
      if (!TIMESTAMP.test(value) || Number.isNaN(Date.parse(value.replace(' ', 'T')))) {
        throw new RuleDefinitionError(`"${value}" is not a date-time (yyyy-MM-ddTHH:mm)`);
      }
      return `TIMESTAMP ${sqlString(value.replace('T', ' '))}`;
    default:
      throw new RuleDefinitionError(
        `A range rule needs a number or date column, "${column.name}" is ${column.dataType}`,
      );
  }
}

export function compileRule(
  definition: RuleDefinition,
  columns: ReadonlyMap<string, VersionColumn>,
  foreignKeyTarget?: ForeignKeyTarget,
): CompiledRule {
  const column = (name: string): VersionColumn => {
    const found = columns.get(name);
    if (!found) throw new RuleDefinitionError(`Column "${name}" does not exist in this version`);
    return found;
  };

  switch (definition.type) {
    case 'not_null': {
      const c = column(definition.column);
      const missing =
        c.dataType === 'TEXT'
          ? `(${c.typedSql} IS NULL OR btrim(${c.typedSql}) = '')`
          : `${c.typedSql} IS NULL`;
      return { kind: 'row', applies: 'true', fails: missing, sampleColumn: c, needsRaw: false };
    }
    case 'type_castable': {
      const c = column(definition.column);
      if (!c.rawSql)
        throw new RuleDefinitionError('This version has no raw values to compare with');
      if (c.dataType === 'TEXT') throw new RuleDefinitionError('Text columns accept every value');
      return {
        kind: 'row',
        applies: `NULLIF(btrim(${c.rawSql}), '') IS NOT NULL`,
        fails: `${c.typedSql} IS NULL`,
        sampleColumn: c,
        needsRaw: true,
      };
    }
    case 'regex': {
      const c = column(definition.column);
      if (c.dataType !== 'TEXT')
        throw new RuleDefinitionError('Pattern rules apply to text columns');
      return {
        kind: 'row',
        applies: `${c.typedSql} IS NOT NULL`,
        fails: `${c.typedSql} !~ ${sqlString(definition.pattern)}`,
        sampleColumn: c,
        needsRaw: false,
      };
    }
    case 'allowed_values': {
      const c = column(definition.column);
      const values = definition.caseSensitive
        ? definition.values.map(sqlString)
        : definition.values.map((v) => sqlString(v.toLowerCase()));
      const subject = definition.caseSensitive
        ? `${c.typedSql}::text`
        : `lower(${c.typedSql}::text)`;
      return {
        kind: 'row',
        applies: `${c.typedSql} IS NOT NULL`,
        fails: `${subject} NOT IN (${values.join(', ')})`,
        sampleColumn: c,
        needsRaw: false,
      };
    }
    case 'range': {
      const c = column(definition.column);
      const conditions: string[] = [];
      if (definition.min !== undefined)
        conditions.push(`${c.typedSql} < ${boundLiteral(c, definition.min)}`);
      if (definition.max !== undefined)
        conditions.push(`${c.typedSql} > ${boundLiteral(c, definition.max)}`);
      return {
        kind: 'row',
        applies: `${c.typedSql} IS NOT NULL`,
        fails: `(${conditions.join(' OR ')})`,
        sampleColumn: c,
        needsRaw: false,
      };
    }
    case 'length': {
      const c = column(definition.column);
      if (c.dataType !== 'TEXT')
        throw new RuleDefinitionError('Length rules apply to text columns');
      if (
        definition.min !== undefined &&
        definition.max !== undefined &&
        definition.min > definition.max
      ) {
        throw new RuleDefinitionError('min must not be greater than max');
      }
      const conditions: string[] = [];
      if (definition.min !== undefined)
        conditions.push(`length(${c.typedSql}) < ${definition.min}`);
      if (definition.max !== undefined)
        conditions.push(`length(${c.typedSql}) > ${definition.max}`);
      return {
        kind: 'row',
        applies: `${c.typedSql} IS NOT NULL`,
        fails: `(${conditions.join(' OR ')})`,
        sampleColumn: c,
        needsRaw: false,
      };
    }
    case 'expression': {
      try {
        const compiled = compileExpression(
          definition.expr,
          (name) => {
            const c = columns.get(name);
            return c
              ? ({ type: VALUE_TYPE[c.dataType], sql: c.typedSql } satisfies ColumnBinding)
              : undefined;
          },
          'boolean',
        );
        // NULL means "unknown" (e.g. a missing value): completeness rules report those, not this one.
        const first = compiled.columns[0];
        return {
          kind: 'row',
          applies: 'true',
          fails: `NOT coalesce(${compiled.sql}, true)`,
          sampleColumn: first ? (columns.get(first) ?? null) : null,
          needsRaw: false,
        };
      } catch (error) {
        if (error instanceof ExpressionError) throw new RuleDefinitionError(error.message);
        throw error;
      }
    }
    case 'unique': {
      const keys = definition.columns.map(column);
      return { kind: 'groups', keySql: keys.map((k) => k.typedSql), sampleColumns: keys };
    }
    case 'duplicate_rows': {
      const all = [...columns.values()];
      // One hash per row over every column; NULLs are part of the row identity.
      return {
        kind: 'groups',
        keySql: [`md5(row(${all.map((c) => c.typedSql).join(', ')})::text)`],
        sampleColumns: all.slice(0, 1),
      };
    }
    case 'foreign_key': {
      const c = column(definition.column);
      if (!foreignKeyTarget) throw new RuleDefinitionError('The referenced dataset has no data');
      return {
        kind: 'foreign_key',
        column: c,
        refTable: foreignKeyTarget.table,
        refColumnSql: foreignKeyTarget.columnSql,
      };
    }
  }
}

// ─── Scoring (docs/DATA_QUALITY_DESIGN.md §5.1) ─────────────────────────────

export interface ScoredResult {
  dimension: QualityDimension;
  severity: Severity;
  weight: number;
  threshold: number;
  status: 'PASSED' | 'FAILED' | 'SKIPPED' | 'ERROR';
  evaluated: number;
  failed: number;
}

const SEVERITY_MULTIPLIER: Record<Severity, number> = { info: 0.5, warning: 1, error: 2 };

export const passRate = (evaluated: number, failed: number) =>
  evaluated === 0 ? 1 : (evaluated - failed) / evaluated;

/** PASSED/FAILED from counts and the rule threshold. */
export function ruleStatus(
  evaluated: number,
  failed: number,
  threshold: number,
): 'PASSED' | 'FAILED' {
  return passRate(evaluated, failed) + 1e-12 >= threshold ? 'PASSED' : 'FAILED';
}

export function computeScore(results: ScoredResult[]): {
  score: number | null;
  dimensionScores: Partial<Record<QualityDimension, number | null>>;
  qualityStatus: 'PASSED' | 'WARNING' | 'FAILED';
  rulesFailed: number;
} {
  const scored = results.filter((r) => r.status === 'PASSED' || r.status === 'FAILED');
  const byDimension = new Map<QualityDimension, { sum: number; weights: number }>();
  for (const r of scored) {
    const w = r.weight * SEVERITY_MULTIPLIER[r.severity];
    const entry = byDimension.get(r.dimension) ?? { sum: 0, weights: 0 };
    entry.sum += w * passRate(r.evaluated, r.failed);
    entry.weights += w;
    byDimension.set(r.dimension, entry);
  }

  const dimensionScores: Partial<Record<QualityDimension, number | null>> = {};
  const present: number[] = [];
  for (const [dimension, { sum, weights }] of byDimension) {
    const value = weights > 0 ? roundScore((sum / weights) * 100) : null;
    dimensionScores[dimension] = value;
    if (value !== null) present.push(sum / weights);
  }
  const score =
    present.length > 0
      ? roundScore((present.reduce((a, b) => a + b, 0) / present.length) * 100)
      : null;

  const failed = scored.filter((r) => r.status === 'FAILED');
  // A failing error-severity rule fails the dataset whatever the score (a high score must not hide it).
  const qualityStatus = failed.some((r) => r.severity === 'error')
    ? 'FAILED'
    : failed.some((r) => r.severity === 'warning')
      ? 'WARNING'
      : 'PASSED';
  return { score, dimensionScores, qualityStatus, rulesFailed: failed.length };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
/** One decimal, but never 100 while some rows fail (99.95 → 99.9), so a perfect score means no errors. */
const roundScore = (n: number) => (n < 100 && round1(n) >= 100 ? 99.9 : round1(n));
