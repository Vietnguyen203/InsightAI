import type {
  ColumnDataType,
  Dimension,
  Entity,
  Measure,
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
 * Measures of different entities are aggregated separately (one CTE each) and combined on the
 * dimension values, so neither can be multiplied by the other's join.
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
  /** Member check; members outside it behave as if they did not exist. */
  allows: (member: string) => boolean;
  /** Row filters combined with OR; null = no row restriction. */
  rowFilters: { entity: string; expr: string }[] | null;
}

export interface PlanInput {
  query: SemanticQueryParsed;
  entities: Entity[];
  relationships: Relationship[];
  /** Source data per entity id (missing = dataset unavailable). */
  data: Map<string, EntityData>;
  policy: PolicyRules;
  dateRange: ResolvedRange | null;
}

export type SqlParam = string | number | boolean | null | (string | number | boolean)[];

export interface Plan {
  sql: string;
  params: SqlParam[];
  columns: QueryColumn[];
  /** Dataset versions read by the query (cache key and provenance). */
  datasetVersionIds: string[];
}

const MAX_JOIN_HOPS = 3;
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

interface Edge {
  to: string;
  relationship: Relationship;
  /** True when walking from the relationship's "to" side (one-to-one only). */
  reversed: boolean;
}

export function planQuery(input: PlanInput): Plan {
  const { query, policy } = input;
  const byKey = new Map(input.entities.map((e) => [e.key, e]));
  const byId = new Map(input.entities.map((e) => [e.id, e]));
  const params: SqlParam[] = [];
  const param = (value: SqlParam, cast: string) => {
    params.push(value);
    return `$${params.length}::${cast}`;
  };

  // 1. Resolve members (members hidden by a policy look unknown: their existence is not revealed).
  const split = (ref: string) => {
    const [entityKey = '', memberKey = ''] = ref.split('.');
    const entity = byKey.get(entityKey);
    return { entity, memberKey };
  };
  const dimension = (ref: string): ResolvedDimension => {
    const { entity, memberKey } = split(ref);
    const found = entity?.dimensions.find((d) => d.key === memberKey);
    if (!entity || !found || !policy.allows(ref)) {
      const isMeasure = entity?.measures.some((m) => m.key === memberKey) && policy.allows(ref);
      throw isMeasure
        ? new QueryRejection(
            'MEASURE_FILTER_NOT_SUPPORTED',
            `"${ref}" is a measure, not a dimension`,
          )
        : new QueryRejection('UNKNOWN_MEMBER', `Unknown dimension "${ref}"`);
    }
    return { ref, entity, dimension: found };
  };
  const measure = (ref: string): ResolvedMeasure => {
    const { entity, memberKey } = split(ref);
    const found = entity?.measures.find((m) => m.key === memberKey);
    if (!entity || !found || !policy.allows(ref)) {
      throw new QueryRejection('UNKNOWN_MEMBER', `Unknown measure "${ref}"`);
    }
    return { ref, entity, measure: found };
  };

  const measures = unique(query.measures, 'measure').map(measure);
  const groupDims = unique(query.dimensions, 'dimension').map(dimension);
  const time = query.timeDimension ? dimension(query.timeDimension.dimension) : null;
  if (time) {
    if (time.dimension.type !== 'TIME') {
      throw new QueryRejection('NOT_A_TIME_DIMENSION', `"${time.ref}" is not a time dimension`);
    }
    if (groupDims.some((d) => d.ref === time.ref)) {
      throw new QueryRejection('DUPLICATE_MEMBER', `"${time.ref}" is already the time dimension`);
    }
    const granularity = query.timeDimension?.granularity;
    if (granularity && !time.dimension.granularities.includes(granularity)) {
      throw new QueryRejection(
        'GRANULARITY_NOT_ALLOWED',
        `"${time.ref}" cannot be grouped by ${granularity}`,
      );
    }
  }
  const filters = query.filters.map((f) => ({ filter: f, target: dimension(f.member) }));

  for (const e of new Set(
    [...measures, ...groupDims, ...filters.map((f) => f.target), ...(time ? [time] : [])].map(
      (m) => m.entity,
    ),
  )) {
    if (!input.data.has(e.id)) {
      throw new QueryRejection('DATA_UNAVAILABLE', `The data of "${e.key}" is not available`);
    }
  }

  // 2. Safe join graph: many-to-one edges, plus the reverse of one-to-one edges.
  const graph = buildGraph(input.relationships);
  const anyPath = buildUndirected(input.relationships);

  // 3. One aggregate per source entity.
  const sources = [...new Set(measures.map((m) => m.entity.id))].map((id) => byId.get(id)!);
  const policyEntities = (policy.rowFilters ?? []).map((f) => {
    const entity = byKey.get(f.entity);
    if (!entity || !input.data.has(entity.id)) {
      throw new QueryRejection('POLICY_NOT_ENFORCEABLE', 'An access policy cannot be applied');
    }
    return entity;
  });

  const outputs: { key: string; sqlName: string; column: QueryColumn }[] = [];
  const dimColumns: { name: string; column: QueryColumn }[] = [];
  const granularity = query.timeDimension?.granularity ?? null;
  if (time && granularity) {
    dimColumns.push({
      name: 't0',
      column: { key: time.ref, name: time.dimension.name, kind: 'time', granularity, type: 'DATE' },
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
      },
    }),
  );

  const measureType = new Map<string, { sql: string; type: ColumnDataType }>();
  const ctes: string[] = [];
  sources.forEach((source, si) => {
    const required = new Set<string>([
      ...groupDims.map((d) => d.entity.id),
      ...filters.map((f) => f.target.entity.id),
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
        return compileExpression(expr, (name) => {
          const c = data.columns.get(name);
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
    const group: string[] = [];
    if (time && granularity) {
      const bucket = `date_trunc('${granularity}', ${exprFor(time.entity, time.dimension.expr).sql})::date`;
      select.push(`${bucket} AS "t0"`);
      group.push(bucket);
    }
    groupDims.forEach((d, i) => {
      const sql = exprFor(d.entity, d.dimension.expr).sql;
      select.push(`${sql} AS "d${i}"`);
      group.push(sql);
    });

    const own = measures.filter((m) => m.entity.id === source.id);
    for (const m of own) {
      const index = measures.indexOf(m);
      const compiled = m.measure.expr ? exprFor(m.entity, m.measure.expr) : null;
      const { sql, type } = aggregate(m, compiled);
      measureType.set(m.ref, { sql: SQL_TYPE[type], type });
      select.push(`(${sql})::${SQL_TYPE[type]} AS "m${index}"`);
    }

    const where: string[] = [];
    if (time && input.dateRange) {
      const sql = exprFor(time.entity, time.dimension.expr).sql;
      where.push(`${sql} >= ${param(input.dateRange.from, 'date')}`);
      where.push(`${sql} < ${param(exclusiveEnd(input.dateRange), 'date')}`);
    }
    for (const { filter, target } of filters) {
      const compiled = exprFor(target.entity, target.dimension.expr);
      where.push(filterSql(filter, compiled.sql, compiled.type, param));
    }
    if (policy.rowFilters) {
      // Fail closed: a policy filter that does not compile hides every row.
      const alternatives = policy.rowFilters.map((f) => {
        const entity = byKey.get(f.entity)!;
        try {
          const compiled = exprFor(entity, f.expr);
          return `coalesce((${compiled.sql}), false)`;
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
          throw new QueryRejection('DATA_UNAVAILABLE', 'A relationship no longer matches its data');
        }
        return `${parent}."${left.physicalName}" = ${child}."${right.physicalName}"`;
      });
      from.push(`LEFT JOIN ${toData.table} ${child} ON ${on.join(' AND ')}`);
    });

    ctes.push(
      `s${si} AS (SELECT ${select.join(', ')} FROM ${from.join(' ')}` +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
        (group.length > 0 ? ` GROUP BY ${group.join(', ')}` : '') +
        ')',
    );
  });

  // 4. Combine sources on the dimension values (GROUP BY treats NULL keys as equal).
  const dimNames = dimColumns.map((d) => `"${d.name}"`);
  const measureNames = measures.map((_, i) => `"m${i}"`);
  let body: string;
  if (sources.length === 1) {
    body = `SELECT ${[...dimNames, ...measureNames].join(', ')} FROM s0`;
  } else {
    const branches = sources.map((source, si) => {
      const cols = measures.map((m, i) =>
        m.entity.id === source.id ? `"m${i}"` : `NULL::${measureType.get(m.ref)!.sql} AS "m${i}"`,
      );
      return `SELECT ${[...dimNames, ...cols].join(', ')} FROM s${si}`;
    });
    // Each branch holds at most one row per dimension combination, so max() just picks it.
    body =
      `SELECT ${[...dimNames, ...measures.map((_, i) => `max("m${i}") AS "m${i}"`)].join(', ')} ` +
      `FROM (${branches.join(' UNION ALL ')}) u` +
      (dimNames.length > 0 ? ` GROUP BY ${dimNames.join(', ')}` : '');
  }

  for (const d of dimColumns)
    outputs.push({ key: d.column.key, sqlName: d.name, column: d.column });
  measures.forEach((m, i) =>
    outputs.push({
      key: m.ref,
      sqlName: `m${i}`,
      column: {
        key: m.ref,
        name: m.measure.name,
        kind: 'measure',
        granularity: null,
        type: measureType.get(m.ref)!.type,
      },
    }),
  );

  // 5. Order: requested columns, then every dimension column for a stable result.
  const order: string[] = [];
  for (const o of query.orderBy) {
    const out = outputs.find((x) => x.key === o.member);
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
    `WITH ${ctes.join(', ')} ${body}` +
    (order.length > 0 ? ` ORDER BY ${order.join(', ')}` : '') +
    ` LIMIT ${query.limit + 1}`;

  const used = new Set<string>([
    ...sources.map((s) => s.id),
    ...groupDims.map((d) => d.entity.id),
    ...filters.map((f) => f.target.entity.id),
    ...(time ? [time.entity.id] : []),
    ...policyEntities.map((e) => e.id),
  ]);
  return {
    sql,
    params,
    columns: outputs.map((o) => o.column),
    datasetVersionIds: [...used].map((id) => input.data.get(id)!.versionId).sort(),
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
