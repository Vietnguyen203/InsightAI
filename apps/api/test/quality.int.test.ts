import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type {
  CreateRuleRequest,
  ImportJob,
  QualityCheckDetail,
  QualityCheckSummary,
  QualityRule,
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
 * 46 orders: 40 clean rows followed by rows with known defects, so every rule has an exact
 * expected failure count.
 */
function ordersCsv(): string {
  const header = 'ma_don,ngay_dat,ngay_tt,trang_thai,so_luong,don_gia,thanh_tien,ma_kh';
  const clean = Array.from({ length: 40 }, (_, k) => {
    const i = k + 1;
    const qty = (i % 5) + 1;
    const day = String((i % 28) + 1).padStart(2, '0');
    return `DH${i},2026-10-${day},2026-10-${day},PAID,${qty},100,${qty * 100},KH${(i % 5) + 1}`;
  });
  const defects = [
    'DH41,2026-10-02,,PAID,1,50,50,KH2', // A: paid without payment date
    'DH42,2026-10-03,2026-10-01,PENDING,3,10,31,KH9', // B: paid before ordered, wrong total, unknown customer
    'DH42,2026-10-04,2026-10-05,REFUNDED,1,5,5,KH1', // C: duplicate order id, status not allowed
    'DH44,2026-13-45,2026-10-05,PAID,-1,5,-5,', // D: impossible date, negative quantity, no customer
    clean[0]!, // E: exact copy of the first row
    'X99,2026-10-06,2026-10-06,PAID,1,1,1,KH1', // F: malformed order id
  ];
  return [header, ...clean, ...defects].join('\n') + '\n';
}

describe('data quality (integration)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let admin: pg.Client;
  let owner: TestUser;
  let other: TestUser;
  let orgA: string;
  let ordersId: string;
  let customersId: string;
  let checkId: string;

  beforeAll(async () => {
    admin = await connectAdmin();
    app = await createTestApp();
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    owner = await registerUser(app, { label: 'dq-owner', organizationName: 'DQ Org' });
    other = await registerUser(app, { label: 'dq-other', organizationName: 'DQ Other' });
    orgA = owner.organizationId!;
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    if (admin) {
      await cleanupTestData(admin);
      await admin.end();
    }
  });

  async function poll<T>(fetch: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    for (let i = 0; i < 150; i++) {
      const value = await fetch();
      if (done(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Timed out');
  }

  async function createDatasetWith(name: string, csv: string): Promise<string> {
    const dataset = await client(app)
      .post('/api/v1/datasets', owner, orgA)
      .send({ name })
      .expect(201);
    const upload = await client(app)
      .post(`/api/v1/datasets/${dataset.body.id}/imports`, owner, orgA)
      .attach('file', Buffer.from(csv), `${name}.csv`)
      .field('options', JSON.stringify({ locale: 'en' }))
      .expect(202);
    const job = await poll(
      async () =>
        (await client(app).get(`/api/v1/imports/${upload.body.id}`, owner, orgA)).body as ImportJob,
      (j) => j.status === 'SUCCEEDED' || j.status === 'FAILED',
    );
    expect(job.status).toBe('SUCCEEDED');
    return dataset.body.id as string;
  }

  const finished = (c: QualityCheckSummary) => c.status === 'SUCCEEDED' || c.status === 'FAILED';

  async function latestCheck(datasetId: string): Promise<QualityCheckSummary> {
    return poll(
      async () =>
        (
          (await client(app).get(`/api/v1/datasets/${datasetId}/quality-checks`, owner, orgA))
            .body as QualityCheckSummary[]
        )[0]!,
      (c) => c !== undefined && finished(c),
    );
  }

  async function addRule(rule: CreateRuleRequest, expectStatus = 201) {
    return client(app)
      .post(`/api/v1/datasets/${ordersId}/quality-rules`, owner, orgA)
      .send(rule)
      .expect(expectStatus);
  }

  it('checks every import automatically with system rules', async () => {
    customersId = await createDatasetWith(
      'customers',
      'ma_kh,ten\nKH1,An\nKH2,Bình\nKH3,Chi\nKH4,Dũng\nKH5,Em\n',
    );
    ordersId = await createDatasetWith('orders', ordersCsv());

    const check = await latestCheck(ordersId);
    expect(check).toMatchObject({
      trigger: 'IMPORT',
      status: 'SUCCEEDED',
      qualityStatus: 'WARNING',
    });

    const rules = (
      await client(app).get(`/api/v1/datasets/${ordersId}/quality-rules`, owner, orgA).expect(200)
    ).body as QualityRule[];
    expect(rules.every((r) => r.origin === 'system')).toBe(true);
    expect(
      rules
        .map((r) => r.definition)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual([
      { type: 'duplicate_rows' },
      { type: 'type_castable', column: 'don_gia' },
      { type: 'type_castable', column: 'ngay_dat' },
      { type: 'type_castable', column: 'ngay_tt' },
      { type: 'type_castable', column: 'so_luong' },
      { type: 'type_castable', column: 'thanh_tien' },
    ]);

    const dataset = (await client(app).get(`/api/v1/datasets/${ordersId}`, owner, orgA).expect(200))
      .body;
    expect(dataset.activeVersion).toBeDefined();
  });

  it('validates rules before saving them', async () => {
    const bad = async (definition: object, message: RegExp) => {
      const res = await addRule({ name: 'x', definition } as CreateRuleRequest, 400);
      expect(res.body.detail ?? JSON.stringify(res.body.errors)).toMatch(message);
    };
    await bad({ type: 'regex', column: 'ma_don', pattern: '([a-' }, /Invalid pattern/);
    await bad({ type: 'expression', expr: 'so_luong > ' }, /Unexpected end/);
    await bad({ type: 'expression', expr: "so_luong = 'abc'" }, /Cannot compare/);
    await bad({ type: 'not_null', column: 'khong_ton_tai' }, /does not exist/);
    await bad({ type: 'range', column: 'so_luong', min: '1; DROP TABLE x' }, /not a number/);
    await bad({ type: 'duplicate_rows' }, /created automatically/);
    await bad(
      { type: 'foreign_key', column: 'ma_kh', refDatasetId: customersId, refColumn: 'khong_co' },
      /does not exist in the referenced dataset/,
    );

    const valid = await client(app)
      .post(`/api/v1/datasets/${ordersId}/expressions/validate`, owner, orgA)
      .send({ expr: 'ngay_tt >= ngay_dat' })
      .expect(200);
    expect(valid.body).toEqual({ valid: true, type: 'boolean', columns: ['ngay_tt', 'ngay_dat'] });
    const invalid = await client(app)
      .post(`/api/v1/datasets/${ordersId}/expressions/validate`, owner, orgA)
      .send({ expr: 'ngay_tt >= ' })
      .expect(200);
    expect(invalid.body).toMatchObject({
      valid: false,
      error: { message: expect.stringMatching(/Unexpected end/) },
    });
  });

  it('evaluates every rule type with exact counts and samples', async () => {
    const rules: CreateRuleRequest[] = [
      {
        name: 'Có mã khách hàng',
        definition: { type: 'not_null', column: 'ma_kh' },
        severity: 'error',
      },
      {
        name: 'Mã đơn duy nhất',
        definition: { type: 'unique', columns: ['ma_don'] },
        severity: 'error',
      },
      {
        name: 'Trạng thái hợp lệ',
        definition: {
          type: 'allowed_values',
          column: 'trang_thai',
          values: ['paid', 'pending', 'cancelled'],
          caseSensitive: false,
        },
      },
      { name: 'Số lượng không âm', definition: { type: 'range', column: 'so_luong', min: '0' } },
      {
        name: 'Định dạng mã đơn',
        definition: { type: 'regex', column: 'ma_don', pattern: '^DH[0-9]+$' },
      },
      { name: 'Mã đơn tối đa 10 ký tự', definition: { type: 'length', column: 'ma_don', max: 10 } },
      {
        name: 'Đã thanh toán phải có ngày thanh toán',
        definition: {
          type: 'expression',
          expr: "CASE WHEN trang_thai = 'PAID' THEN ngay_tt IS NOT NULL ELSE TRUE END",
        },
      },
      {
        name: 'Thanh toán sau khi đặt',
        definition: { type: 'expression', expr: 'ngay_tt >= ngay_dat' },
      },
      {
        name: 'Thành tiền = số lượng × đơn giá',
        definition: { type: 'expression', expr: 'abs(thanh_tien - so_luong * don_gia) <= 0.01' },
        severity: 'info',
      },
      {
        name: 'Khách hàng tồn tại',
        definition: {
          type: 'foreign_key',
          column: 'ma_kh',
          refDatasetId: customersId,
          refColumn: 'ma_kh',
        },
      },
    ];
    for (const rule of rules) await addRule(rule);

    const started = await client(app)
      .post(`/api/v1/datasets/${ordersId}/quality-checks`, owner, orgA)
      .expect(202);
    expect(started.body).toMatchObject({ trigger: 'MANUAL', status: 'PENDING' });
    checkId = started.body.id;
    await latestCheck(ordersId);

    const check = (
      await client(app).get(`/api/v1/quality-checks/${checkId}`, owner, orgA).expect(200)
    ).body as QualityCheckDetail;
    expect(check).toMatchObject({ status: 'SUCCEEDED', qualityStatus: 'FAILED', rulesTotal: 16 });

    const byName = Object.fromEntries(check.results.map((r) => [r.ruleName, r]));
    const expectRule = (
      name: string,
      evaluated: number,
      failed: number,
      status = failed > 0 ? 'FAILED' : 'PASSED',
    ) =>
      expect(byName[name], name).toMatchObject({
        evaluatedCount: evaluated,
        failedCount: failed,
        status,
      });

    expectRule('Có mã khách hàng', 46, 1);
    expectRule('Mã đơn duy nhất', 46, 4); // DH1 ×2 and DH42 ×2
    expectRule('Trạng thái hợp lệ', 46, 1);
    expectRule('Số lượng không âm', 46, 1);
    expectRule('Định dạng mã đơn', 46, 1);
    expectRule('Mã đơn tối đa 10 ký tự', 46, 0);
    expectRule('Đã thanh toán phải có ngày thanh toán', 46, 1);
    expectRule('Thanh toán sau khi đặt', 46, 1); // NULL dates are unknown, not violations
    expectRule('Thành tiền = số lượng × đơn giá', 46, 1);
    expectRule('Khách hàng tồn tại', 45, 1);
    expectRule('Không có dòng trùng lặp hoàn toàn', 46, 2);
    expectRule('Giá trị của "ngay_dat" đúng kiểu dữ liệu', 46, 1);
    expectRule('Giá trị của "ngay_tt" đúng kiểu dữ liệu', 45, 0);

    // Failed rules come first in the report.
    expect(check.results[0]?.status).toBe('FAILED');
    expect(check.score).toBeGreaterThan(90);
    expect(check.score).toBeLessThan(100);
    expect(Object.keys(check.dimensionScores).sort()).toEqual([
      'completeness',
      'consistency',
      'referential_integrity',
      'uniqueness',
      'validity',
    ]);

    const issues = async (name: string) =>
      (
        await client(app)
          .get(`/api/v1/quality-checks/${checkId}/results/${byName[name]!.id}/issues`, owner, orgA)
          .expect(200)
      ).body.items;
    expect(await issues('Mã đơn duy nhất')).toEqual([
      { rowId: 1, column: 'ma_don', value: 'DH1', rawValue: null },
      { rowId: 42, column: 'ma_don', value: 'DH42', rawValue: null },
      { rowId: 43, column: 'ma_don', value: 'DH42', rawValue: null },
      { rowId: 45, column: 'ma_don', value: 'DH1', rawValue: null },
    ]);
    // The impossible date is NULL in the typed table; the original text comes from the raw table.
    expect(await issues('Giá trị của "ngay_dat" đúng kiểu dữ liệu')).toEqual([
      { rowId: 44, column: 'ngay_dat', value: null, rawValue: '2026-13-45' },
    ]);
    expect(await issues('Khách hàng tồn tại')).toEqual([
      { rowId: 42, column: 'ma_kh', value: 'KH9', rawValue: null },
    ]);
  });

  it('records the result on the version', async () => {
    const dataset = (await client(app).get(`/api/v1/datasets/${ordersId}`, owner, orgA).expect(200))
      .body;
    const row = await admin.query<{ quality_status: string; quality_score: string }>(
      'SELECT quality_status, quality_score FROM app.dataset_versions WHERE id = $1',
      [dataset.activeVersion.id],
    );
    expect(row.rows[0]?.quality_status).toBe('FAILED');
    expect(Number(row.rows[0]?.quality_score)).toBeGreaterThan(90);
  });

  it('respects disabled rules and protects system rules', async () => {
    const rules = (
      await client(app).get(`/api/v1/datasets/${ordersId}/quality-rules`, owner, orgA).expect(200)
    ).body as QualityRule[];
    const system = rules.find((r) => r.origin === 'system')!;
    await client(app).delete(`/api/v1/quality-rules/${system.id}`, owner, orgA).expect(409);
    await client(app)
      .patch(`/api/v1/quality-rules/${system.id}`, owner, orgA)
      .send({ enabled: false })
      .expect(200);

    const user = rules.find((r) => r.name === 'Mã đơn tối đa 10 ký tự')!;
    await client(app).delete(`/api/v1/quality-rules/${user.id}`, owner, orgA).expect(204);

    // The earlier report still shows the deleted rule from its snapshot.
    const old = (
      await client(app).get(`/api/v1/quality-checks/${checkId}`, owner, orgA).expect(200)
    ).body as QualityCheckDetail;
    expect(old.results.find((r) => r.ruleName === 'Mã đơn tối đa 10 ký tự')).toMatchObject({
      ruleId: null,
    });

    await client(app).post(`/api/v1/datasets/${ordersId}/quality-checks`, owner, orgA).expect(202);
    const next = await latestCheck(ordersId);
    expect(next.rulesTotal).toBe(14);
  });

  it('isolates tenants and enforces permissions', async () => {
    await client(app)
      .get(`/api/v1/quality-checks/${checkId}`, other, other.organizationId)
      .expect(404);
    await client(app)
      .get(`/api/v1/datasets/${ordersId}/quality-rules`, other, other.organizationId)
      .expect(404);
    // A foreign key cannot point at another organization's dataset.
    const otherDataset = await client(app)
      .post('/api/v1/datasets', other, other.organizationId)
      .send({ name: 'x' })
      .expect(201);
    const res = await addRule(
      {
        name: 'x',
        definition: {
          type: 'foreign_key',
          column: 'ma_kh',
          refDatasetId: otherDataset.body.id,
          refColumn: 'ma_kh',
        },
      },
      400,
    );
    expect(res.body.detail).toMatch(/referenced dataset does not exist/);
  });
});
