import type {
  ColumnDataType,
  Dimension,
  Entity,
  Measure,
  MetricDefinition,
  QueryColumn,
  Relationship,
  SemanticQueryFilter,
  SemanticQueryParsed,
} from '@insightai/contracts';
import { compileExpression, ExpressionError, type ValueType } from '../expression/expression';
import { SQL_TYPE } from '../import/type-inference';
import { VALUE_TYPE } from '../quality/rule-compiler';
import { exclusiveEnd, type ResolvedRange } from './date-range';

/**
 * Semantic Query IR → SQL (docs/SEMANTIC_LAYER_DESIGN.md §6). Pure and deterministic.
 *
 * Fan-out rule (§6.3): a measure is aggregated at the grain of its entity. From that entity the
 * planner only joins along many-to-one (and one-to-one) relationships, which never duplicate
 * source rows; a dimension reachable only through a one-to-many step is rejected (FANOUT_JOIN).
 *
 * Metrics expand to "leaves" (a measure plus the metric's filters). Leaves of the same entity and
 * filters share one aggregate CTE; different ones get their own, combined on the dimension values,
 * so no leaf is multiplied by another's join. Ratio and derived metrics are computed from the
 * combined leaves in an outer SELECT.
 */

export class QueryRejection extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'QueryRejection';
  }
}

export interface EntityData {
  /** Quoted, schema-qualified typed table of the dataset's active version. */
  table: string;
  versionId: string;
  columns: Map<string, { physicalName: string; dataType: ColumnDataType }>;
}

export interface PolicyRules {
  /** Names of the policies that apply to the user (for provenance). */
  names: string[];
  /** Member check (`entity.member` or `metric:<key>`); hidden members look unknown. */
  allows: (member: string) => boolean;
  /** Row filters combined with OR; null = no row restriction. */
  rowFilters: { entity: string; expr: string }[] | null;
}

/** The published version of a metric, as the planner needs it. */
export interface PlannedMetric {
  key: string;
  version: number;
  versionId: string;
  label: string;
  unit: string | null;
  format: 'number' | 'currency' | 'percent';
  definition: MetricDefinition;
}

export interface PlanInput {
  query: SemanticQueryParsed;
  entities: Entity[];
  relationships: Relationship[];
  /** Published metrics of the model by key. */
  metrics: Map<string, PlannedMetric>;
  /** Source data per entity id (missing = dataset unavailable). */
  data: Map<string, EntityData>;
  policy: PolicyRules;
  dateRange: ResolvedRange | null;
  /** Earlier period for `compareTo`. */
  compareRange: ResolvedRange | null;
}

export type SqlParam = string | number | boolean | null | (string | number | boolean)[];

export interface Plan {
  sql: string;
  params: SqlParam[];
  columns: QueryColumn[];
  /** Dataset versions read by the query (cache key and provenance). */
  datasetVersionIds: string[];
  /** Metric versions used, including those inside ratios/derived metrics. */
  metrics: PlannedMetric[];
}

const MAX_JOIN_HOPS = 3;
const MAX_METRIC_DEPTH = 10;
const NUMBER = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

const TYPE_OF: Record<Exclude<ValueType, 'null'>, ColumnDataType> = {
  text: 'TEXT',
  number: 'DECIMAL',
  boolean: 'BOOLEAN',
  date: 'DATE',
  timestamp: 'TIMESTAMP',
};
const VALUE_OF: Record<ColumnDataType, Exclude<ValueType, 'null'>> = VALUE_TYPE;

interface ResolvedDimension {
  ref: string;
  entity: Entity;
  dimension: Dimension;
}
interface ResolvedMeasure {
  ref: string;
  entity: Entity;
  measure: Measure;
}
interface ResolvedFilter {
  filter: SemanticQueryFilter;
  target: ResolvedDimension;
}

/** A measure with the filters of the metric that uses it. */
interface Leaf {
  index: number;
  measure: ResolvedMeasure;
  filters: ResolvedFilter[];
  type: ColumnDataType;
}

