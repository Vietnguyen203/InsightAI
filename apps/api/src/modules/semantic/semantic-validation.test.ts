import type { ColumnDataType, Entity, Relationship } from '@insightai/contracts';
import { describe, expect, it } from 'vitest';
import { checkGraph, checkModel, type EntitySource, overallStatus } from './semantic-validation';

const id = (n: number) => `0195a4a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

function entity(n: number, key: string, extra: Partial<Entity> = {}): Entity {
  return {
    id: id(n),
    key,
    name: key,
    description: null,
    datasetId: id(100 + n),
    datasetName: key,
    primaryKey: [`${key}_id`],
    dimensions: [],
    measures: [],
    ...extra,
  };
}

function source(e: Entity, columns: readonly (readonly [string, ColumnDataType])[]): EntitySource {
  return {
    entity: e,
    columns: columns.map(([name, dataType], i) => ({ name, physicalName: `c_${i + 1}`, dataType })),
    table: `"t_abcdefgh12"."v_${e.key.padEnd(10, 'x').slice(0, 10)}_abcdefgh"`,
    datasetQualityFailed: false,
  };
}

const rel = (
  n: number,
  from: number,
  to: number,
  extra: Partial<Relationship> = {},
): Relationship => ({
  id: id(n),
  fromEntityId: id(from),
  toEntityId: id(to),
  joinColumns: [{ from: 'customer_id', to: 'customer_id' }],
  cardinality: 'MANY_TO_ONE',
  preferred: false,
  ...extra,
});

const orders = entity(1, 'order', {
  primaryKey: ['order_id'],
  dimensions: [
    {
      id: id(11),
      key: 'created',
      name: 'Created',
      description: null,
      type: 'TIME',
      expr: 'created_at',
      granularities: ['day'],
      hidden: false,
    },
    {
      id: id(12),
      key: 'status',
      name: 'Status',
      description: null,
      type: 'CATEGORICAL',
      expr: 'lower(status)',
      granularities: [],
      hidden: false,
    },
  ],
  measures: [
    { id: id(21), key: 'revenue', name: 'Revenue', description: null, agg: 'sum', expr: 'amount' },
    { id: id(22), key: 'orders', name: 'Orders', description: null, agg: 'count', expr: null },
  ],
});
const customers = entity(2, 'customer', { primaryKey: ['customer_id'] });

const orderColumns = [
  ['order_id', 'TEXT'],
  ['customer_id', 'TEXT'],
  ['created_at', 'DATE'],
  ['status', 'TEXT'],
  ['amount', 'DECIMAL'],
] as const;
const customerColumns = [
  ['customer_id', 'TEXT'],
  ['region', 'TEXT'],
] as const;

const sources = () => [source(orders, orderColumns), source(customers, customerColumns)];

describe('checkModel', () => {
  it('accepts a consistent model and plans the data checks', () => {
    const result = checkModel(sources(), [rel(31, 1, 2)]);
    expect(result.issues).toEqual([]);
    // Primary keys of both entities; the join targets the customer key, so no extra key check.
    expect(result.keyChecks.map((k) => [k.kind, k.path, k.columns])).toEqual([
      ['primary_key', 'order', ['c_1']],
      ['primary_key', 'customer', ['c_1']],
    ]);
    expect(result.orphanChecks).toEqual([
      expect.objectContaining({ pairs: [{ from: 'c_2', to: 'c_1' }] }),
    ]);
  });

  it('reports missing columns, bad expressions and incompatible types', () => {
    const broken = entity(1, 'order', {
      primaryKey: ['order_id', 'missing'],
      dimensions: [
        { ...orders.dimensions[0]!, expr: 'status' }, // time dimension on text
        { ...orders.dimensions[1]!, expr: 'nope + 1' },
      ],
      measures: [
        { ...orders.measures[0]!, expr: 'status' }, // sum of text
        { id: id(23), key: 'latest', name: 'x', description: null, agg: 'max', expr: 'amount > 0' },
      ],
    });
    const codes = checkModel([source(broken, [...orderColumns])], []).issues.map(
      (i) => `${i.code}@${i.path}`,
    );
    expect(codes).toEqual([
      'COLUMN_NOT_FOUND@order',
      'TIME_DIMENSION_TYPE@order.created',
      'EXPRESSION_INVALID@order.status',
      'MEASURE_TYPE@order.revenue',
      'MEASURE_TYPE@order.latest',
    ]);
  });

  it('checks the "one" side when the join is not on its primary key', () => {
    const r = rel(31, 1, 2, {
      joinColumns: [{ from: 'customer_id', to: 'region' }],
      cardinality: 'ONE_TO_ONE',
    });
    const result = checkModel(sources(), [r]);
    expect(result.keyChecks.map((k) => k.kind)).toEqual([
      'primary_key',
      'primary_key',
      'relationship_one_side',
      'relationship_from_side',
    ]);
  });

  it('rejects joins between incompatible types and unavailable datasets', () => {
    const typed = checkModel(sources(), [
      rel(31, 1, 2, { joinColumns: [{ from: 'amount', to: 'customer_id' }] }),
    ]);
    expect(typed.issues.map((i) => i.code)).toEqual(['JOIN_TYPE_MISMATCH']);
    expect(typed.orphanChecks).toEqual([]);

    const unavailable = checkModel(
      [{ ...source(orders, orderColumns), columns: null, table: null }],
      [],
    );
    expect(unavailable.issues.map((i) => i.code)).toEqual(['DATASET_UNAVAILABLE']);
    expect(checkModel([], []).issues.map((i) => i.code)).toEqual(['MODEL_EMPTY']);
  });

  it('warns about datasets that failed quality checks', () => {
    const s = sources();
    s[0]!.datasetQualityFailed = true;
    expect(checkModel(s, []).issues).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'DATASET_QUALITY_FAILED' }),
    ]);
  });
});

describe('checkGraph', () => {
  const three = [...sources(), source(entity(3, 'region'), [['customer_id', 'TEXT']])];

  it('requires exactly one preferred relationship between the same entities', () => {
    const parallel = [rel(31, 1, 2), rel(32, 1, 2)];
    expect(checkGraph(three, parallel).map((i) => i.code)).toEqual(['RELATIONSHIP_AMBIGUOUS']);
    expect(checkGraph(three, [rel(31, 1, 2), rel(32, 1, 2, { preferred: true })])).toEqual([]);
  });

  it('warns when entities can be joined along several paths', () => {
    const cycle = [rel(31, 1, 2), rel(32, 2, 3), rel(33, 1, 3)];
    expect(checkGraph(three, cycle)).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'RELATIONSHIP_CYCLE' }),
    ]);
  });
});

describe('overallStatus', () => {
  it('is INVALID with any error, WARNING with only warnings', () => {
    const w = { severity: 'warning' as const, code: 'x', message: 'x', path: null };
    expect(overallStatus([])).toBe('VALID');
    expect(overallStatus([w])).toBe('WARNING');
    expect(overallStatus([w, { ...w, severity: 'error' }])).toBe('INVALID');
  });
});
