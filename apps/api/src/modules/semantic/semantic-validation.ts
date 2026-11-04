import type {
  ColumnDataType,
  Entity,
  Relationship,
  SemanticValidationIssue,
  SemanticValidationStatus,
} from '@insightai/contracts';
import { compileExpression, ExpressionError, type ValueType } from '../expression/expression';
import { VALUE_TYPE } from '../quality/rule-compiler';

/**
 * Static checks of a semantic model (docs/SEMANTIC_LAYER_DESIGN.md §7, checks 1, 2, 4-types and 5).
 * Pure: the caller supplies each entity's source columns; data checks (key uniqueness, orphans)
 * are planned here and executed by the service.
 */

export interface SourceColumn {
  name: string;
  physicalName: string;
  dataType: ColumnDataType;
}

export interface EntitySource {
  entity: Entity;
  /** Null when the dataset is archived or has no active version. */
  columns: SourceColumn[] | null;
  /** Quoted, schema-qualified typed table of the active version. */
  table: string | null;
  datasetQualityFailed: boolean;
}

export interface KeyCheck {
  kind: 'primary_key' | 'relationship_one_side' | 'relationship_from_side';
  path: string;
  table: string;
  columns: string[];
}

export interface OrphanCheck {
  path: string;
  fromTable: string;
  toTable: string;
  pairs: { from: string; to: string }[];
}

export interface StaticResult {
  issues: SemanticValidationIssue[];
  keyChecks: KeyCheck[];
  orphanChecks: OrphanCheck[];
}

const issue = (
  severity: 'error' | 'warning',
  code: string,
  message: string,
  path: string | null,
): SemanticValidationIssue => ({ severity, code, message, path });

export function checkModel(sources: EntitySource[], relationships: Relationship[]): StaticResult {
  const issues: SemanticValidationIssue[] = [];
  const keyChecks: KeyCheck[] = [];
  const orphanChecks: OrphanCheck[] = [];

  if (sources.length === 0) {
    issues.push(issue('error', 'MODEL_EMPTY', 'The model has no entity', null));
  }

  const byId = new Map(sources.map((s) => [s.entity.id, s]));
  const columnsOf = (s: EntitySource) => new Map((s.columns ?? []).map((c) => [c.name, c]));

  for (const source of sources) {
    const { entity } = source;
    if (!source.columns || !source.table) {
      issues.push(
        issue(
          'error',
          'DATASET_UNAVAILABLE',
          `The dataset of "${entity.key}" is archived or has no data`,
          entity.key,
        ),
      );
      continue;
    }
    if (source.datasetQualityFailed) {
      issues.push(
        issue(
          'warning',
          'DATASET_QUALITY_FAILED',
          `The data of "${entity.key}" failed an error-level quality rule`,
          entity.key,
        ),
      );
    }
    const columns = columnsOf(source);
    const scope = (name: string) => {
      const c = columns.get(name);
      return c ? { type: VALUE_TYPE[c.dataType], sql: `t."${c.physicalName}"` } : undefined;
    };

    const missingKey = entity.primaryKey.filter((k) => !columns.has(k));
    if (missingKey.length > 0) {
      issues.push(
        issue(
          'error',
          'COLUMN_NOT_FOUND',
          `Primary key column(s) not found: ${missingKey.join(', ')}`,
          entity.key,
        ),
      );
    } else {
      keyChecks.push({
        kind: 'primary_key',
        path: entity.key,
        table: source.table,
        columns: entity.primaryKey.map((k) => columns.get(k)!.physicalName),
      });
    }

    for (const d of entity.dimensions) {
      const path = `${entity.key}.${d.key}`;
      const type = expressionType(d.expr, scope, path, issues);
      if (type && d.type === 'TIME' && type !== 'date' && type !== 'timestamp' && type !== 'null') {
        issues.push(
          issue('error', 'TIME_DIMENSION_TYPE', `A time dimension needs a date, got ${type}`, path),
        );
      }
    }
    for (const m of entity.measures) {
      const path = `${entity.key}.${m.key}`;
      if (m.expr === null) continue; // count(*)
      const type = expressionType(m.expr, scope, path, issues);
      if (!type || type === 'null') continue;
      if ((m.agg === 'sum' || m.agg === 'avg') && type !== 'number') {
        issues.push(issue('error', 'MEASURE_TYPE', `${m.agg} needs a number, got ${type}`, path));
      } else if ((m.agg === 'min' || m.agg === 'max') && type === 'boolean') {
        issues.push(issue('error', 'MEASURE_TYPE', `${m.agg} cannot use a true/false value`, path));
      }
    }
  }

  // Relationships: columns, types, uniqueness of the "one" side, orphans.
  for (const r of relationships) {
    const path = `relationship:${r.id}`;
    const from = byId.get(r.fromEntityId);
    const to = byId.get(r.toEntityId);
    if (!from?.columns || !to?.columns || !from.table || !to.table) continue; // reported above
    const fromCols = columnsOf(from);
    const toCols = columnsOf(to);
    const pairs: { from: string; to: string }[] = [];
    for (const pair of r.joinColumns) {
      const f = fromCols.get(pair.from);
      const t = toCols.get(pair.to);
      if (!f || !t) {
        issues.push(
          issue(
            'error',
            'COLUMN_NOT_FOUND',
            `Join column not found: ${!f ? `${from.entity.key}.${pair.from}` : `${to.entity.key}.${pair.to}`}`,
            path,
          ),
        );
        continue;
      }
      if (VALUE_TYPE[f.dataType] !== VALUE_TYPE[t.dataType]) {
        issues.push(
          issue(
            'error',
            'JOIN_TYPE_MISMATCH',
            `${from.entity.key}.${pair.from} (${f.dataType}) cannot be joined to ${to.entity.key}.${pair.to} (${t.dataType})`,
            path,
          ),
        );
        continue;
      }
      pairs.push({ from: f.physicalName, to: t.physicalName });
    }
    if (pairs.length !== r.joinColumns.length) continue;

    const toColumns = pairs.map((p) => p.to);
    // The primary key check already covers a join on exactly the key of the "one" side.
    const isToKey = sameSet(
      r.joinColumns.map((p) => p.to),
      to.entity.primaryKey,
    );
    if (!isToKey) {
      keyChecks.push({ kind: 'relationship_one_side', path, table: to.table, columns: toColumns });
    }
    if (r.cardinality === 'ONE_TO_ONE') {
      keyChecks.push({
        kind: 'relationship_from_side',
        path,
        table: from.table,
        columns: pairs.map((p) => p.from),
      });
    }
    orphanChecks.push({ path, fromTable: from.table, toTable: to.table, pairs });
  }

  issues.push(...checkGraph(sources, relationships));
  return { issues, keyChecks, orphanChecks };
}

