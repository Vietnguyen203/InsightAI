import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type {
  AskEvent,
  DashboardDetail,
  DashboardSummary,
  ImportJob,
  MetricDetail,
  SemanticModelDetail,
  SemanticQueryResult,
} from '@insightai/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmProvider, LlmResponse } from '../src/modules/ai/llm-provider';
import { loadAppConfig } from '../src/platform/config/config.module';
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

/** Scripted LLM: answers every question with revenue by region. */
const llm: LlmProvider = {
  name: 'scripted',
  model: 'scripted-1',
  chat(request): Promise<LlmResponse> {
    const usage = { promptTokens: 1, completionTokens: 1 };
    if (request.json) {
      return Promise.resolve({
        content: JSON.stringify({ narrative: '{{cell:0.customer.region}}' }),
        toolCalls: [],
        usage,
      });
    }
    const question = request.messages.at(-1)?.content ?? '';
    const call =
      question === 'mơ hồ'
        ? { name: 'ask_clarification', arguments: JSON.stringify({ question: 'Chỉ số nào?' }) }
        : {
            name: 'run_semantic_query',
            arguments: JSON.stringify({
              metrics: ['paid_revenue'],
              dimensions: ['customer.region'],
            }),
          };
    return Promise.resolve({ content: null, toolCalls: [{ id: 'c1', ...call }], usage });
  },
};

