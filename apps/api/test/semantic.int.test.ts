import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ImportJob, SemanticModelDetail, SemanticModelSummary } from '@insightai/contracts';
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
  'O2,C2,2026-10-02,PAID,250.5',
  'O3,C9,2026-10-03,PENDING,80',
  'O4,C1,2026-10-04,PAID,10',
].join('\n');
const CUSTOMERS = ['customer_id,region', 'C1,North', 'C2,South', 'C3,North'].join('\n');
/** C1 appears twice: not usable as the "one" side of a relationship. */
const CUSTOMERS_DUP = ['customer_id,region', 'C1,North', 'C1,South', 'C2,South'].join('\n');

describe('semantic models (integration)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let admin: pg.Client;
  let owner: TestUser;
  let analyst: TestUser;
  let viewer: TestUser;
  let other: TestUser;
  let org: string;
  const datasets: Record<string, string> = {};
  let model: SemanticModelDetail;

  beforeAll(async () => {
    admin = await connectAdmin();
    app = await createTestApp();
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    owner = await registerUser(app, { label: 'sem-owner', organizationName: 'Semantic Org' });
    other = await registerUser(app, { label: 'sem-other', organizationName: 'Semantic Other' });
    org = owner.organizationId!;
    const invite = async (role: string) =>
      (await client(app).post('/api/v1/invitations', owner, org).send({ role }).expect(201)).body
        .token as string;
    analyst = await registerUser(app, {
      label: 'sem-analyst',
      invitationToken: await invite('analyst'),
    });
    viewer = await registerUser(app, {
      label: 'sem-viewer',
      invitationToken: await invite('viewer'),
    });

    for (const [name, csv] of [
      ['orders', ORDERS],
      ['customers', CUSTOMERS],
      ['customers_dup', CUSTOMERS_DUP],
    ] as const) {
      const dataset = await client(app)
        .post('/api/v1/datasets', owner, org)
        .send({ name })
        .expect(201);
      const upload = await client(app)
        .post(`/api/v1/datasets/${dataset.body.id}/imports`, owner, org)
        .attach('file', Buffer.from(`${csv}\n`), `${name}.csv`)
        .field('options', JSON.stringify({ locale: 'en' }))
        .expect(202);
      for (let i = 0; i < 150; i++) {
        const job = (await client(app).get(`/api/v1/imports/${upload.body.id}`, owner, org))
          .body as ImportJob;
        if (job.status === 'SUCCEEDED') break;
        if (job.status === 'FAILED') throw new Error(`import failed: ${JSON.stringify(job.error)}`);
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

  const post = (path: string, body: object, user = analyst) =>
    client(app).post(`/api/v1${path}`, user, org).send(body);
  const entity = (key: string) => model.entities.find((e) => e.key === key)!;

  it('builds a draft model: entities, dimensions, measures and a relationship', async () => {
    model = (await post('/semantic-models', { key: 'sales', name: 'Bán hàng' }).expect(201)).body;
    expect(model).toMatchObject({
      status: 'DRAFT',
      revision: 0,
      hasDraftChanges: true,
      validationStatus: 'UNVALIDATED',
    });

    model = (
      await post(`/semantic-models/${model.id}/entities`, {
        key: 'order',
        name: 'Đơn hàng',
        datasetId: datasets.orders,
        primaryKey: ['order_id'],
      }).expect(201)
    ).body;
    model = (
      await post(`/semantic-models/${model.id}/entities`, {
        key: 'customer',
        name: 'Khách hàng',
        datasetId: datasets.customers,
        primaryKey: ['customer_id'],
      }).expect(201)
    ).body;
    const orderId = entity('order').id;
    await post(`/semantic-entities/${orderId}/dimensions`, {
      key: 'order_date',
      name: 'Ngày đặt',
      type: 'TIME',
      expr: 'created_at',
    }).expect(201);
    await post(`/semantic-entities/${orderId}/dimensions`, {
      key: 'status',
      name: 'Trạng thái',
      type: 'CATEGORICAL',
      expr: 'status',
    }).expect(201);
    await post(`/semantic-entities/${orderId}/measures`, {
      key: 'revenue',
      name: 'Doanh thu',
      agg: 'sum',
      expr: 'amount',
    }).expect(201);
    await post(`/semantic-entities/${orderId}/measures`, {
      key: 'order_count',
      name: 'Số đơn',
      agg: 'count',
    }).expect(201);
    await post(`/semantic-entities/${entity('customer').id}/dimensions`, {
      key: 'region',
      name: 'Vùng',
      type: 'CATEGORICAL',
      expr: 'region',
    }).expect(201);
    model = (
      await post(`/semantic-models/${model.id}/relationships`, {
        fromEntityId: orderId,
        toEntityId: entity('customer').id,
        joinColumns: [{ from: 'customer_id', to: 'customer_id' }],
        cardinality: 'MANY_TO_ONE',
      }).expect(201)
    ).body;

    expect(entity('order').dimensions.map((d) => [d.key, d.granularities.length])).toEqual([
      ['order_date', 5],
      ['status', 0],
    ]);
    expect(entity('order').measures.map((m) => [m.key, m.agg, m.expr])).toEqual([
      ['revenue', 'sum', 'amount'],
      ['order_count', 'count', null],
    ]);
    expect(model.relationships).toHaveLength(1);
  });

  it('keeps keys unique and members consistent', async () => {
    const orderId = entity('order').id;
    await post(`/semantic-models/${model.id}/entities`, {
      key: 'order',
      name: 'x',
      datasetId: datasets.orders,
      primaryKey: ['order_id'],
    }).expect(409);
    // Dimensions and measures share one namespace per entity.
    await post(`/semantic-entities/${orderId}/measures`, {
      key: 'status',
      name: 'x',
      agg: 'count',
    }).expect(409);
    await post(`/semantic-entities/${orderId}/measures`, {
      key: 'x',
      name: 'x',
      agg: 'sum',
    }).expect(400);
    await post(`/semantic-models`, { key: 'Bad Key', name: 'x' }).expect(400);
    await post(`/semantic-models/${model.id}/relationships`, {
      fromEntityId: orderId,
      toEntityId: orderId,
      joinColumns: [{ from: 'customer_id', to: 'customer_id' }],
      cardinality: 'MANY_TO_ONE',
    }).expect(400);
  });

  it('validates the draft: orphan join values are a warning', async () => {
    model = (await post(`/semantic-models/${model.id}/validate`, {}).expect(200)).body;
    expect(model.validationStatus).toBe('WARNING');
    expect(model.validationReport?.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'RELATIONSHIP_ORPHANS',
        message: '1 of 4 row(s) have no match on the "one" side',
      }),
    ]);
  });

  it('publishes a snapshot; later edits only change the draft', async () => {
    await post(`/semantic-models/${model.id}/publish`, {}, analyst).expect(403);
    model = (await post(`/semantic-models/${model.id}/publish`, {}, owner).expect(200)).body;
    expect(model).toMatchObject({
      status: 'PUBLISHED',
      revision: 1,
      hasDraftChanges: false,
      validationStatus: 'WARNING',
    });
    const snapshot = await admin.query<{ s: { revision: number; entities: { key: string }[] } }>(
      'SELECT published_snapshot AS s FROM app.semantic_models WHERE id = $1',
      [model.id],
    );
    expect(snapshot.rows[0]!.s.revision).toBe(1);
    expect(snapshot.rows[0]!.s.entities.map((e) => e.key)).toEqual(['order', 'customer']);

    model = (
      await client(app)
        .patch(`/api/v1/semantic-models/${model.id}`, analyst, org)
        .send({ description: 'Mô hình bán hàng' })
        .expect(200)
    ).body;
    expect(model).toMatchObject({
      status: 'PUBLISHED',
      revision: 1,
      hasDraftChanges: true,
      validationStatus: 'UNVALIDATED',
      validationReport: null,
    });
  });

  it('blocks publishing with errors and keeps the report', async () => {
    const orderId = entity('order').id;
    const bad = (
      await post(`/semantic-entities/${orderId}/measures`, {
        key: 'bad_sum',
        name: 'x',
        agg: 'sum',
        expr: 'status',
      }).expect(201)
    ).body as SemanticModelDetail;
    const badId = bad.entities
      .find((e) => e.key === 'order')!
      .measures.find((m) => m.key === 'bad_sum')!.id;
    // Join on a non-unique "one" side and an entity whose key repeats.
    const dup = (
      await post(`/semantic-models/${model.id}/entities`, {
        key: 'customer_dup',
        name: 'x',
        datasetId: datasets.customers_dup,
        primaryKey: ['customer_id'],
      }).expect(201)
    ).body as SemanticModelDetail;
    const dupId = dup.entities.find((e) => e.key === 'customer_dup')!.id;
    await post(`/semantic-models/${model.id}/relationships`, {
      fromEntityId: orderId,
      toEntityId: dupId,
      joinColumns: [{ from: 'customer_id', to: 'customer_id' }],
      cardinality: 'MANY_TO_ONE',
    }).expect(201);

    const res = await post(`/semantic-models/${model.id}/publish`, {}, owner).expect(409);
    expect(res.body.code).toBe('CONFLICT');
    const after = (
      await client(app).get(`/api/v1/semantic-models/${model.id}`, viewer, org).expect(200)
    ).body as SemanticModelDetail;
    expect(after.validationStatus).toBe('INVALID');
    expect(after.revision).toBe(1); // the published snapshot is untouched
    expect(after.validationReport?.issues.map((i) => `${i.code}@${i.path}`)).toEqual(
      expect.arrayContaining(['MEASURE_TYPE@order.bad_sum', 'PRIMARY_KEY_DUPLICATE@customer_dup']),
    );

    // Removing the problems makes the model publishable again.
    await client(app).delete(`/api/v1/semantic-measures/${badId}`, analyst, org).expect(200);
    await client(app).delete(`/api/v1/semantic-entities/${dupId}`, analyst, org).expect(200);
    model = (await post(`/semantic-models/${model.id}/publish`, {}, owner).expect(200)).body;
    expect(model.revision).toBe(2);
    expect(model.relationships).toHaveLength(1); // the relationship went with the entity
  });

  it('reports ambiguous relationships', async () => {
    const orderId = entity('order').id;
    const customerId = entity('customer').id;
    const second = (
      await post(`/semantic-models/${model.id}/relationships`, {
        fromEntityId: orderId,
        toEntityId: customerId,
        joinColumns: [{ from: 'customer_id', to: 'customer_id' }],
        cardinality: 'MANY_TO_ONE',
      }).expect(201)
    ).body as SemanticModelDetail;
    const validated = (await post(`/semantic-models/${model.id}/validate`, {}).expect(200))
      .body as SemanticModelDetail;
    expect(validated.validationReport?.issues.map((i) => i.code)).toContain(
      'RELATIONSHIP_AMBIGUOUS',
    );

    const newest = second.relationships.at(-1)!;
    await client(app)
      .patch(`/api/v1/semantic-relationships/${newest.id}`, analyst, org)
      .send({ preferred: true })
      .expect(200);
    const fixed = (await post(`/semantic-models/${model.id}/validate`, {}).expect(200))
      .body as SemanticModelDetail;
    expect(fixed.validationReport?.issues.map((i) => i.code)).not.toContain(
      'RELATIONSHIP_AMBIGUOUS',
    );
  });

  it('enforces permissions, tenant isolation and audit', async () => {
    const list = (await client(app).get('/api/v1/semantic-models', viewer, org).expect(200))
      .body as SemanticModelSummary[];
    expect(list.map((m) => [m.key, m.entityCount])).toEqual([['sales', 2]]);
    await post('/semantic-models', { key: 'x', name: 'x' }, viewer).expect(403);
    await client(app)
      .get(`/api/v1/semantic-models/${model.id}`, other, other.organizationId)
      .expect(404);
    await client(app)
      .delete(`/api/v1/semantic-entities/${entity('order').id}`, other, other.organizationId)
      .expect(404);
    // Another organization cannot use this organization's dataset.
    const foreign = (
      await client(app)
        .post('/api/v1/semantic-models', other, other.organizationId)
        .send({ key: 'sales', name: 'x' })
        .expect(201)
    ).body as SemanticModelDetail;
    await client(app)
      .post(`/api/v1/semantic-models/${foreign.id}/entities`, other, other.organizationId)
      .send({ key: 'order', name: 'x', datasetId: datasets.orders, primaryKey: ['order_id'] })
      .expect(404);

    const audit = await admin.query<{ action: string }>(
      `SELECT DISTINCT action FROM app.audit_logs WHERE resource_id = $1`,
      [model.id],
    );
    expect(audit.rows.map((r) => r.action).sort()).toEqual([
      'semantic.model_changed',
      'semantic.model_created',
      'semantic.model_published',
      'semantic.model_updated',
    ]);
  });
});
