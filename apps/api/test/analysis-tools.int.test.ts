import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  type ImportJob,
  type MetricDetail,
  type Permission,
  type SemanticModelDetail,
  SYSTEM_ROLE_PERMISSIONS,
  type SystemRole,
} from '@insightai/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AnalysisToolsService,
  type ToolRun,
} from '../src/modules/investigation/analysis-tools.service';
import type { TenantContext } from '../src/platform/http/request-context';
import { WorkerModule } from '../src/worker.module';
import { connectAdmin } from './support/admin-db';
import {
  cleanupTestData,
  client,
  createTestApp,
  registerUser,
  type TestUser,
} from './support/test-app';

/** Daily paid orders in September and October 2026 with a planted spike on 2026-10-20. */
function fixture() {
  const orders = ['order_id,customer_id,created_at,status,amount'];
  const expected = {
    sep: { North: 0, South: 0, orders: 0 },
    oct: { North: 0, South: 0, orders: 0 },
  };
  let id = 0;
  const add = (date: string, customer: 'C1' | 'C2', amount: number, status = 'PAID') => {
    orders.push(`O${++id},${customer},${date},${status},${amount}`);
    if (status !== 'PAID') return;
    const bucket = date.startsWith('2026-09') ? expected.sep : expected.oct;
    bucket[customer === 'C1' ? 'North' : 'South'] += amount;
    bucket.orders += 1;
  };
  for (let d = 1; d <= 30; d++) {
    const dd = String(d).padStart(2, '0');
    add(`2026-09-${dd}`, 'C1', 120 + (d % 4) * 2);
    add(`2026-09-${dd}`, 'C2', 40 + (d % 3));
    add(`2026-10-${dd}`, 'C1', 100 + (d % 5) * 3 + (d === 20 ? 2000 : 0));
    add(`2026-10-${dd}`, 'C2', 50 + (d % 3) * 2);
  }
  add('2026-10-05', 'C2', 999, 'PENDING'); // excluded by the metric's filter
  return { orders, customers: ['customer_id,region', 'C1,North', 'C2,South'], expected };
}

