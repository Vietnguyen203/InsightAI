import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type {
  CompiledQuery,
  ImportJob,
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

/**
 * The double-counting fixture (docs/DEVELOPMENT_PLAN.md Phase 4): order O1 has two lines, so a
 * naive join of orders with order_items would count its revenue twice.
 */
const CSV = {
  orders: [
    'order_id,customer_id,created_at,status,amount',
    'O1,C1,2026-10-01,PAID,100',
    'O2,C2,2026-10-15,PAID,200',
    'O3,C1,2026-11-02,PENDING,50',
  ],
  customers: ['customer_id,region', 'C1,North', 'C2,South'],
  products: ['product_id,category', 'P1,Book', 'P2,Toy'],
  order_items: [
    'line_id,order_id,product_id,qty',
    'L1,O1,P1,1',
    'L2,O1,P2,2',
    'L3,O2,P1,5',
    'L4,O3,P2,1',
  ],
};

describe('semantic query engine (integration)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let admin: pg.Client;
  let owner: TestUser;
  let viewer: TestUser;
  let other: TestUser;
  let org: string;
  const datasets: Record<string, string> = {};
  let model: SemanticModelDetail;

  beforeAll(async () => {
    admin = await connectAdmin();
    app = await createTestApp();
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    owner = await registerUser(app, { label: 'qe-owner', organizationName: 'Query Org' });
    other = await registerUser(app, { label: 'qe-other', organizationName: 'Query Other' });
    org = owner.organizationId!;
    const token = (
      await client(app).post('/api/v1/invitations', owner, org).send({ role: 'viewer' }).expect(201)
    ).body.token as string;
    viewer = await registerUser(app, { label: 'qe-viewer', invitationToken: token });

    for (const [name, lines] of Object.entries(CSV)) {
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
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    if (admin) {
      await cleanupTestData(admin);
      await admin.end();
    }
  });

  const post = (path: string, body: object, user = owner) =>
    client(app).post(`/api/v1${path}`, user, org).send(body);
  const query = async (q: Omit<SemanticQuery, 'model'>, user = owner, status = 200) =>
    (await post('/semantic-query', { model: 'shop', ...q }, user).expect(status))
      .body as SemanticQueryResult;
  const entityId = (key: string) => model.entities.find((e) => e.key === key)!.id;

  it('rejects queries until the model is published', async () => {
    model = (await post('/semantic-models', { key: 'shop', name: 'Shop' }).expect(201)).body;
    const res = await post('/semantic-query', {
      model: 'shop',
      measures: ['order.revenue'],
    }).expect(422);
    expect(res.body.code).toBe('QUERY_REJECTED');
    expect(res.body.errors[0].path).toBe('reason.UNKNOWN_MODEL');
  });

  it('publishes the model', async () => {
    const entity = async (key: string, dataset: string, pk: string) => {
      model = (
        await post(`/semantic-models/${model.id}/entities`, {
          key,
          name: key,
          datasetId: datasets[dataset],
          primaryKey: [pk],
        }).expect(201)
      ).body;
    };
    await entity('order', 'orders', 'order_id');
    await entity('order_item', 'order_items', 'line_id');
    await entity('product', 'products', 'product_id');
    await entity('customer', 'customers', 'customer_id');
    const add = (entity: string, kind: string, body: object) =>
      post(`/semantic-entities/${entityId(entity)}/${kind}`, body).expect(201);
    await add('order', 'dimensions', {
      key: 'order_date',
      name: 'Order date',
      type: 'TIME',
      expr: 'created_at',
    });
    await add('order', 'dimensions', {
      key: 'status',
      name: 'Status',
      type: 'CATEGORICAL',
      expr: 'status',
    });
    await add('order', 'measures', { key: 'revenue', name: 'Revenue', agg: 'sum', expr: 'amount' });
    await add('order', 'measures', { key: 'order_count', name: 'Orders', agg: 'count' });
    await add('order_item', 'measures', {
      key: 'quantity',
      name: 'Quantity',
      agg: 'sum',
      expr: 'qty',
    });
    await add('product', 'dimensions', {
      key: 'category',
      name: 'Category',
      type: 'CATEGORICAL',
      expr: 'category',
    });
    await add('customer', 'dimensions', {
      key: 'region',
      name: 'Region',
      type: 'CATEGORICAL',
      expr: 'region',
    });
    const rel = (from: string, to: string, column: string) =>
      post(`/semantic-models/${model.id}/relationships`, {
        fromEntityId: entityId(from),
        toEntityId: entityId(to),
        joinColumns: [{ from: column, to: column }],
        cardinality: 'MANY_TO_ONE',
      }).expect(201);
    await rel('order_item', 'order', 'order_id');
    await rel('order_item', 'product', 'product_id');
    await rel('order', 'customer', 'customer_id');
    model = (await post(`/semantic-models/${model.id}/publish`, {}).expect(200)).body;
    expect(model.validationStatus).toBe('VALID');
  });

  it('never double counts across one-to-many relationships', async () => {
    const byRegion = await query({ measures: ['order.revenue'], dimensions: ['customer.region'] });
    expect(byRegion.columns.map((c) => c.key)).toEqual(['customer.region', 'order.revenue']);
    expect(byRegion.rows).toEqual([
      ['North', '150'],
      ['South', '200'],
    ]);

    // Two sources (orders and lines) combined on the status of the order.
    const mixed = await query({
      measures: ['order.revenue', 'order_item.quantity'],
      dimensions: ['order.status'],
    });
    expect(mixed.rows).toEqual([
      ['PAID', '300', '8'],
      ['PENDING', '50', '1'],
    ]);

    // Line grain: quantity per product category and customer region.
    const lines = await query({
      measures: ['order_item.quantity'],
      dimensions: ['product.category', 'customer.region'],
    });
    expect(lines.rows).toEqual([
      ['Book', 'North', '1'],
      ['Book', 'South', '5'],
      ['Toy', 'North', '3'],
    ]);

    // Revenue per product would count O1 twice: refused.
    const res = await post('/semantic-query', {
      model: 'shop',
      measures: ['order.revenue'],
      dimensions: ['product.category'],
    }).expect(422);
    expect(res.body.errors[0].path).toBe('reason.FANOUT_JOIN');
  });

  it('groups by time, filters with bound values and orders the result', async () => {
    const monthly = await query({
      measures: ['order.order_count', 'order.revenue'],
      timeDimension: {
        dimension: 'order.order_date',
        granularity: 'month',
        dateRange: { from: '2026-10-01', to: '2026-11-30' },
      },
    });
    expect(monthly.dateRange).toEqual({ from: '2026-10-01', to: '2026-11-30' });
    expect(monthly.rows).toEqual([
      ['2026-10-01', '2', '300'],
      ['2026-11-01', '1', '50'],
    ]);

    const filtered = await query({
      measures: ['order.revenue'],
      dimensions: ['order.status'],
      filters: [
        { member: 'order.status', op: 'in', values: ['PAID', "PAID'); DROP TABLE x; --"] },
        { member: 'customer.region', op: 'eq', values: ['North'] },
      ],
    });
    expect(filtered.rows).toEqual([['PAID', '100']]);

    const top = await query({
      measures: ['order.revenue'],
      dimensions: ['customer.region'],
      orderBy: [{ member: 'order.revenue', dir: 'desc' }],
      limit: 1,
    });
    expect(top).toMatchObject({ rows: [['South', '200']], truncated: true });
  });

  it('caches results and records every query', async () => {
    const q = { measures: ['order.order_count'], dimensions: ['order.status'] };
    expect((await query(q)).cached).toBe(false);
    expect((await query(q)).cached).toBe(true);

    const history = await admin.query<{
      status: string;
      error_code: string | null;
      cached: boolean;
    }>(
      `SELECT status, error_code, cached FROM app.query_history WHERE organization_id = $1 ORDER BY created_at`,
      [org],
    );
    expect(history.rows.filter((r) => r.status === 'REJECTED').map((r) => r.error_code)).toEqual([
      'UNKNOWN_MODEL',
      'FANOUT_JOIN',
    ]);
    expect(history.rows.at(-1)).toMatchObject({ status: 'SUCCEEDED', cached: true });
  });

  it('enforces access policies per role', async () => {
    const policy = (
      await post(`/semantic-models/${model.id}/access-policies`, {
        name: 'Viewers see the North',
        roles: ['viewer'],
        memberAccess: { exclude: ['order_item.*'] },
        rowFilter: { entity: 'customer', expr: "region = 'North'" },
      }).expect(201)
    ).body as { id: string };
    await post(
      `/semantic-models/${model.id}/access-policies`,
      { name: 'x', roles: ['viewer'] },
      viewer,
    ).expect(403);
    await post(`/semantic-models/${model.id}/access-policies`, {
      name: 'bad',
      roles: ['viewer'],
      rowFilter: { entity: 'customer', expr: 'nope = 1' },
    }).expect(400);

    const seen = await query({ measures: ['order.revenue'] }, viewer);
    expect(seen).toMatchObject({ rows: [['150']], policiesApplied: ['Viewers see the North'] });
    expect((await query({ measures: ['order.revenue'] })).rows).toEqual([['350']]);
    const hidden = await post(
      '/semantic-query',
      { model: 'shop', measures: ['order_item.quantity'] },
      viewer,
    ).expect(422);
    expect(hidden.body.errors[0].path).toBe('reason.UNKNOWN_MEMBER');

    // Disabling the policy takes effect immediately (and is not served from the cache).
    await client(app)
      .patch(`/api/v1/semantic-access-policies/${policy.id}`, owner, org)
      .send({ enabled: false })
      .expect(200);
    expect((await query({ measures: ['order.revenue'] }, viewer)).rows).toEqual([['350']]);
  });

  it('compiles for editors and isolates tenants', async () => {
    const compiled = (
      await post('/semantic-query/compile', {
        model: 'shop',
        measures: ['order.revenue'],
        dimensions: ['customer.region'],
      }).expect(200)
    ).body as CompiledQuery;
    expect(compiled.sql).toMatch(/^WITH s0 AS \(SELECT/);
    expect(compiled.modelRevision).toBe(1);
    await post(
      '/semantic-query/compile',
      { model: 'shop', measures: ['order.revenue'] },
      viewer,
    ).expect(403);

    const foreign = await client(app)
      .post('/api/v1/semantic-query', other, other.organizationId)
      .send({ model: 'shop', measures: ['order.revenue'] })
      .expect(422);
    expect(foreign.body.errors[0].path).toBe('reason.UNKNOWN_MODEL');
    await post('/semantic-query', {
      model: 'shop',
      measures: ['order.revenue'],
      limit: 5000,
    }).expect(400);
  });
});
