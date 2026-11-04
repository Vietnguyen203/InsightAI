import {
  type ColumnDataType,
  type Entity,
  type Relationship,
  semanticQuerySchema,
  type SemanticQuery,
} from '@insightai/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { policyRules } from './access-policy-rules';
import { resolveDateRange } from './date-range';
import { type EntityData, type PlanInput, planQuery, QueryRejection } from './query-planner';
import { initSqlValidator, SqlRejected, validateSql } from './sql-validator';

const id = (n: number) => `0195a4a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SCHEMA = 't_abcdefgh12';

/** orders (grain: order) ← order_items (grain: line) → products; orders → customers. */
const entities: Entity[] = [
  {
    id: id(1),
    key: 'order',
    name: 'Order',
    description: null,
    datasetId: id(11),
    datasetName: 'orders',
    primaryKey: ['order_id'],
    dimensions: [
      {
        id: id(101),
        key: 'order_date',
        name: 'Order date',
        description: null,
        type: 'TIME',
        expr: 'created_at',
        granularities: ['day', 'month'],
        hidden: false,
      },
      {
        id: id(102),
        key: 'status',
        name: 'Status',
        description: null,
        type: 'CATEGORICAL',
        expr: 'status',
        granularities: [],
        hidden: false,
      },
    ],
    measures: [
      {
        id: id(111),
        key: 'revenue',
        name: 'Revenue',
        description: null,
        agg: 'sum',
        expr: 'amount',
      },
      {
        id: id(112),
        key: 'order_count',
        name: 'Orders',
        description: null,
        agg: 'count',
        expr: null,
      },
    ],
  },
  {
    id: id(2),
    key: 'order_item',
    name: 'Order item',
    description: null,
    datasetId: id(12),
    datasetName: 'order_items',
    primaryKey: ['line_id'],
    dimensions: [],
    measures: [
      {
        id: id(121),
        key: 'quantity',
        name: 'Quantity',
        description: null,
        agg: 'sum',
        expr: 'qty',
      },
    ],
  },
  {
    id: id(3),
    key: 'product',
    name: 'Product',
    description: null,
    datasetId: id(13),
    datasetName: 'products',
    primaryKey: ['product_id'],
    dimensions: [
      {
        id: id(131),
        key: 'category',
        name: 'Category',
        description: null,
        type: 'CATEGORICAL',
        expr: 'category',
        granularities: [],
        hidden: false,
      },
    ],
    measures: [],
  },
  {
    id: id(4),
    key: 'customer',
    name: 'Customer',
    description: null,
    datasetId: id(14),
    datasetName: 'customers',
    primaryKey: ['customer_id'],
    dimensions: [
      {
        id: id(141),
        key: 'region',
        name: 'Region',
        description: null,
        type: 'CATEGORICAL',
        expr: 'region',
        granularities: [],
        hidden: false,
      },
    ],
    measures: [],
  },
];

const relationships: Relationship[] = [
  {
    id: id(201),
    fromEntityId: id(2),
    toEntityId: id(1),
    joinColumns: [{ from: 'order_id', to: 'order_id' }],
    cardinality: 'MANY_TO_ONE',
    preferred: false,
  },
  {
    id: id(202),
    fromEntityId: id(2),
    toEntityId: id(3),
    joinColumns: [{ from: 'product_id', to: 'product_id' }],
    cardinality: 'MANY_TO_ONE',
    preferred: false,
  },
  {
    id: id(203),
    fromEntityId: id(1),
    toEntityId: id(4),
    joinColumns: [{ from: 'customer_id', to: 'customer_id' }],
    cardinality: 'MANY_TO_ONE',
    preferred: false,
  },
];

function table(n: number, columns: [string, ColumnDataType][]): EntityData {
  return {
    table: `"${SCHEMA}"."v_tbl${n}xxxxx_abcdefgh"`,
    versionId: id(300 + n),
    columns: new Map(
      columns.map(([name, type], i) => [name, { physicalName: `c_${i + 1}`, dataType: type }]),
    ),
  };
}
const data = new Map<string, EntityData>([
  [
    id(1),
    table(1, [
      ['order_id', 'TEXT'],
      ['customer_id', 'TEXT'],
      ['created_at', 'DATE'],
      ['status', 'TEXT'],
      ['amount', 'DECIMAL'],
    ]),
  ],
  [
    id(2),
    table(2, [
      ['line_id', 'TEXT'],
      ['order_id', 'TEXT'],
      ['product_id', 'TEXT'],
      ['qty', 'INTEGER'],
    ]),
  ],
  [
    id(3),
    table(3, [
      ['product_id', 'TEXT'],
      ['category', 'TEXT'],
    ]),
  ],
  [
    id(4),
    table(4, [
      ['customer_id', 'TEXT'],
      ['region', 'TEXT'],
    ]),
  ],
]);
const tables = new Set([...data.values()].map((d) => d.table.split('.')[1]!.replaceAll('"', '')));

const open = policyRules([], 'analyst');
function plan(query: Omit<SemanticQuery, 'model'>, overrides: Partial<PlanInput> = {}) {
  return planQuery({
    query: semanticQuerySchema.parse({ model: 'sales', ...query }),
    entities,
    relationships,
    data,
    policy: open,
    dateRange: null,
    ...overrides,
  });
}
function rejection(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof QueryRejection) return error.code;
    throw error;
  }
  throw new Error('expected a rejection');
}

beforeAll(() => initSqlValidator());

describe('planQuery', () => {
  it('aggregates a measure by a many-to-one dimension in one CTE', () => {
    const p = plan({ measures: ['order.revenue'], dimensions: ['customer.region'] });
    expect(p.sql).toContain(
      'LEFT JOIN "t_abcdefgh12"."v_tbl4xxxxx_abcdefgh" e1 ON e0."c_2" = e1."c_1"',
    );
    expect(p.sql).toContain('GROUP BY e1."c_2"');
    expect(p.columns.map((c) => [c.key, c.kind, c.type])).toEqual([
      ['customer.region', 'dimension', 'TEXT'],
      ['order.revenue', 'measure', 'DECIMAL'],
    ]);
    expect(p.sql).toMatch(/LIMIT 101$/);
    expect(p.datasetVersionIds).toEqual([id(301), id(304)]);
    validateSql(p.sql, { schema: SCHEMA, tables });
  });

  it('rejects a dimension that would multiply the measure (fan-out)', () => {
    // order → order_item is one-to-many: revenue per product category would double count.
    expect(
      rejection(() => plan({ measures: ['order.revenue'], dimensions: ['product.category'] })),
    ).toBe('FANOUT_JOIN');
    // The same question at the line grain is fine, joining products and orders many-to-one.
    const ok = plan({
      measures: ['order_item.quantity'],
      dimensions: ['product.category', 'customer.region'],
    });
    expect(ok.sql.match(/LEFT JOIN/g)).toHaveLength(3);
  });

  it('aggregates measures of different entities separately and merges them', () => {
    const p = plan({
      measures: ['order.revenue', 'order_item.quantity'],
      dimensions: ['order.status'],
    });
    expect(p.sql).toContain('s0 AS (');
    expect(p.sql).toContain('s1 AS (');
    expect(p.sql).toContain('UNION ALL');
    expect(p.sql).toContain('NULL::numeric AS "m1"');
    expect(p.sql).toContain('GROUP BY "d0"');
    validateSql(p.sql, { schema: SCHEMA, tables });
  });

  it('binds filter values and the date range as parameters', () => {
    const p = plan(
      {
        measures: ['order.order_count'],
        timeDimension: {
          dimension: 'order.order_date',
          granularity: 'month',
          dateRange: { from: '2026-10-01', to: '2026-10-31' },
        },
        filters: [
          { member: 'order.status', op: 'in', values: ['PAID', "x'); DROP TABLE y; --"] },
          { member: 'customer.region', op: 'contains', values: ['50%_off'] },
        ],
      },
      { dateRange: { from: '2026-10-01', to: '2026-10-31' } },
    );
    expect(p.params).toEqual([
      '2026-10-01',
      '2026-11-01',
      ['PAID', "x'); DROP TABLE y; --"],
      '50\\%\\_off',
    ]);
    expect(p.sql).not.toContain('DROP TABLE');
    expect(p.sql).toContain(`date_trunc('month', e0."c_3")::date AS "t0"`);
    expect(p.columns[0]).toMatchObject({
      key: 'order.order_date',
      kind: 'time',
      granularity: 'month',
    });
    validateSql(p.sql, { schema: SCHEMA, tables });
  });

  it('rejects unknown members, wrong filters and unsupported orders', () => {
    expect(rejection(() => plan({ measures: ['order.nope'] }))).toBe('UNKNOWN_MEMBER');
    expect(
      rejection(() =>
        plan({
          measures: ['order.revenue'],
          filters: [{ member: 'order.revenue', op: 'gt', values: [1] }],
        }),
      ),
    ).toBe('MEASURE_FILTER_NOT_SUPPORTED');
    expect(
      rejection(() =>
        plan({
          measures: ['order.revenue'],
          filters: [{ member: 'order.status', op: 'gt', values: ['a'] }],
        }),
      ),
    ).toBe('INVALID_FILTER');
    expect(
      rejection(() =>
        plan({
          measures: ['order.revenue'],
          timeDimension: { dimension: 'order.order_date', granularity: 'year' },
        }),
      ),
    ).toBe('GRANULARITY_NOT_ALLOWED');
    expect(
      rejection(() =>
        plan({ measures: ['order.revenue'], orderBy: [{ member: 'order.status', dir: 'asc' }] }),
      ),
    ).toBe('ORDER_NOT_IN_RESULT');
    const withoutCustomer = new Map(data);
    withoutCustomer.delete(id(4));
    expect(
      rejection(() =>
        plan(
          { measures: ['order.revenue'], dimensions: ['customer.region'] },
          { data: withoutCustomer },
        ),
      ),
    ).toBe('DATA_UNAVAILABLE');
  });

  it('reports ambiguous and missing join paths', () => {
    const second: Relationship = {
      ...relationships[2]!,
      id: id(204),
      joinColumns: [{ from: 'status', to: 'customer_id' }],
    };
    // Two relationships, one preferred: the preferred one is used.
    const preferred = plan(
      { measures: ['order.revenue'], dimensions: ['customer.region'] },
      {
        relationships: [...relationships, { ...second, preferred: true }],
      },
    );
    expect(preferred.sql).toContain('e0."c_4" = e1."c_1"');
    expect(
      rejection(() =>
        plan(
          { measures: ['order.revenue'], dimensions: ['customer.region'] },
          { relationships: [] },
        ),
      ),
    ).toBe('NOT_REACHABLE');
  });

  it('applies access policies: hidden members and OR-combined row filters', () => {
    const rules = policyRules(
      [
        {
          name: 'north',
          roles: ['viewer'],
          enabled: true,
          memberAccess: { exclude: ['order.revenue'] },
          rowFilter: { entity: 'customer', expr: "region = 'North'" },
        },
        {
          name: 'vip',
          roles: ['viewer'],
          enabled: true,
          memberAccess: { include: ['order.order_count'] },
          rowFilter: { entity: 'order', expr: 'amount > 1000' },
        },
        { name: 'off', roles: ['viewer'], enabled: false, memberAccess: null, rowFilter: null },
      ],
      'viewer',
    );
    expect(rules.names).toEqual(['north', 'vip']);
    expect(rejection(() => plan({ measures: ['order.revenue'] }, { policy: rules }))).toBe(
      'UNKNOWN_MEMBER',
    );
    const p = plan({ measures: ['order.order_count'] }, { policy: rules });
    // The customer table is joined only to enforce the policy.
    expect(p.sql).toContain('LEFT JOIN "t_abcdefgh12"."v_tbl4xxxxx_abcdefgh" e1');
    expect(p.sql).toContain(
      `(coalesce(((e1."c_2" = 'North'::text)), false) OR coalesce(((e0."c_5" > 1000::numeric)), false))`,
    );
    // A policy on an entity that cannot be joined safely blocks the query (fail closed).
    const lines = policyRules(
      [
        {
          name: 'p',
          roles: ['viewer'],
          enabled: true,
          memberAccess: null,
          rowFilter: { entity: 'order_item', expr: 'qty > 0' },
        },
      ],
      'viewer',
    );
    expect(rejection(() => plan({ measures: ['order.order_count'] }, { policy: lines }))).toBe(
      'FANOUT_JOIN',
    );
    expect(
      policyRules(
        [{ name: 'p', roles: ['viewer'], enabled: true, memberAccess: null, rowFilter: null }],
        'viewer',
      ).rowFilters,
    ).toBeNull();
  });
});

describe('validateSql', () => {
  const scope = { schema: SCHEMA, tables };
  const rejected = (sql: string) => {
    try {
      validateSql(sql, scope);
    } catch (error) {
      if (error instanceof SqlRejected) return error.message;
      throw error;
    }
    return null;
  };

  it('accepts the planner output and refuses anything else', () => {
    expect(rejected('SELECT count(*) FROM "t_abcdefgh12"."v_tbl1xxxxx_abcdefgh" e0')).toBeNull();
    expect(rejected('DELETE FROM "t_abcdefgh12"."v_tbl1xxxxx_abcdefgh"')).toMatch(/Only SELECT/);
    expect(
      rejected(
        'WITH x AS (DELETE FROM "t_abcdefgh12"."v_tbl1xxxxx_abcdefgh" RETURNING 1) SELECT * FROM x',
      ),
    ).toMatch(/Only SELECT is allowed in WITH/);
    expect(rejected('SELECT 1; SELECT 2')).toMatch(/one statement/);
    expect(rejected("SELECT set_config('role', 'x', true)")).toMatch(/set_config/);
    expect(rejected('SELECT pg_sleep(10)')).toMatch(/pg_sleep/);
    expect(rejected('SELECT * FROM app.users')).toMatch(/not allowed/);
    expect(rejected('SELECT * FROM "t_other12345"."v_tbl1xxxxx_abcdefgh"')).toMatch(/not allowed/);
    expect(rejected('SELECT * FROM pg_catalog.pg_roles')).toMatch(/not allowed/);
    expect(rejected('SELECT * FROM users')).toMatch(/not allowed/);
    expect(rejected('SELECT 1 -- hi')).toMatch(/Comments/);
    expect(rejected('SELECT current_user')).toMatch(/not allowed/);
    expect(rejected('SELECT * FROM "t_abcdefgh12"."v_tbl1xxxxx_abcdefgh" FOR UPDATE')).toMatch(
      /locking/,
    );
    expect(rejected('SELECT 1::regclass')).toMatch(/Type/);
    expect(rejected('SELECT * FROM generate_series(1, 10)')).toMatch(/not allowed/);
    expect(rejected('SET ROLE postgres')).toMatch(/Only SELECT/);
  });
});

describe('resolveDateRange', () => {
  // 2026-11-04 01:30 in Ho Chi Minh City is still 2026-11-03 in UTC.
  const now = new Date('2026-11-03T18:30:00Z');
  const tz = 'Asia/Ho_Chi_Minh';
  it('uses the organization time zone', () => {
    expect(resolveDateRange({ preset: 'today' }, tz, now)).toEqual({
      from: '2026-11-04',
      to: '2026-11-04',
    });
    expect(resolveDateRange({ preset: 'today' }, 'UTC', now)).toEqual({
      from: '2026-11-03',
      to: '2026-11-03',
    });
  });
  it('resolves calendar presets', () => {
    expect(resolveDateRange({ preset: 'this_week' }, tz, now)).toEqual({
      from: '2026-11-02',
      to: '2026-11-04',
    });
    expect(resolveDateRange({ preset: 'last_week' }, tz, now)).toEqual({
      from: '2026-10-26',
      to: '2026-11-01',
    });
    expect(resolveDateRange({ preset: 'last_month' }, tz, now)).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(resolveDateRange({ preset: 'this_quarter' }, tz, now)).toEqual({
      from: '2026-10-01',
      to: '2026-11-04',
    });
    expect(resolveDateRange({ preset: 'last_quarter' }, tz, now)).toEqual({
      from: '2026-07-01',
      to: '2026-09-30',
    });
    expect(resolveDateRange({ preset: 'last_7_days' }, tz, now)).toEqual({
      from: '2026-10-29',
      to: '2026-11-04',
    });
    expect(resolveDateRange({ preset: 'last_year' }, tz, now)).toEqual({
      from: '2025-01-01',
      to: '2025-12-31',
    });
    expect(resolveDateRange({ from: '2026-01-01', to: '2026-01-31' }, tz, now)).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    });
  });
});