/** Ambiguous parallel relationships (errors) and cycles = several join paths (warnings). */
export function checkGraph(
  sources: EntitySource[],
  relationships: Relationship[],
): SemanticValidationIssue[] {
  const issues: SemanticValidationIssue[] = [];
  const keyOf = new Map(sources.map((s) => [s.entity.id, s.entity.key]));
  const pairs = new Map<string, Relationship[]>();
  for (const r of relationships) {
    const pair = [r.fromEntityId, r.toEntityId].sort().join('|');
    pairs.set(pair, [...(pairs.get(pair) ?? []), r]);
  }
  for (const group of pairs.values()) {
    if (group.length > 1 && group.filter((r) => r.preferred).length !== 1) {
      const [a, b] = [keyOf.get(group[0]!.fromEntityId), keyOf.get(group[0]!.toEntityId)];
      issues.push(
        issue(
          'error',
          'RELATIONSHIP_AMBIGUOUS',
          `${group.length} relationships connect "${a}" and "${b}"; mark exactly one as preferred`,
          `relationship:${group[0]!.id}`,
        ),
      );
    }
  }

  // Union-find over entity pairs (one edge per pair): an edge joining two connected entities
  // closes a cycle, i.e. two entities can be joined along different paths.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  for (const group of pairs.values()) {
    const r = group[0]!;
    const [a, b] = [find(r.fromEntityId), find(r.toEntityId)];
    if (a === b) {
      issues.push(
        issue(
          'warning',
          'RELATIONSHIP_CYCLE',
          `"${keyOf.get(r.fromEntityId)}" and "${keyOf.get(r.toEntityId)}" can be joined along several paths`,
          `relationship:${r.id}`,
        ),
      );
    } else {
      parent.set(a, b);
    }
  }
  return issues;
}

export function overallStatus(issues: SemanticValidationIssue[]): SemanticValidationStatus {
  if (issues.some((i) => i.severity === 'error')) return 'INVALID';
  if (issues.length > 0) return 'WARNING';
  return 'VALID';
}

function expressionType(
  expr: string,
  scope: (name: string) => { type: Exclude<ValueType, 'null'>; sql: string } | undefined,
  path: string,
  issues: SemanticValidationIssue[],
): ValueType | null {
  try {
    return compileExpression(expr, scope).type;
  } catch (error) {
    if (!(error instanceof ExpressionError)) throw error;
    issues.push(issue('error', 'EXPRESSION_INVALID', error.message, path));
    return null;
  }
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}
