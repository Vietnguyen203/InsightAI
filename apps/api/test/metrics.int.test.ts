import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type {
  Catalog,
  CreateMetricRequest,
  ImportJob,
  MetricDetail,
  SemanticModelDetail,
  SemanticQuery,
  SemanticQueryResult,
} from '@insightai/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerModule } from '../src/worker.module';
import { connectAdmin } from './support/admin-db';
import {
  cleanupTestData,
  client,
  createTestApp,
  registerUser,
  type TestUser,
} from './support/test-app';

const ORDERS = [
  'order_id,customer_id,created_at,status,amount',
  'O1,C1,2026-10-01,PAID,100',
  'O2,C2,2026-10-15,PAID,200',
  'O3,C1,2026-11-02,PENDING,50',
];
const CUSTOMERS = ['customer_id,region', 'C1,North', 'C2,South'];

describe('metrics, catalog and KPI queries (integration)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let admin: pg.Client;
  let owner: TestUser;
  let analyst: TestUser;
  let viewer: TestUser;
  let org: string;
  let model: SemanticModelDetail;
  const metrics: Record<string, MetricDetail> = {};

  beforeAll(async () => {
    admin = await connectAdmin();
    app = await createTestApp();
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    owner = await registerUser(app, { label: 'mt-owner', organizationName: 'Metric Org' });
    org = owner.organizationId!;
    const invite = async (role: string) =>
      (await client(app).post('/api/v1/invitations', owner, org).send({ role }).expect(201)).body
        .token as string;
    analyst = await registerUser(app, {
      label: 'mt-analyst',
      invitationToken: await invite('analyst'),
    });
    viewer = await registerUser(app, {
      label: 'mt-viewer',
      invitationToken: await invite('viewer'),
    });

    const datasets: Record<string, string> = {};
    for (const [name, lines] of [
      ['orders', ORDERS],
      ['customers', CUSTOMERS],
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

    const post = (path: string, body: object) =>
      client(app)
        .post(`/api/v1${path}`, owner, org)
        .send(body)
        .expect((res) => {
          if (res.status >= 300)
            throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
        });
    model = (await post('/semantic-models', { key: 'sales', name: 'Sales' })).body;
    model = (
      await post(`/semantic-models/${model.id}/entities`, {
        key: 'order',
        name: 'Order',
        datasetId: datasets.orders,
        primaryKey: ['order_id'],
      })
    ).body;
    model = (
      await post(`/semantic-models/${model.id}/entities`, {
        key: 'customer',
        name: 'Customer',
        datasetId: datasets.customers,
        primaryKey: ['customer_id'],
      })
    ).body;
    const order = model.entities.find((e) => e.key === 'order')!.id;
    const customer = model.entities.find((e) => e.key === 'customer')!.id;
    await post(`/semantic-entities/${order}/dimensions`, {
      key: 'order_date',
      name: 'Order date',
      type: 'TIME',
      expr: 'created_at',
    });
    await post(`/semantic-entities/${order}/dimensions`, {
      key: 'status',
      name: 'Status',
      type: 'CATEGORICAL',
      expr: 'status',
    });
    await post(`/semantic-entities/${order}/measures`, {
      key: 'revenue',
      name: 'Revenue',
      agg: 'sum',
      expr: 'amount',
    });
    await post(`/semantic-entities/${order}/measures`, {
      key: 'order_count',
      name: 'Orders',
      agg: 'count',
    });
    await post(`/semantic-entities/${customer}/dimensions`, {
      key: 'region',
      name: 'Region',
      type: 'CATEGORICAL',
      expr: 'region',
    });
    await post(`/semantic-models/${model.id}/relationships`, {
      fromEntityId: order,
      toEntityId: customer,
      joinColumns: [{ from: 'customer_id', to: 'customer_id' }],
      cardinality: 'MANY_TO_ONE',
    });
    model = (await post(`/semantic-models/${model.id}/publish`, {})).body;
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    if (admin) {
      await cleanupTestData(admin);
      await admin.end();
    }
  });

  const paid = { member: 'order.status', op: 'eq' as const, values: ['PAID'] };
  const create = async (body: CreateMetricRequest, user = analyst) => {
    const metric = (
      await client(app)
        .post(`/api/v1/semantic-models/${model.id}/metrics`, user, org)
        .send(body)
        .expect(201)
    ).body as MetricDetail;
    metrics[metric.key] = metric;
    return metric;
  };
  const publish = (metric: MetricDetail, user = owner, status = 200) =>
    client(app)
      .post(`/api/v1/metric-versions/${metric.draft!.id}/publish`, user, org)
      .expect(status);
  const query = async (q: Omit<SemanticQuery, 'model'>, user = owner) =>
    (
      await client(app)
        .post('/api/v1/semantic-query', user, org)
        .send({ model: 'sales', ...q })
        .expect(200)
    ).body as SemanticQueryResult;

  it('creates drafts and publishes them after planning them', async () => {
    await create({
      key: 'paid_revenue',
      label: 'Doanh thu đã thanh toán',
      businessDefinition: 'Tổng giá trị các đơn đã thanh toán.',
      unit: 'VND',
      format: 'currency',
      definition: {
        type: 'SIMPLE',
        measure: 'order.revenue',
        filters: [paid],
        timeDimension: 'order.order_date',
      },
    });
    await create({
      key: 'paid_orders',
      label: 'Đơn đã thanh toán',
      definition: {
        type: 'SIMPLE',
        measure: 'order.order_count',
        filters: [paid],
        timeDimension: 'order.order_date',
      },
    });
    await create({
      key: 'all_orders',
      label: 'Tất cả đơn',
      definition: {
        type: 'SIMPLE',
        measure: 'order.order_count',
        timeDimension: 'order.order_date',
      },
    });
    await create({
      key: 'aov',
      label: 'Giá trị đơn trung bình',
      unit: 'VND',
      format: 'currency',
      definition: { type: 'RATIO', numerator: 'paid_revenue', denominator: 'paid_orders' },
    });
    await create({
      key: 'unpaid_orders',
      label: 'Đơn chưa thanh toán',
      definition: { type: 'DERIVED', expr: 'all_orders - paid_orders' },
    });
    await create({
      key: 'broken',
      label: 'x',
      definition: { type: 'SIMPLE', measure: 'order.nope' },
    });
    await create({ key: 'self', label: 'x', definition: { type: 'DERIVED', expr: 'self + 1' } });

    // Analysts edit, only publishers publish.
    await publish(metrics.paid_revenue!, analyst, 403);
    // A ratio needs its parts published first.
    const early = await publish(metrics.aov!, owner, 422);
    expect(early.body.errors[0].path).toBe('reason.UNKNOWN_METRIC');
    for (const key of ['paid_revenue', 'paid_orders', 'all_orders', 'aov', 'unpaid_orders']) {
      metrics[key] = (await publish(metrics[key]!)).body as MetricDetail;
      expect(metrics[key]).toMatchObject({
        published: { versionNo: 1, status: 'PUBLISHED' },
        draft: null,
      });
    }
    expect((await publish(metrics.broken!, owner, 422)).body.errors[0].path).toBe(
      'reason.UNKNOWN_MEMBER',
    );
    expect((await publish(metrics.self!, owner, 422)).body.errors[0].path).toBe(
      'reason.METRIC_CYCLE',
    );
  });

  it('answers KPI queries with simple, ratio and derived metrics', async () => {
    const byRegion = await query({
      metrics: ['aov', 'paid_revenue'],
      dimensions: ['customer.region'],
    });
    expect(byRegion.columns.map((c) => [c.key, c.kind, c.unit, c.format])).toEqual([
      ['customer.region', 'dimension', null, null],
      ['aov', 'metric', 'VND', 'currency'],
      ['paid_revenue', 'metric', 'VND', 'currency'],
    ]);
    expect(byRegion.rows).toEqual([
      ['North', '100', '100'],
      ['South', '200', '200'],
    ]);
    expect(byRegion.metrics).toEqual([
      { key: 'aov', version: 1 },
      { key: 'paid_orders', version: 1 },
      { key: 'paid_revenue', version: 1 },
    ]);

    expect((await query({ metrics: ['aov', 'unpaid_orders'] })).rows).toEqual([['150', '1']]);
  });

  it('compares with the previous period', async () => {
    const result = await query({
      metrics: ['paid_revenue', 'all_orders'],
      timeDimension: {
        dateRange: { from: '2026-11-01', to: '2026-11-30' },
        compareTo: 'previous_period',
      },
    });
    expect(result.dateRange).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(result.compareRange).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(result.columns.map((c) => [c.key, c.comparison])).toEqual([
      ['paid_revenue', false],
      ['paid_revenue', true],
      ['all_orders', false],
      ['all_orders', true],
    ]);
    // November: only the pending O3. The whole of October (D-63): O1 on 1 October and O2.
    expect(result.rows).toEqual([[null, '300', '1', '2']]);
  });

  it('versions definitions: drafts do not change answers until published', async () => {
    const draft = (
      await client(app)
        .post(`/api/v1/metrics/${metrics.paid_revenue!.id}/versions`, analyst, org)
        .send({
          label: 'Doanh thu',
          unit: 'VND',
          format: 'currency',
          definition: {
            type: 'SIMPLE',
            measure: 'order.revenue',
            timeDimension: 'order.order_date',
          },
        })
        .expect(201)
    ).body as MetricDetail;
    expect(draft.draft?.versionNo).toBe(2);
    await client(app)
      .post(`/api/v1/metrics/${metrics.paid_revenue!.id}/versions`, analyst, org)
      .send({ label: 'x', definition: { type: 'SIMPLE', measure: 'order.revenue' } })
      .expect(409);
    expect((await query({ metrics: ['paid_revenue'] })).rows).toEqual([['300']]);

    // Published versions are immutable, in the API and in the database.
    await client(app)
      .patch(`/api/v1/metric-versions/${draft.published!.id}`, analyst, org)
      .send({ label: 'changed' })
      .expect(409);
    await expect(
      admin.query(`UPDATE app.metric_versions SET label = 'changed' WHERE id = $1`, [
        draft.published!.id,
      ]),
    ).rejects.toThrow(/immutable/);

    metrics.paid_revenue = (
      await client(app)
        .post(`/api/v1/metric-versions/${draft.draft!.id}/publish`, owner, org)
        .expect(200)
    ).body as MetricDetail;
    const detail = (
      await client(app).get(`/api/v1/metrics/${metrics.paid_revenue.id}`, viewer, org).expect(200)
    ).body as MetricDetail;
    expect(detail.versions.map((v) => [v.versionNo, v.status])).toEqual([
      [2, 'PUBLISHED'],
      [1, 'DEPRECATED'],
    ]);
    const after = await query({ metrics: ['paid_revenue'] });
    expect(after).toMatchObject({
      rows: [['350']],
      metrics: [{ key: 'paid_revenue', version: 2 }],
    });

    const history = await admin.query<{ n: number }>(
      `SELECT cardinality(metric_version_ids) AS n FROM app.query_history WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [org],
    );
    expect(history.rows[0]!.n).toBe(1);
  });

  it('maps synonyms to one member each', async () => {
    const add = (member: string, phrase: string, status: number) =>
      client(app)
        .post(`/api/v1/semantic-models/${model.id}/synonyms`, analyst, org)
        .send({ member, phrase })
        .expect(status);
    await add('paid_revenue', 'doanh thu', 201);
    await add('paid_revenue', 'Doanh Thu', 409); // same phrase once normalized
    await add('aov', 'Giá trị đơn trung bình', 201);
    await add('customer.region', 'khu vực', 201);
    await add('order.nope', 'x', 400);
    await add('nope', 'y', 400);
  });

  it('serves a catalog filtered by access policies, without deprecated metrics', async () => {
    await client(app)
      .post(`/api/v1/semantic-models/${model.id}/access-policies`, owner, org)
      .send({
        name: 'No AOV for viewers',
        roles: ['viewer'],
        memberAccess: { exclude: ['metric:aov'] },
      })
      .expect(201);
    await client(app)
      .post(`/api/v1/metrics/${metrics.unpaid_orders!.id}/deprecate`, owner, org)
      .expect(200);

    const full = (await client(app).get('/api/v1/catalog?model=sales', analyst, org).expect(200))
      .body as Catalog;
    expect(full.metrics.map((m) => m.key)).toEqual([
      'all_orders',
      'aov',
      'paid_orders',
      'paid_revenue',
    ]);
    expect(full.metrics.find((m) => m.key === 'paid_revenue')).toMatchObject({
      version: 2,
      timeDimension: 'order.order_date',
      synonyms: ['doanh thu'],
    });
    expect(full.dimensions.find((d) => d.key === 'customer.region')?.synonyms).toEqual(['khu vực']);
    // A ratio takes the time dimension of its parts.
    expect(full.metrics.find((m) => m.key === 'aov')?.timeDimension).toBe('order.order_date');

    const limited = (await client(app).get('/api/v1/catalog?model=sales', viewer, org).expect(200))
      .body as Catalog;
    expect(limited.metrics.map((m) => m.key)).not.toContain('aov');
    const hidden = await client(app)
      .post('/api/v1/semantic-query', viewer, org)
      .send({ model: 'sales', metrics: ['aov'] })
      .expect(422);
    expect(hidden.body.errors[0].path).toBe('reason.UNKNOWN_METRIC');
    // Deprecated metrics remain queryable (existing dashboards keep working).
    expect((await query({ metrics: ['unpaid_orders'] })).rows).toEqual([['1']]);
  });
});