describe('dashboards (integration)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let admin: pg.Client;
  let owner: TestUser;
  let adminUser: TestUser;
  let analyst: TestUser;
  let analyst2: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let org: string;
  let model: SemanticModelDetail;
  let metric: MetricDetail;

  beforeAll(async () => {
    admin = await connectAdmin();
    app = await createTestApp({ llm });
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    owner = await registerUser(app, { label: 'db-owner', organizationName: 'Dash Org' });
    org = owner.organizationId!;
    const invite = async (role: string) =>
      (await client(app).post('/api/v1/invitations', owner, org).send({ role }).expect(201)).body
        .token as string;
    adminUser = await registerUser(app, {
      label: 'db-admin',
      invitationToken: await invite('admin'),
    });
    analyst = await registerUser(app, { label: 'db-an', invitationToken: await invite('analyst') });
    analyst2 = await registerUser(app, {
      label: 'db-an2',
      invitationToken: await invite('analyst'),
    });
    viewer = await registerUser(app, {
      label: 'db-viewer',
      invitationToken: await invite('viewer'),
    });
    outsider = await registerUser(app, { label: 'db-out', organizationName: 'Other Org' });

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
    const post = async <T>(path: string, body: object): Promise<T> => {
      const res = await client(app).post(`/api/v1${path}`, owner, org).send(body);
      if (res.status >= 300) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body as T;
    };
    model = await post('/semantic-models', { key: 'sales', name: 'Sales' });
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
    await post(`/semantic-entities/${entity('order')}/dimensions`, {
      key: 'order_date',
      name: 'Order date',
      type: 'TIME',
      expr: 'created_at',
    });
    await post(`/semantic-entities/${entity('order')}/dimensions`, {
      key: 'status',
      name: 'Status',
      type: 'CATEGORICAL',
      expr: 'status',
    });
    await post(`/semantic-entities/${entity('order')}/measures`, {
      key: 'revenue',
      name: 'Revenue',
      agg: 'sum',
      expr: 'amount',
    });
    await post(`/semantic-entities/${entity('customer')}/dimensions`, {
      key: 'region',
      name: 'Region',
      type: 'CATEGORICAL',
      expr: 'region',
    });
    await post(`/semantic-models/${model.id}/relationships`, {
      fromEntityId: entity('order'),
      toEntityId: entity('customer'),
      joinColumns: [{ from: 'customer_id', to: 'customer_id' }],
      cardinality: 'MANY_TO_ONE',
    });
    model = await post(`/semantic-models/${model.id}/publish`, {});
    metric = await post(`/semantic-models/${model.id}/metrics`, {
      key: 'paid_revenue',
      label: 'Doanh thu',
      unit: 'VND',
      format: 'currency',
      definition: {
        type: 'SIMPLE',
        measure: 'order.revenue',
        filters: [{ member: 'order.status', op: 'eq', values: ['PAID'] }],
        timeDimension: 'order.order_date',
      },
    });
    await post(`/metric-versions/${metric.draft!.id}/publish`, {});
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

  const byRegion = {
    model: 'sales',
    metrics: ['paid_revenue'],
    dimensions: ['customer.region'],
  };
  const chart = { type: 'bar', x: 'customer.region', series: ['paid_revenue'] };
  const create = async (user: TestUser, body: object) =>
    (await client(app).post('/api/v1/dashboards', user, org).send(body).expect(201))
      .body as DashboardDetail;
  const addWidget = (user: TestUser, id: string, body: object) =>
    client(app).post(`/api/v1/dashboards/${id}/widgets`, user, org).send(body);
  const run = (user: TestUser, widgetId: string, orgId = org) =>
    client(app).post(`/api/v1/dashboard-widgets/${widgetId}/run`, user, orgId);
  const list = async (user: TestUser) =>
    (await client(app).get('/api/v1/dashboards', user, org).expect(200)).body as DashboardSummary[];

  let privateDash: DashboardDetail;
  let orgDash: DashboardDetail;

  it('creates private dashboards visible to their owner only', async () => {
    privateDash = await create(analyst, { name: 'Của tôi' });
    expect(privateDash).toMatchObject({ visibility: 'PRIVATE', canEdit: true, widgetCount: 0 });
    expect((await list(analyst)).map((d) => d.id)).toContain(privateDash.id);
    for (const user of [owner, adminUser, analyst2, viewer]) {
      expect((await list(user)).map((d) => d.id)).not.toContain(privateDash.id);
      await client(app).get(`/api/v1/dashboards/${privateDash.id}`, user, org).expect(404);
    }
  });

  it('lets only dashboard writers create dashboards', async () => {
    await client(app).post('/api/v1/dashboards', viewer, org).send({ name: 'x' }).expect(403);
    await client(app).post('/api/v1/dashboards', analyst, org).send({ name: '' }).expect(400);
  });

  it('validates widgets as their author and stores the IR with versions', async () => {
    const res = await addWidget(analyst, privateDash.id, {
      title: 'Doanh thu theo vùng',
      query: byRegion,
      chart,
    }).expect(201);
    const widget = (res.body as DashboardDetail).widgets[0]!;
    expect(widget).toMatchObject({
      title: 'Doanh thu theo vùng',
      position: { x: 0, y: 0, w: 6, h: 4 },
      savedModelRevision: 1,
      savedMetricVersions: [{ key: 'paid_revenue', version: 1 }],
      sourceMessageId: null,
    });
    expect(widget.query).toMatchObject({ metrics: ['paid_revenue'] });
    const bad = await addWidget(analyst, privateDash.id, {
      title: 'x',
      query: { ...byRegion, metrics: ['nope'] },
      chart,
    }).expect(422);
    expect(bad.body.errors[0].path).toBe('reason.UNKNOWN_METRIC');
    await addWidget(analyst, privateDash.id, {
      title: 'x',
      query: byRegion,
      chart: { type: 'pie', x: null, series: [] },
    }).expect(400);
    const second = (
      await addWidget(analyst, privateDash.id, {
        title: 'Tổng',
        query: { model: 'sales', metrics: ['paid_revenue'] },
        chart: { type: 'kpi', x: null, series: ['paid_revenue'] },
      }).expect(201)
    ).body as DashboardDetail;
    expect(second.widgets[1]!.position).toEqual({ x: 0, y: 4, w: 6, h: 4 });
  });

  it('hides widgets of private dashboards from everyone else', async () => {
    const widgetId = privateDash.id && (await getDash(analyst, privateDash.id)).widgets[0]!.id;
    await run(viewer, widgetId).expect(404);
    await run(owner, widgetId).expect(404);
    await client(app)
      .patch(`/api/v1/dashboard-widgets/${widgetId}`, owner, org)
      .send({ title: 'x' })
      .expect(404);
    await client(app).delete(`/api/v1/dashboard-widgets/${widgetId}`, adminUser, org).expect(404);
  });

  it('shares with the organization; widget data follows the viewer’s policies', async () => {
    orgDash = await create(analyst, { name: 'Chung', visibility: 'ORG' });
    const detail = (
      await addWidget(analyst, orgDash.id, { title: 'Theo vùng', query: byRegion, chart }).expect(
        201,
      )
    ).body as DashboardDetail;
    const widgetId = detail.widgets[0]!.id;
    expect((await list(viewer)).find((d) => d.id === orgDash.id)).toMatchObject({
      canEdit: false,
      ownerName: expect.any(String),
      widgetCount: 1,
    });

    const forAnalyst = (await run(analyst, widgetId).expect(200)).body as SemanticQueryResult;
    expect(Object.fromEntries(forAnalyst.rows.map((r) => [r[0], r[1]]))).toEqual({
      North: '100',
      South: '200',
    });
    const forViewer = (await run(viewer, widgetId).expect(200)).body as SemanticQueryResult;
    expect(forViewer.rows).toEqual([['North', '100']]);
    expect(forViewer.policiesApplied).toEqual(['Viewers see the North']);

    const history = await admin.query(
      `SELECT source, user_id FROM app.query_history WHERE id = $1`,
      [forViewer.queryHistoryId],
    );
    expect(history.rows[0]).toEqual({ source: 'DASHBOARD', user_id: viewer.userId });
  });

  it('lets the owner or an organization admin edit ORG dashboards', async () => {
    await client(app)
      .patch(`/api/v1/dashboards/${orgDash.id}`, analyst2, org)
      .send({ name: 'x' })
      .expect(403);
    await client(app)
      .patch(`/api/v1/dashboards/${orgDash.id}`, viewer, org)
      .send({ name: 'x' })
      .expect(403);
    const renamed = (
      await client(app)
        .patch(`/api/v1/dashboards/${orgDash.id}`, adminUser, org)
        .send({ name: 'Chung (đã đổi tên)' })
        .expect(200)
    ).body as DashboardDetail;
    expect(renamed).toMatchObject({ name: 'Chung (đã đổi tên)', canEdit: true });
    // Only the owner decides who sees it.
    await client(app)
      .patch(`/api/v1/dashboards/${orgDash.id}`, adminUser, org)
      .send({ visibility: 'PRIVATE' })
      .expect(403);
  });

  it('moves widgets with a layout update', async () => {
    const detail = await getDash(analyst, orgDash.id);
    const widgetId = detail.widgets[0]!.id;
    const moved = (
      await client(app)
        .put(`/api/v1/dashboards/${orgDash.id}/layout`, analyst, org)
        .send({ widgets: [{ id: widgetId, position: { x: 6, y: 0, w: 6, h: 3 } }] })
        .expect(200)
    ).body as DashboardDetail;
    expect(moved.widgets[0]!.position).toEqual({ x: 6, y: 0, w: 6, h: 3 });
    const foreign = (await getDash(analyst, privateDash.id)).widgets[0]!.id;
    await client(app)
      .put(`/api/v1/dashboards/${orgDash.id}/layout`, analyst, org)
      .send({ widgets: [{ id: foreign, position: { x: 0, y: 0, w: 6, h: 3 } }] })
      .expect(404);
    await client(app)
      .put(`/api/v1/dashboards/${orgDash.id}/layout`, analyst, org)
      .send({ widgets: [{ id: widgetId, position: { x: 8, y: 0, w: 6, h: 3 } }] })
      .expect(400);
  });

  it('runs widgets with the latest published metric version', async () => {
    const draft = (
      await client(app)
        .post(`/api/v1/metrics/${metric.id}/versions`, owner, org)
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
    await client(app)
      .post(`/api/v1/metric-versions/${draft.draft!.id}/publish`, owner, org)
      .expect(200);

    const detail = await getDash(analyst, orgDash.id);
    const widget = detail.widgets[0]!;
    expect(widget.savedMetricVersions).toEqual([{ key: 'paid_revenue', version: 1 }]);
    const result = (await run(analyst, widget.id).expect(200)).body as SemanticQueryResult;
    expect(result.metrics).toEqual([{ key: 'paid_revenue', version: 2 }]);
    expect(Object.fromEntries(result.rows.map((r) => [r[0], r[1]]))).toEqual({
      North: '150',
      South: '200',
    });
  });

  it('pins an answer of the caller’s own AI conversation', async () => {
    const ask = async (user: TestUser, question: string) => {
      const res = await client(app)
        .post('/api/v1/ai/ask', user, org)
        .send({ model: 'sales', question })
        .buffer(true)
        .parse((response, done) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (text += chunk));
          response.on('end', () => done(null, text));
        })
        .expect(200);
      const events = (res.body as string)
        .split('\n\n')
        .filter((c) => c.startsWith('data: '))
        .map((c) => JSON.parse(c.slice(6)) as AskEvent);
      const done = events.find((e) => e.type === 'done');
      return done?.type === 'done' ? done.messageId : '';
    };
    const answered = await ask(analyst, 'Doanh thu theo vùng?');
    const unclear = await ask(analyst, 'mơ hồ');
    const someoneElses = await ask(analyst2, 'Doanh thu theo vùng?');

    const pinned = (await addWidget(analyst, orgDash.id, { fromMessageId: answered }).expect(201))
      .body as DashboardDetail;
    const widget = pinned.widgets.at(-1)!;
    expect(widget).toMatchObject({
      sourceMessageId: answered,
      chart: { type: 'bar', x: 'customer.region' },
      query: { metrics: ['paid_revenue'], dimensions: ['customer.region'] },
    });
    expect(widget.title).toBe('Doanh thu');
    await addWidget(analyst, orgDash.id, { fromMessageId: someoneElses }).expect(404);
    await addWidget(analyst, orgDash.id, { fromMessageId: unclear }).expect(409);
  });

  it('isolates tenants', async () => {
    const widgetId = (await getDash(analyst, orgDash.id)).widgets[0]!.id;
    const other = outsider.organizationId!;
    await client(app).get(`/api/v1/dashboards/${orgDash.id}`, outsider, other).expect(404);
    await run(outsider, widgetId, other).expect(404);
    await client(app).delete(`/api/v1/dashboards/${orgDash.id}`, outsider, other).expect(404);
    // Another organization's id in the header without membership.
    await client(app).get('/api/v1/dashboards', outsider, org).expect(403);
  });

  it('enforces visibility in the database, not only in the service', async () => {
    loadAppConfig();
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const count = async (userId: string | null) => {
        await db.query('BEGIN');
        await db.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
        if (userId) await db.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
        const dashboards = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.dashboards WHERE visibility = 'PRIVATE'`,
        );
        const widgets = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.dashboard_widgets WHERE dashboard_id = $1`,
          [privateDash.id],
        );
        await db.query('ROLLBACK');
        return [dashboards.rows[0]!.n, widgets.rows[0]!.n];
      };
      expect(await count(null)).toEqual([0, 0]);
      expect(await count(owner.userId)).toEqual([0, 0]);
      expect(await count(analyst.userId)).toEqual([1, 2]);
      // Inserting a dashboard owned by someone else is refused.
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      await db.query(`SELECT set_config('app.user_id', $1, true)`, [analyst.userId]);
      await expect(
        db.query(
          `INSERT INTO app.dashboards (id, organization_id, owner_id, name, visibility, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'x', 'ORG', now())`,
          [org, owner.userId],
        ),
      ).rejects.toThrow(/row-level security/);
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
  });

  it('deletes dashboards with their widgets and records the audit trail', async () => {
    const widgetId = (await getDash(analyst, privateDash.id)).widgets[0]!.id;
    await client(app).delete(`/api/v1/dashboards/${privateDash.id}`, analyst2, org).expect(404);
    await client(app).delete(`/api/v1/dashboards/${privateDash.id}`, analyst, org).expect(204);
    await run(analyst, widgetId).expect(404);
    const audit = await admin.query<{ action: string }>(
      `SELECT action FROM app.audit_logs WHERE organization_id = $1 AND resource_type = 'dashboard'
        ORDER BY created_at`,
      [org],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'dashboard.created',
      'dashboard.created',
      'dashboard.deleted',
    ]);
  });

  async function getDash(user: TestUser, id: string) {
    return (await client(app).get(`/api/v1/dashboards/${id}`, user, org).expect(200))
      .body as DashboardDetail;
  }
});