describe('analysis tools on the data plane (integration)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let admin: pg.Client;
  let owner: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let org: string;
  let tools: AnalysisToolsService;
  const data = fixture();
  const sep = { from: '2026-09-01', to: '2026-09-30' };
  const oct = { from: '2026-10-01', to: '2026-10-30' };

  /** Tenant context as the worker of 6C will build it: from the membership in the database. */
  const contextOf = async (user: TestUser, organizationId = org): Promise<TenantContext> => {
    const { rows } = await admin.query<{ id: string; role: SystemRole; data_schema: string }>(
      `SELECT m.id, r.key AS role, o.data_schema FROM app.memberships m
         JOIN app.roles r ON r.id = m.role_id JOIN app.organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 AND m.organization_id = $2`,
      [user.userId, organizationId],
    );
    const m = rows[0]!;
    return {
      userId: user.userId,
      sessionId: 'test',
      requestId: undefined,
      ip: undefined,
      userAgent: undefined,
      organizationId,
      dataSchema: m.data_schema,
      membershipId: m.id,
      role: m.role,
      permissions: new Set(SYSTEM_ROLE_PERMISSIONS[m.role] as Permission[]),
    };
  };

  beforeAll(async () => {
    admin = await connectAdmin();
    app = await createTestApp();
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    tools = app.get(AnalysisToolsService);
    owner = await registerUser(app, { label: 'at-owner', organizationName: 'Analysis Org' });
    org = owner.organizationId!;
    const token = (
      await client(app).post('/api/v1/invitations', owner, org).send({ role: 'viewer' }).expect(201)
    ).body.token as string;
    viewer = await registerUser(app, { label: 'at-viewer', invitationToken: token });
    outsider = await registerUser(app, { label: 'at-out', organizationName: 'Other Org' });

    const datasets: Record<string, string> = {};
    for (const [name, lines] of [
      ['orders', data.orders],
      ['customers', data.customers],
    ] as const) {
      const dataset = await client(app)
        .post('/api/v1/datasets', owner, org)
        .send({ name })
        .expect(201);
      const upload = await client(app)
        .post(`/api/v1/datasets/${dataset.body.id}/imports`, owner, org)
        .attach('file', Buffer.from(`${lines.join('\n')}\n`), `${name}.csv`)
        .field('options', JSON.stringify({ locale: 'en' }))
        .expect(202);
      for (let i = 0; i < 150; i++) {
        const job = (await client(app).get(`/api/v1/imports/${upload.body.id}`, owner, org))
          .body as ImportJob;
        if (job.status === 'SUCCEEDED') break;
        if (job.status === 'FAILED') throw new Error(JSON.stringify(job.error));
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      datasets[name] = dataset.body.id as string;
    }
    const post = async <T>(path: string, body: object): Promise<T> => {
      const res = await client(app).post(`/api/v1${path}`, owner, org).send(body);
      if (res.status >= 300) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body as T;
    };
    let model = await post<SemanticModelDetail>('/semantic-models', {
      key: 'sales',
      name: 'Sales',
    });
    for (const [key, dataset, pk] of [
      ['order', 'orders', 'order_id'],
      ['customer', 'customers', 'customer_id'],
    ] as const) {
      model = await post(`/semantic-models/${model.id}/entities`, {
        key,
        name: key,
        datasetId: datasets[dataset],
        primaryKey: [pk],
      });
    }
    const entity = (key: string) => model.entities.find((e) => e.key === key)!.id;
    for (const [key, type, expr] of [
      ['order_date', 'TIME', 'created_at'],
      ['status', 'CATEGORICAL', 'status'],
    ]) {
      await post(`/semantic-entities/${entity('order')}/dimensions`, {
        key,
        name: key,
        type,
        expr,
      });
    }
    await post(`/semantic-entities/${entity('customer')}/dimensions`, {
      key: 'region',
      name: 'Region',
      type: 'CATEGORICAL',
      expr: 'region',
    });
    for (const body of [
      { key: 'revenue', name: 'Revenue', agg: 'sum', expr: 'amount' },
      { key: 'orders', name: 'Orders', agg: 'count' },
      { key: 'customers', name: 'Customers', agg: 'count_distinct', expr: 'customer_id' },
    ]) {
      await post(`/semantic-entities/${entity('order')}/measures`, body);
    }
    await post(`/semantic-models/${model.id}/relationships`, {
      fromEntityId: entity('order'),
      toEntityId: entity('customer'),
      joinColumns: [{ from: 'customer_id', to: 'customer_id' }],
      cardinality: 'MANY_TO_ONE',
    });
    model = await post(`/semantic-models/${model.id}/publish`, {});
    const paid = [{ member: 'order.status', op: 'eq', values: ['PAID'] }];
    const time = 'order.order_date';
    for (const body of [
      {
        key: 'paid_revenue',
        label: 'Doanh thu',
        definition: {
          type: 'SIMPLE',
          measure: 'order.revenue',
          filters: paid,
          timeDimension: time,
        },
      },
      {
        key: 'paid_orders',
        label: 'Số đơn',
        definition: { type: 'SIMPLE', measure: 'order.orders', filters: paid, timeDimension: time },
      },
      {
        key: 'aov',
        label: 'Giá trị đơn TB',
        definition: { type: 'RATIO', numerator: 'paid_revenue', denominator: 'paid_orders' },
      },
      {
        key: 'buyers',
        label: 'Khách mua',
        definition: {
          type: 'SIMPLE',
          measure: 'order.customers',
          filters: paid,
          timeDimension: time,
        },
      },
    ]) {
      const metric = await post<MetricDetail>(`/semantic-models/${model.id}/metrics`, body);
      await post(`/metric-versions/${metric.draft!.id}/publish`, {});
    }
    await post(`/semantic-models/${model.id}/access-policies`, {
      name: 'Viewers see the North',
      roles: ['viewer'],
      rowFilter: { entity: 'customer', expr: "region = 'North'" },
    });
  }, 120_000);

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    if (admin) {
      await cleanupTestData(admin);
      await admin.end();
    }
  });

  const output = <T extends ToolRun['output']['tool']>(run: ToolRun, tool: T) => {
    expect(run.output.tool).toBe(tool);
    return run.output as Extract<ToolRun['output'], { tool: T }>;
  };
  const { sep: s, oct: o } = data.expected;

  it('marks the catalog with additivity and ratio parts', async () => {
    const catalog = (await client(app).get('/api/v1/catalog?model=sales', owner, org).expect(200))
      .body as { metrics: { key: string; additive: boolean; ratio: unknown }[] };
    expect(Object.fromEntries(catalog.metrics.map((m) => [m.key, [m.additive, m.ratio]]))).toEqual({
      aov: [false, { numerator: 'paid_revenue', denominator: 'paid_orders' }],
      buyers: [false, null],
      paid_orders: [true, null],
      paid_revenue: [true, null],
    });
  });

  it('compares periods exactly (explicit periods and compareTo)', async () => {
    const ctx = await contextOf(owner);
    const explicit = output(
      await tools.run(ctx, {
        tool: 'compare_periods',
        model: 'sales',
        metrics: ['paid_revenue', 'paid_orders'],
        current: oct,
        baseline: sep,
      }),
      'compare_periods',
    );
    const sepTotal = s.North + s.South;
    const octTotal = o.North + o.South;
    expect(explicit.comparisons[0]).toMatchObject({
      current: String(octTotal),
      baseline: String(sepTotal),
      delta: String(octTotal - sepTotal),
      direction: 'up',
    });
    expect(explicit.comparisons[1]).toMatchObject({
      current: String(o.orders),
      baseline: String(s.orders),
      direction: 'flat',
    });

    const run = await tools.run(ctx, {
      tool: 'compare_periods',
      model: 'sales',
      metrics: ['paid_revenue'],
      current: oct,
      baseline: 'previous_period',
    });
    expect(run.queries).toHaveLength(1);
    expect(output(run, 'compare_periods').comparisons[0]).toMatchObject({
      baseline: String(sepTotal),
      delta: String(octTotal - sepTotal),
    });
  });

  it('splits a change into exact contributions that add up to the total', async () => {
    const run = await tools.run(await contextOf(owner), {
      tool: 'contribution',
      model: 'sales',
      metric: 'paid_revenue',
      dimension: 'customer.region',
      current: oct,
      baseline: sep,
    });
    expect(run.queries).toHaveLength(4); // two grouped + two totals
    const out = output(run, 'contribution');
    if (out.kind !== 'additive') throw new Error('expected additive');
    const c = out.contribution;
    const total = o.North + o.South - (s.North + s.South);
    expect(c.totalDelta).toBe(String(total));
    expect(c.limitations).toEqual([]);
    expect(c.members.map((m) => [m.member, m.delta])).toEqual([
      ['North', String(o.North - s.North)],
      ['South', String(o.South - s.South)],
    ]);
    expect(c.members[0]!.share! + c.members[1]!.share!).toBeCloseTo(1, 5);

    const history = await admin.query<{ source: string; n: number }>(
      `SELECT source, count(*)::int AS n FROM app.query_history WHERE id = ANY($1) GROUP BY source`,
      [run.results.map((r) => r.queryHistoryId)],
    );
    expect(history.rows).toEqual([{ source: 'INVESTIGATION', n: 4 }]);
  });

  it('decomposes a ratio metric into rate and mix effects', async () => {
    const out = output(
      await tools.run(await contextOf(owner), {
        tool: 'contribution',
        model: 'sales',
        metric: 'aov',
        dimension: 'customer.region',
        current: oct,
        baseline: 'previous_period',
      }),
      'contribution',
    );
    if (out.kind !== 'ratio') throw new Error('expected ratio');
    const d = out.decomposition;
    const aovOct = (o.North + o.South) / o.orders;
    const aovSep = (s.North + s.South) / s.orders;
    expect(d.ratioCurrent).toBeCloseTo(aovOct, 9);
    expect(d.ratioBaseline).toBeCloseTo(aovSep, 9);
    expect(d.rateEffect + d.mixEffect).toBeCloseTo(aovOct - aovSep, 6);
    expect(d.members[0]!.member).toBe('North'); // the spike drives the change
    expect(d.limitations).toEqual([]);
  });

  it('refuses contributions of metrics that do not add up', async () => {
    await expect(
      tools.run(await contextOf(owner), {
        tool: 'contribution',
        model: 'sales',
        metric: 'buyers',
        dimension: 'customer.region',
        current: oct,
        baseline: sep,
      }),
    ).rejects.toMatchObject({ errors: [{ path: 'reason.NOT_ADDITIVE' }] });
  });

  it('applies the viewer’s row policy to every query', async () => {
    const run = await tools.run(await contextOf(viewer), {
      tool: 'contribution',
      model: 'sales',
      metric: 'paid_revenue',
      dimension: 'customer.region',
      current: oct,
      baseline: sep,
    });
    const out = output(run, 'contribution');
    if (out.kind !== 'additive') throw new Error('expected additive');
    expect(out.contribution.members.map((m) => m.member)).toEqual(['North']);
    expect(out.contribution.totalDelta).toBe(String(o.North - s.North));
    expect(out.contribution.limitations).toEqual(['POLICY_FILTERED']);
    expect(run.results.every((r) => r.policiesApplied.includes('Viewers see the North'))).toBe(
      true,
    );
  });

  it('finds the planted spike, the trend and the distribution', async () => {
    const ctx = await contextOf(owner);
    const anomalies = output(
      await tools.run(ctx, {
        tool: 'anomaly',
        model: 'sales',
        metric: 'paid_revenue',
        granularity: 'day',
        period: oct,
        dimension: 'customer.region',
      }),
      'anomaly',
    );
    const north = anomalies.reports.find((r) => r.member === 'North')!;
    expect(north.anomalies.map((a) => [a.period.slice(0, 10), a.direction])).toEqual([
      ['2026-10-20', 'high'],
    ]);
    expect(anomalies.reports.find((r) => r.member === 'South')!.anomalies).toEqual([]);

    const trends = output(
      await tools.run(ctx, {
        tool: 'trend',
        model: 'sales',
        metrics: ['paid_orders'],
        granularity: 'month',
        period: { from: '2026-09-01', to: '2026-10-30' },
      }),
      'trend',
    );
    expect(trends.trends[0]).toMatchObject({ fitted: 2, slope: null });
    expect(trends.trends[0]!.limitations).toContain('LOW_SAMPLE');

    const dist = output(
      await tools.run(ctx, {
        tool: 'distribution',
        model: 'sales',
        metric: 'paid_revenue',
        dimension: 'customer.region',
        period: oct,
      }),
      'distribution',
    );
    expect(dist.distribution.total).toBe(String(o.North + o.South));
    expect(dist.distribution.top[0]).toMatchObject({ member: 'North', value: String(o.North) });
  });

  it('cannot reach another organization’s model', async () => {
    const ctx = await contextOf(outsider, outsider.organizationId);
    await expect(
      tools.run(ctx, { tool: 'metric_snapshot', model: 'sales', metrics: ['paid_revenue'] }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