/** How an output value is computed from the leaves. */
type Node =
  | { kind: 'leaf'; leaf: Leaf }
  | { kind: 'ratio'; numerator: Node; denominator: Node }
  | { kind: 'derived'; expr: string; refs: Map<string, Node> };

interface Edge {
  to: string;
  relationship: Relationship;
  /** True when walking from the relationship's "to" side (one-to-one only). */
  reversed: boolean;
}

type Period = 'current' | 'previous';

export function planQuery(input: PlanInput): Plan {
  const { query, policy } = input;
  const byKey = new Map(input.entities.map((e) => [e.key, e]));
  const byId = new Map(input.entities.map((e) => [e.id, e]));
  const params: SqlParam[] = [];
  const param = (value: SqlParam, cast: string) => {
    params.push(value);
    return `$${params.length}::${cast}`;
  };

  // ─── 1. Resolve members ──────────────────────────────────────────────────────
  // `checked` = requested by the user: hidden by a policy → unknown (existence not revealed).
  // Members used inside a metric definition are part of the metric and are not checked.
  const split = (ref: string) => {
    const [entityKey = '', memberKey = ''] = ref.split('.');
    return { entity: byKey.get(entityKey), memberKey };
  };
  const dimension = (ref: string, checked = true): ResolvedDimension => {
    const { entity, memberKey } = split(ref);
    const found = entity?.dimensions.find((d) => d.key === memberKey);
    if (!entity || !found || (checked && !policy.allows(ref))) {
      const isMeasure =
        entity?.measures.some((m) => m.key === memberKey) && (!checked || policy.allows(ref));
      throw isMeasure
        ? new QueryRejection(
            'MEASURE_FILTER_NOT_SUPPORTED',
            `"${ref}" is a measure, not a dimension`,
          )
        : new QueryRejection('UNKNOWN_MEMBER', `Unknown dimension "${ref}"`);
    }
    return { ref, entity, dimension: found };
  };
  const measure = (ref: string, checked = true): ResolvedMeasure => {
    const { entity, memberKey } = split(ref);
    const found = entity?.measures.find((m) => m.key === memberKey);
    if (!entity || !found || (checked && !policy.allows(ref))) {
      throw new QueryRejection('UNKNOWN_MEMBER', `Unknown measure "${ref}"`);
    }
    return { ref, entity, measure: found };
  };

  // ─── 2. Expand metrics into leaves ──────────────────────────────────────────
  const leaves: Leaf[] = [];
  const leafByKey = new Map<string, Leaf>();
  const usedMetrics = new Map<string, PlannedMetric>();
  const timeDefaults = new Set<string>();

  const leafFor = (m: ResolvedMeasure, filters: ResolvedFilter[]): Leaf => {
    const key = JSON.stringify([m.ref, filters.map((f) => f.filter)]);
    const existing = leafByKey.get(key);
    if (existing) return existing;
    const leaf: Leaf = { index: leaves.length, measure: m, filters, type: 'DECIMAL' };
    leaves.push(leaf);
    leafByKey.set(key, leaf);
    return leaf;
  };
  const expand = (key: string, path: string[]): Node => {
    if (path.includes(key)) {
      throw new QueryRejection('METRIC_CYCLE', `Metric "${key}" depends on itself`);
    }
    if (path.length > MAX_METRIC_DEPTH) {
      throw new QueryRejection('METRIC_CYCLE', 'Metrics are nested too deeply');
    }
    const metric = input.metrics.get(key);
    if (!metric) throw new QueryRejection('UNKNOWN_METRIC', `Unknown metric "${key}"`);
    usedMetrics.set(key, metric);
    const def = metric.definition;
    switch (def.type) {
      case 'SIMPLE': {
        if (def.timeDimension) timeDefaults.add(def.timeDimension);
        const filters = def.filters.map((f) => ({ filter: f, target: dimension(f.member, false) }));
        return { kind: 'leaf', leaf: leafFor(measure(def.measure, false), filters) };
      }
      case 'RATIO':
        return {
          kind: 'ratio',
          numerator: expand(def.numerator, [...path, key]),
          denominator: expand(def.denominator, [...path, key]),
        };
      case 'DERIVED': {
        const refs = new Map<string, Node>();
        try {
          compileExpression(def.expr, (name) => {
            if (!refs.has(name)) refs.set(name, expand(name, [...path, key]));
            return { type: 'number', sql: 'x' };
          });
        } catch (error) {
          if (error instanceof ExpressionError) {
            throw new QueryRejection('INVALID_METRIC', `Metric "${key}": ${error.message}`);
          }
          throw error;
        }
        return { kind: 'derived', expr: def.expr, refs };
      }
    }
  };

  const outputsRequested: {
    key: string;
    kind: 'metric' | 'measure';
    node: Node;
    metric?: PlannedMetric;
    measure?: ResolvedMeasure;
  }[] = [];
  for (const key of unique(query.metrics, 'metric')) {
    if (!policy.allows(`metric:${key}`)) {
      throw new QueryRejection('UNKNOWN_METRIC', `Unknown metric "${key}"`);
    }
    outputsRequested.push({
      key,
      kind: 'metric',
      node: expand(key, []),
      metric: input.metrics.get(key)!,
    });
  }
  for (const ref of unique(query.measures, 'measure')) {
    const m = measure(ref);
    outputsRequested.push({
      key: ref,
      kind: 'measure',
      node: { kind: 'leaf', leaf: leafFor(m, []) },
      measure: m,
    });
  }

  // ─── 3. Dimensions, time, filters ───────────────────────────────────────────
  const groupDims = unique(query.dimensions, 'dimension').map((ref) => dimension(ref));
  const td = query.timeDimension;
  let time: ResolvedDimension | null = null;
  if (td) {
    let ref = td.dimension;
    if (!ref) {
      if (timeDefaults.size !== 1) {
        throw new QueryRejection(
          timeDefaults.size === 0 ? 'TIME_DIMENSION_REQUIRED' : 'TIME_DIMENSION_AMBIGUOUS',
          timeDefaults.size === 0
            ? 'Name the time dimension: the metrics have no default one'
            : 'The metrics use different time dimensions; name one',
        );
      }
      ref = [...timeDefaults][0]!;
    }
    // A metric's default time dimension is part of its definition (no policy check).
    time = dimension(ref, td.dimension !== undefined);
    if (time.dimension.type !== 'TIME') {
      throw new QueryRejection('NOT_A_TIME_DIMENSION', `"${time.ref}" is not a time dimension`);
    }
    if (groupDims.some((d) => d.ref === time!.ref)) {
      throw new QueryRejection('DUPLICATE_MEMBER', `"${time.ref}" is already the time dimension`);
    }
    if (td.granularity && !time.dimension.granularities.includes(td.granularity)) {
      throw new QueryRejection(
        'GRANULARITY_NOT_ALLOWED',
        `"${time.ref}" cannot be grouped by ${td.granularity}`,
      );
    }
    if (td.compareTo && (!input.dateRange || td.granularity)) {
      throw new QueryRejection(
        'COMPARE_NOT_SUPPORTED',
        'compareTo needs a date range and no granularity',
      );
    }
  }
  const filters: ResolvedFilter[] = query.filters.map((f) => ({
    filter: f,
    target: dimension(f.member),
  }));
  const granularity = td?.granularity ?? null;
  const periods: Period[] =
    td?.compareTo && input.compareRange ? ['current', 'previous'] : ['current'];

  const policyEntities = (policy.rowFilters ?? []).map((f) => {
    const entity = byKey.get(f.entity);
    if (!entity || !input.data.has(entity.id)) {
      throw new QueryRejection('POLICY_NOT_ENFORCEABLE', 'An access policy cannot be applied');
    }
    return entity;
  });

  const touched = new Set<Entity>([
    ...leaves.map((l) => l.measure.entity),
    ...leaves.flatMap((l) => l.filters.map((f) => f.target.entity)),
    ...groupDims.map((d) => d.entity),
    ...filters.map((f) => f.target.entity),
    ...(time ? [time.entity] : []),
  ]);
  for (const e of touched) {
    if (!input.data.has(e.id)) {
      throw new QueryRejection('DATA_UNAVAILABLE', `The data of "${e.key}" is not available`);
    }
  }

  // ─── 4. Dimension columns ────────────────────────────────────────────────────
  const dimColumns: { name: string; column: QueryColumn }[] = [];
  const plain = { comparison: false, unit: null, format: null };
  if (time && granularity) {
    dimColumns.push({
      name: 't0',
      column: {
        key: time.ref,
        name: time.dimension.name,
        kind: 'time',
        granularity,
        type: 'DATE',
        ...plain,
      },
    });
  }
  groupDims.forEach((d, i) =>
    dimColumns.push({
      name: `d${i}`,
      column: {
        key: d.ref,
        name: d.dimension.name,
        kind: 'dimension',
        granularity: null,
        type: dimensionType(d, input.data.get(d.entity.id)!),
        ...plain,
      },
    }),
  );

  // ─── 5. One aggregate CTE per (entity, metric filters, period) ──────────────
  const graph = buildGraph(input.relationships);
  const anyPath = buildUndirected(input.relationships);
  const groups = new Map<string, Leaf[]>();
  for (const leaf of leaves) {
    const key = JSON.stringify([leaf.measure.entity.id, leaf.filters.map((f) => f.filter)]);
    groups.set(key, [...(groups.get(key) ?? []), leaf]);
  }
  const leafColumn = (leaf: Leaf, period: Period) =>
    `${period === 'current' ? 'm' : 'p'}${leaf.index}`;

  const ctes: { name: string; columns: string[] }[] = [];
  const cteSql: string[] = [];
  for (const period of periods) {
    const range = period === 'current' ? input.dateRange : input.compareRange;
    for (const group of groups.values()) {
      const source = group[0]!.measure.entity;
      const name = `s${ctes.length}`;
      const required = new Set<string>([
        ...groupDims.map((d) => d.entity.id),
        ...filters.map((f) => f.target.entity.id),
        ...group[0]!.filters.map((f) => f.target.entity.id),
        ...(time ? [time.entity.id] : []),
        ...policyEntities.map((e) => e.id),
      ]);
      required.delete(source.id);
      const joins = planJoins(source, [...required], graph, anyPath, byId);

      const aliasOf = new Map<string, string>([[source.id, 'e0']]);
      joins.forEach((j, i) => aliasOf.set(j.entityId, `e${i + 1}`));
      const exprFor = (entity: Entity, expr: string) => {
        const data = input.data.get(entity.id)!;
        const alias = aliasOf.get(entity.id)!;
        try {
          return compileExpression(expr, (n) => {
            const c = data.columns.get(n);
            return c
              ? { type: VALUE_TYPE[c.dataType], sql: `${alias}."${c.physicalName}"` }
              : undefined;
          });
        } catch (error) {
          if (error instanceof ExpressionError) {
            throw new QueryRejection(
              'DATA_UNAVAILABLE',
              `"${entity.key}" no longer matches its data: ${error.message}`,
            );
          }
          throw error;
        }
      };

      const select: string[] = [];
      const groupBy: string[] = [];
      if (time && granularity) {
        const bucket = `date_trunc('${granularity}', ${exprFor(time.entity, time.dimension.expr).sql})::date`;
        select.push(`${bucket} AS "t0"`);
        groupBy.push(bucket);
      }
      groupDims.forEach((d, i) => {
        const sql = exprFor(d.entity, d.dimension.expr).sql;
        select.push(`${sql} AS "d${i}"`);
        groupBy.push(sql);
      });
      const columns: string[] = [];
      for (const leaf of group) {
        const compiled = leaf.measure.measure.expr
          ? exprFor(leaf.measure.entity, leaf.measure.measure.expr)
          : null;
        const { sql, type } = aggregate(leaf.measure, compiled);
        leaf.type = type;
        const col = leafColumn(leaf, period);
        columns.push(col);
        select.push(`(${sql})::${SQL_TYPE[type]} AS "${col}"`);
      }

      const where: string[] = [];
      if (time && range) {
        const sql = exprFor(time.entity, time.dimension.expr).sql;
        where.push(`${sql} >= ${param(range.from, 'date')}`);
        where.push(`${sql} < ${param(exclusiveEnd(range), 'date')}`);
      }
      for (const { filter, target } of [...group[0]!.filters, ...filters]) {
        const compiled = exprFor(target.entity, target.dimension.expr);
        where.push(filterSql(filter, compiled.sql, compiled.type, param));
      }
      if (policy.rowFilters) {
        // Fail closed: a policy filter that does not compile hides every row.
        const alternatives = policy.rowFilters.map((f) => {
          try {
            return `coalesce((${exprFor(byKey.get(f.entity)!, f.expr).sql}), false)`;
          } catch {
            return 'false';
          }
        });
        where.push(`(${alternatives.join(' OR ')})`);
      }

      const from = [`${input.data.get(source.id)!.table} e0`];
      joins.forEach((j, i) => {
        const parent = aliasOf.get(j.fromEntityId)!;
        const child = `e${i + 1}`;
        const fromData = input.data.get(j.fromEntityId)!;
        const toData = input.data.get(j.entityId)!;
        const on = j.pairs.map((p) => {
          const left = fromData.columns.get(p.from);
          const right = toData.columns.get(p.to);
          if (!left || !right) {
            throw new QueryRejection(
              'DATA_UNAVAILABLE',
              'A relationship no longer matches its data',
            );
          }
          return `${parent}."${left.physicalName}" = ${child}."${right.physicalName}"`;
        });
        from.push(`LEFT JOIN ${toData.table} ${child} ON ${on.join(' AND ')}`);
      });

      ctes.push({ name, columns });
      cteSql.push(
        `${name} AS (SELECT ${select.join(', ')} FROM ${from.join(' ')}` +
          (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
          (groupBy.length > 0 ? ` GROUP BY ${groupBy.join(', ')}` : '') +
          ')',
      );
    }
  }

  // ─── 6. Combine the CTEs on the dimension values (GROUP BY treats NULL keys as equal) ──
  const dimNames = dimColumns.map((d) => `"${d.name}"`);
  const valueColumns = periods.flatMap((period) =>
    leaves.map((leaf) => ({ name: leafColumn(leaf, period), sqlType: SQL_TYPE[leaf.type] })),
  );
  let body: string;
  if (ctes.length === 1) {
    body = `SELECT * FROM ${ctes[0]!.name}`;
  } else {
    const branches = ctes.map((cte) => {
      const cols = valueColumns.map((v) =>
        cte.columns.includes(v.name) ? `"${v.name}"` : `NULL::${v.sqlType} AS "${v.name}"`,
      );
      return `SELECT ${[...dimNames, ...cols].join(', ')} FROM ${cte.name}`;
    });
    // Each branch holds at most one row per dimension combination, so max() just picks it.
    body =
      `SELECT ${[...dimNames, ...valueColumns.map((v) => `max("${v.name}") AS "${v.name}"`)].join(', ')} ` +
      `FROM (${branches.join(' UNION ALL ')}) u` +
      (dimNames.length > 0 ? ` GROUP BY ${dimNames.join(', ')}` : '');
  }

  // ─── 7. Output values (ratios and derived metrics on top of the leaves) ─────
  const render = (node: Node, period: Period): { sql: string; type: ColumnDataType } => {
    switch (node.kind) {
      case 'leaf':
        return { sql: `r."${leafColumn(node.leaf, period)}"`, type: node.leaf.type };
      case 'ratio': {
        const n = render(node.numerator, period);
        const d = render(node.denominator, period);
        if (VALUE_OF[n.type] !== 'number' || VALUE_OF[d.type] !== 'number') {
          throw new QueryRejection('INVALID_METRIC', 'A ratio needs numeric metrics');
        }
        // trim_scale drops the trailing zeros of the division (100.0000… → 100).
        return {
          sql: `trim_scale((${n.sql})::numeric / NULLIF((${d.sql})::numeric, 0))`,
          type: 'DECIMAL',
        };
      }
      case 'derived': {
        const compiled = compileExpression(node.expr, (name) => {
          const child = node.refs.get(name);
          if (!child) return undefined;
          const value = render(child, period);
          return { type: VALUE_OF[value.type], sql: `(${value.sql})` };
        });
        if (compiled.type !== 'number' && compiled.type !== 'null') {
          throw new QueryRejection('INVALID_METRIC', 'A derived metric must produce a number');
        }
        return { sql: `trim_scale((${compiled.sql})::numeric)`, type: 'DECIMAL' };
      }
    }
  };

  const outputs: { key: string; sqlName: string; column: QueryColumn }[] = dimColumns.map((d) => ({
    key: d.column.key,
    sqlName: d.name,
    column: d.column,
  }));
  const select = [...dimColumns.map((d) => `r."${d.name}"`)];
  outputsRequested.forEach((o, i) => {
    for (const period of periods) {
      const value = render(o.node, period);
      const sqlName = `${period === 'current' ? 'o' : 'c'}${i}`;
      select.push(`${value.sql} AS "${sqlName}"`);
      outputs.push({
        key: o.key,
        sqlName,
        column: {
          key: o.key,
          name: o.metric?.label ?? o.measure!.measure.name,
          kind: o.kind,
          granularity: null,
          type: value.type,
          comparison: period === 'previous',
          unit: o.metric?.unit ?? null,
          format: o.metric?.format ?? null,
        },
      });
    }
  });

  // ─── 8. Order: requested columns, then every dimension column for a stable result ──
  const order: string[] = [];
  for (const o of query.orderBy) {
    const out = outputs.find((x) => x.key === o.member && !x.column.comparison);
    if (!out) {
      throw new QueryRejection(
        'ORDER_NOT_IN_RESULT',
        `"${o.member}" is not a column of the result`,
      );
    }
    order.push(`"${out.sqlName}" ${o.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`);
  }
  for (const d of dimColumns) {
    if (!query.orderBy.some((o) => o.member === d.column.key))
      order.push(`"${d.name}" ASC NULLS LAST`);
  }

  const sql =
    `WITH ${cteSql.join(', ')} SELECT ${select.join(', ')} FROM (${body}) r` +
    (order.length > 0 ? ` ORDER BY ${order.join(', ')}` : '') +
    ` LIMIT ${query.limit + 1}`;

  const used = new Set<string>([...touched].map((e) => e.id));
  for (const e of policyEntities) used.add(e.id);
  return {
    sql,
    params,
    columns: outputs.map((o) => o.column),
    datasetVersionIds: [...used].map((id) => input.data.get(id)!.versionId).sort(),
    metrics: [...usedMetrics.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

// ─── Joins ─────────────────────────────────────────────────────────────────────

function buildGraph(relationships: Relationship[]): Map<string, Edge[]> {
  // Parallel relationships between the same entities: the preferred one wins (validation
  // guarantees exactly one is preferred when there are several).
  const chosen = new Map<string, Relationship>();
  for (const r of relationships) {
    const key = [r.fromEntityId, r.toEntityId].sort().join('|');
    const current = chosen.get(key);
    if (!current || (r.preferred && !current.preferred)) chosen.set(key, r);
  }
  const graph = new Map<string, Edge[]>();
  const add = (from: string, edge: Edge) => graph.set(from, [...(graph.get(from) ?? []), edge]);
  for (const r of chosen.values()) {
    add(r.fromEntityId, { to: r.toEntityId, relationship: r, reversed: false });
    if (r.cardinality === 'ONE_TO_ONE') {
      add(r.toEntityId, { to: r.fromEntityId, relationship: r, reversed: true });
    }
  }
  return graph;
}

function buildUndirected(relationships: Relationship[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const r of relationships) {
    graph.set(r.fromEntityId, (graph.get(r.fromEntityId) ?? new Set()).add(r.toEntityId));
    graph.set(r.toEntityId, (graph.get(r.toEntityId) ?? new Set()).add(r.fromEntityId));
  }
  return graph;
}

interface Join {
  entityId: string;
  fromEntityId: string;
  pairs: { from: string; to: string }[];
}

/** Unique shortest safe path from the source to each required entity, merged into a join tree. */
function planJoins(
  source: Entity,
  targets: string[],
  graph: Map<string, Edge[]>,
  anyPath: Map<string, Set<string>>,
  byId: Map<string, Entity>,
): Join[] {
  const joins: Join[] = [];
  const parentOf = new Map<string, string>();
  for (const target of targets) {
    const path = shortestUniquePath(source.id, target, graph, byId);
    if (!path) {
      const reachable = connected(source.id, target, anyPath);
      const key = byId.get(target)!.key;
      throw reachable
        ? new QueryRejection(
            'FANOUT_JOIN',
            `"${key}" can only be reached from "${source.key}" through a one-to-many relationship, which would count rows several times`,
          )
        : new QueryRejection('NOT_REACHABLE', `"${key}" is not related to "${source.key}"`);
    }
    let from = source.id;
    for (const edge of path) {
      const known = parentOf.get(edge.to);
      if (known !== undefined && known !== from) {
        throw new QueryRejection(
          'AMBIGUOUS_JOIN_PATH',
          `"${byId.get(edge.to)!.key}" is reached along different paths`,
        );
      }
      if (known === undefined && edge.to !== source.id) {
        parentOf.set(edge.to, from);
        joins.push({
          entityId: edge.to,
          fromEntityId: from,
          pairs: edge.reversed
            ? edge.relationship.joinColumns.map((p) => ({ from: p.to, to: p.from }))
            : edge.relationship.joinColumns,
        });
      }
      from = edge.to;
    }
  }
  return joins;
}

function shortestUniquePath(
  from: string,
  to: string,
  graph: Map<string, Edge[]>,
  byId: Map<string, Entity>,
): Edge[] | null {
  // BFS counting shortest paths; two of the same length make the join ambiguous.
  let frontier: { node: string; path: Edge[] }[] = [{ node: from, path: [] }];
  const seen = new Set([from]);
  for (let depth = 0; depth < MAX_JOIN_HOPS; depth++) {
    const next: { node: string; path: Edge[] }[] = [];
    for (const { node, path } of frontier) {
      for (const edge of graph.get(node) ?? []) {
        if (seen.has(edge.to)) continue;
        next.push({ node: edge.to, path: [...path, edge] });
      }
    }
    const hits = next.filter((n) => n.node === to);
    if (hits.length > 1) {
      throw new QueryRejection(
        'AMBIGUOUS_JOIN_PATH',
        `"${byId.get(to)!.key}" can be reached along several paths; mark one relationship as preferred`,
      );
    }
    if (hits.length === 1) return hits[0]!.path;
    for (const n of next) seen.add(n.node);
    frontier = next;
  }
  return null;
}

function connected(a: string, b: string, graph: Map<string, Set<string>>): boolean {
  const seen = new Set([a]);
  const stack = [a];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === b) return true;
    for (const next of graph.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

// ─── Expressions ───────────────────────────────────────────────────────────────

function dimensionType(d: ResolvedDimension, data: EntityData): ColumnDataType {
  const column = data.columns.get(d.dimension.expr.trim().toLowerCase());
  if (column) return column.dataType;
  try {
    const type = compileExpression(d.dimension.expr, (name) => {
      const c = data.columns.get(name);
      return c ? { type: VALUE_TYPE[c.dataType], sql: 'x' } : undefined;
    }).type;
    return type === 'null' ? 'TEXT' : TYPE_OF[type];
  } catch {
    return 'TEXT';
  }
}

function aggregate(
  m: ResolvedMeasure,
  compiled: { sql: string; type: ValueType } | null,
): { sql: string; type: ColumnDataType } {
  const expr = compiled?.sql ?? '*';
  const exprType: ColumnDataType =
    compiled && compiled.type !== 'null' ? TYPE_OF[compiled.type] : 'DECIMAL';
  switch (m.measure.agg) {
    case 'count':
      return { sql: `count(${expr})`, type: 'INTEGER' };
    case 'count_distinct':
      return { sql: `count(DISTINCT ${expr})`, type: 'INTEGER' };
    case 'sum':
      return { sql: `sum(${expr})`, type: 'DECIMAL' };
    case 'avg':
      return { sql: `avg(${expr})`, type: 'DECIMAL' };
    case 'min':
    case 'max':
      return { sql: `${m.measure.agg}(${expr})`, type: exprType };
    default:
      throw new QueryRejection(
        'UNKNOWN_MEMBER',
        `Unsupported aggregation "${String(m.measure.agg)}"`,
      );
  }
}

function filterSql(
  filter: SemanticQueryFilter,
  sql: string,
  type: ValueType,
  param: (value: SqlParam, cast: string) => string,
): string {
  const kind = type === 'null' ? 'text' : type;
  const cast = {
    text: 'text',
    number: 'numeric',
    boolean: 'boolean',
    date: 'date',
    timestamp: 'timestamp',
  }[kind];
  const values = (filter.values ?? []).map((v) => typedValue(filter.member, kind, v));
  const one = () => param(values[0]!, cast);
  switch (filter.op) {
    case 'is_null':
      return `${sql} IS NULL`;
    case 'not_null':
      return `${sql} IS NOT NULL`;
    case 'eq':
      return `${sql} = ${one()}`;
    case 'neq':
      return `${sql} <> ${one()}`;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (kind === 'boolean' || kind === 'text') {
        throw new QueryRejection(
          'INVALID_FILTER',
          `"${filter.op}" needs a number or date dimension`,
        );
      }
      const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[filter.op];
      return `${sql} ${op} ${one()}`;
    }
    case 'in':
      return `${sql} = ANY(${param(values, `${cast}[]`)})`;
    case 'not_in':
      return `NOT (${sql} = ANY(${param(values, `${cast}[]`)}))`;
    case 'contains': {
      if (kind !== 'text') {
        throw new QueryRejection('INVALID_FILTER', '"contains" needs a text dimension');
      }
      // The value is a literal substring: escape LIKE wildcards.
      const escaped = String(values[0]).replace(/[\\%_]/g, (c) => `\\${c}`);
      return `${sql} ILIKE '%' || ${param(escaped, 'text')} || '%'`;
    }
  }
}

function typedValue(
  member: string,
  kind: Exclude<ValueType, 'null'>,
  value: string | number | boolean,
) {
  const bad = () => {
    throw new QueryRejection(
      'INVALID_FILTER',
      `"${String(value)}" is not a valid value for "${member}"`,
    );
  };
  switch (kind) {
    case 'text':
      return String(value);
    case 'number':
      if (typeof value === 'number') return value;
      return typeof value === 'string' && NUMBER.test(value) ? value : bad();
    case 'boolean':
      if (typeof value === 'boolean') return value;
      return value === 'true' ? true : value === 'false' ? false : bad();
    case 'date':
      return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value))
        ? value
        : bad();
    case 'timestamp':
      return typeof value === 'string' &&
        (TIMESTAMP.test(value) || DATE.test(value)) &&
        !Number.isNaN(Date.parse(value))
        ? value
        : bad();
  }
}

function unique(values: string[], what: string): string[] {
  if (new Set(values).size !== values.length) {
    throw new QueryRejection('DUPLICATE_MEMBER', `A ${what} is listed more than once`);
  }
  return values;
}
