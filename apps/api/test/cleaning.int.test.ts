import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type {
  CleaningJob,
  CleaningOperationInput,
  CleaningPreview,
  CleaningSuggestions,
  DatasetDetail,
  ImportJob,
  QualityCheckSummary,
  RowsPage,
  VersionComparison,
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
 * 10 orders with known defects: padded and differently cased city names, a date in another
 * layout, a missing quantity, an exact duplicate row (6 = 5), a negative quantity, a missing price.
 */
const ORDERS_CSV = [
  'ma_don,ngay_dat,thanh_pho,so_luong,don_gia,ghi_chu',
  'DH1,2026-10-01,Ha Noi,2,100,x',
  'DH2,2026-10-02," Ha Noi ",1,100,x',
  'DH3,2026-10-03,ha noi,,100,x',
  'DH4,2026/10/04,HCM,3,100,x',
  'DH5,2026-10-05,HCM,4,100,x',
  'DH5,2026-10-05,HCM,4,100,x',
  'DH7,2026-10-07,Da Nang,-1,100,x',
  'DH8,2026-10-08,Ha Noi,5,,x',
  'DH9,2026-10-09,Ha Noi,6,100,x',
  'DH10,2026-10-10,HCM,7,100,x',
].join('\n');

/** The full recipe used by preview and apply (median of 2,1,3,4,4,-1,5,6,7 is 4). */
const RECIPE: CleaningOperationInput[] = [
  { type: 'trim_whitespace', columns: ['thanh_pho'] },
  { type: 'replace_values', column: 'thanh_pho', mapping: [{ from: 'ha noi', to: 'Ha Noi' }] },
  { type: 'parse_date', column: 'ngay_dat', formats: ['yyyy-MM-dd', 'yyyy/MM/dd'] },
  { type: 'fill_null', column: 'so_luong', strategy: 'median' },
  { type: 'deduplicate' },
  { type: 'drop_rows', condition: 'so_luong < 0' },
  { type: 'rename_column', column: 'ghi_chu', newName: 'note' },
];

describe('data cleaning (integration)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let admin: pg.Client;
  let owner: TestUser;
  let viewer: TestUser;
  let other: TestUser;
  let orgA: string;
  let datasetId: string;
  let sourceVersionId: string;
  let cleanedVersionId: string;
  let rangeRuleId: string;

  beforeAll(async () => {
    admin = await connectAdmin();
    app = await createTestApp();
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    owner = await registerUser(app, { label: 'cl-owner', organizationName: 'Cleaning Org' });
    other = await registerUser(app, { label: 'cl-other', organizationName: 'Cleaning Other' });
    orgA = owner.organizationId!;
    const invitation = await client(app)
      .post('/api/v1/invitations', owner, orgA)
      .send({ role: 'viewer' })
      .expect(201);
    viewer = await registerUser(app, {
      label: 'cl-viewer',
      invitationToken: invitation.body.token as string,
    });
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

  const detail = async () =>
    (await client(app).get(`/api/v1/datasets/${datasetId}`, owner, orgA).expect(200))
      .body as DatasetDetail;

  async function settledCheck(versionId: string): Promise<QualityCheckSummary> {
    return poll(
      async () =>
        (
          (await client(app).get(`/api/v1/datasets/${datasetId}/quality-checks`, owner, orgA))
            .body as QualityCheckSummary[]
        ).find((c) => c.versionId === versionId)!,
      (c) => c !== undefined && (c.status === 'SUCCEEDED' || c.status === 'FAILED'),
    );
  }

  async function rows(versionId: string): Promise<RowsPage> {
    return (
      await client(app)
        .get(`/api/v1/datasets/${datasetId}/rows?versionId=${versionId}&limit=50`, owner, orgA)
        .expect(200)
    ).body as RowsPage;
  }

  it('imports a dataset with known defects', async () => {
    const dataset = await client(app)
      .post('/api/v1/datasets', owner, orgA)
      .send({ name: 'orders to clean' })
      .expect(201);
    datasetId = dataset.body.id as string;
    const upload = await client(app)
      .post(`/api/v1/datasets/${datasetId}/imports`, owner, orgA)
      .attach('file', Buffer.from(ORDERS_CSV), 'orders.csv')
      .field('options', JSON.stringify({ locale: 'en', columnTypes: { ngay_dat: 'DATE' } }))
      .expect(202);
    const job = await poll(
      async () =>
        (await client(app).get(`/api/v1/imports/${upload.body.id}`, owner, orgA)).body as ImportJob,
      (j) => j.status === 'SUCCEEDED' || j.status === 'FAILED',
    );
    expect(job.status).toBe('SUCCEEDED');
    sourceVersionId = job.versionId!;

    // Rules the suggestions build on.
    await client(app)
      .post(`/api/v1/datasets/${datasetId}/quality-rules`, owner, orgA)
      .send({ name: 'Quantity present', definition: { type: 'not_null', column: 'so_luong' } })
      .expect(201);
    const range = await client(app)
      .post(`/api/v1/datasets/${datasetId}/quality-rules`, owner, orgA)
      .send({
        name: 'Quantity not negative',
        severity: 'error',
        definition: { type: 'range', column: 'so_luong', min: '0' },
      })
      .expect(201);
    rangeRuleId = range.body.id as string;

    await settledCheck(sourceVersionId);
    await client(app).post(`/api/v1/datasets/${datasetId}/quality-checks`, owner, orgA).expect(202);
    await poll(
      async () =>
        (
          (await client(app).get(`/api/v1/datasets/${datasetId}/quality-checks`, owner, orgA))
            .body as QualityCheckSummary[]
        )[0]!,
      (c) => c.trigger === 'MANUAL' && c.status === 'SUCCEEDED',
    );
    // Variant detection uses the column profile.
    await poll(detail, (d) => d.activeVersion?.profileStatus === 'SUCCEEDED');
  });

  it('suggests operations derived from the data and the failed rules', async () => {
    const res = await client(app)
      .get(`/api/v1/datasets/${datasetId}/cleaning/suggestions`, owner, orgA)
      .expect(200);
    const body = res.body as CleaningSuggestions;
    expect(body.versionId).toBe(sourceVersionId);
    const byId = new Map(body.suggestions.map((s) => [s.id, s]));

    expect(byId.get('trim_whitespace')).toMatchObject({
      operation: { type: 'trim_whitespace', columns: ['thanh_pho'] },
      estimatedRows: 1,
    });
    const variants = byId.get('replace_values:thanh_pho');
    expect(variants?.operation).toMatchObject({ type: 'replace_values', column: 'thanh_pho' });
    expect(variants?.operation.type === 'replace_values' && variants.operation.mapping).toEqual(
      expect.arrayContaining([
        { from: ' Ha Noi ', to: 'Ha Noi' },
        { from: 'ha noi', to: 'Ha Noi' },
      ]),
    );
    expect(byId.get('parse_date:ngay_dat')).toMatchObject({
      operation: { type: 'parse_date', formats: ['yyyy-MM-dd', 'yyyy/MM/dd'] },
      estimatedRows: 1,
    });
    expect(byId.get('fill_null:so_luong')).toMatchObject({
      operation: { strategy: 'median' },
      estimatedRows: 1,
    });
    expect(byId.get('deduplicate')).toMatchObject({ estimatedRows: 1 });
    expect(byId.get(`drop_rows:${rangeRuleId}`)).toMatchObject({
      operation: { type: 'drop_rows', ruleId: rangeRuleId },
      estimatedRows: 1,
    });
  });

  it('previews the exact impact of each operation without writing anything', async () => {
    const res = await client(app)
      .post(`/api/v1/datasets/${datasetId}/cleaning/preview`, owner, orgA)
      .send({ operations: RECIPE })
      .expect(200);
    const preview = res.body as CleaningPreview;

    expect(preview).toMatchObject({ rowCountBefore: 10, rowCountAfter: 8 });
    expect(preview.operations.map((o) => [o.affectedRows, o.removedRows])).toEqual([
      [1, 0], // trim " Ha Noi "
      [1, 0], // ha noi → Ha Noi
      [1, 0], // 2026/10/04
      [1, 0], // missing quantity → median 4
      [null, 1], // second DH5
      [null, 1], // negative quantity
      [null, 0], // rename
    ]);
    expect(preview.columns.find((c) => c.name === 'note')).toMatchObject({
      previousName: 'ghi_chu',
      status: 'renamed',
    });
    expect(preview.sample.columns).toEqual(['ngay_dat', 'thanh_pho', 'so_luong']);
    const row3 = preview.sample.rows.find((r) => r.rowId === 3)!;
    expect(row3).toMatchObject({
      removed: false,
      before: ['2026-10-03', 'ha noi', null],
      after: ['2026-10-03', 'Ha Noi', '4'],
    });
    expect(preview.sample.rows.find((r) => r.rowId === 4)?.after?.[0]).toBe('2026-10-04');
    expect(preview.sample.rows.find((r) => r.rowId === 7)).toMatchObject({
      removed: true,
      after: null,
    });

    // Removing the rows failing a rule.
    const byRule = await client(app)
      .post(`/api/v1/datasets/${datasetId}/cleaning/preview`, owner, orgA)
      .send({ operations: [{ type: 'drop_rows', ruleId: rangeRuleId }] })
      .expect(200);
    expect((byRule.body as CleaningPreview).rowCountAfter).toBe(9);

    // Nothing was written.
    expect((await detail()).versions).toHaveLength(1);
  });

  it('runs every operation type on PostgreSQL', async () => {
    const preview = async (operations: CleaningOperationInput[], versionId = sourceVersionId) =>
      (
        await client(app)
          .post(`/api/v1/datasets/${datasetId}/cleaning/preview`, owner, orgA)
          .send({ sourceVersionId: versionId, operations })
          .expect(200)
      ).body as CleaningPreview;
    const after = (p: CleaningPreview, rowId: number) =>
      p.sample.rows.find((r) => r.rowId === rowId)?.after;

    const filled = await preview([
      { type: 'fill_null', column: 'so_luong', strategy: 'previous' },
      { type: 'fill_null', column: 'don_gia', strategy: 'mean' },
    ]);
    expect(filled.sample.columns).toEqual(['so_luong', 'don_gia']);
    expect(after(filled, 3)).toEqual(['1', '100']); // previous row's quantity
    expect(after(filled, 8)).toEqual(['5', '100']); // mean of the prices

    const mode = await preview([
      { type: 'fill_null', column: 'so_luong', strategy: 'mode' },
      { type: 'fill_null', column: 'don_gia', strategy: 'constant', value: '0' },
    ]);
    expect(after(mode, 3)).toEqual(['4', '100']);
    expect(after(mode, 8)).toEqual(['5', '0']);

    const reshaped = await preview([
      { type: 'trim_whitespace', columns: ['thanh_pho'], collapseInner: true },
      { type: 'change_case', columns: ['thanh_pho'], mode: 'upper' },
      { type: 'cast_column', column: 'so_luong', targetType: 'DECIMAL' },
      { type: 'cast_column', column: 'ngay_dat', targetType: 'TEXT' },
      { type: 'deduplicate', keyColumns: ['ma_don'], keep: 'last' },
      { type: 'drop_column', column: 'ghi_chu' },
    ]);
    expect(reshaped.rowCountAfter).toBe(9);
    expect(reshaped.columns.find((c) => c.name === 'so_luong')).toMatchObject({
      dataType: 'DECIMAL',
      previousType: 'INTEGER',
      status: 'modified',
    });
    expect(reshaped.columns.find((c) => c.name === 'ghi_chu')?.status).toBe('removed');
    // The text cast re-reads the original value, including the invalid date.
    expect(after(reshaped, 4)).toEqual(['2026/10/04', 'HCM', '3']);
    expect(reshaped.sample.rows.find((r) => r.rowId === 5)).toMatchObject({ removed: true });
  });

  it('rejects invalid operations with the failing step', async () => {
    const cases: [CleaningOperationInput[], string][] = [
      [[{ type: 'trim_whitespace', columns: ['khong_co'] }], 'operations.0'],
      [[{ type: 'change_case', columns: ['so_luong'], mode: 'upper' }], 'operations.0'],
      [
        [
          { type: 'rename_column', column: 'ghi_chu', newName: 'note' },
          { type: 'trim_whitespace', columns: ['ghi_chu'] },
        ],
        'operations.1',
      ],
      [
        [{ type: 'fill_null', column: 'so_luong', strategy: 'constant', value: 'abc' }],
        'operations.0',
      ],
      [[{ type: 'drop_rows', condition: 'so_luong +' }], 'operations.0'],
      [[{ type: 'fill_null', column: 'thanh_pho', strategy: 'mean' }], 'operations.0'],
    ];
    for (const [operations, path] of cases) {
      const res = await client(app)
        .post(`/api/v1/datasets/${datasetId}/cleaning/preview`, owner, orgA)
        .send({ operations })
        .expect(400);
      expect(res.body.errors?.[0]?.path, JSON.stringify(operations)).toBe(path);
    }
  });

  it('enforces permissions and tenant isolation', async () => {
    await client(app)
      .get(`/api/v1/datasets/${datasetId}/cleaning/suggestions`, viewer, orgA)
      .expect(200);
    await client(app)
      .post(`/api/v1/datasets/${datasetId}/cleaning/preview`, viewer, orgA)
      .send({ operations: RECIPE })
      .expect(403);
    await client(app)
      .post(`/api/v1/datasets/${datasetId}/cleaning-jobs`, viewer, orgA)
      .send({ operations: RECIPE })
      .expect(403);
    await client(app)
      .post(`/api/v1/datasets/${datasetId}/cleaning/preview`, other, other.organizationId)
      .send({ operations: RECIPE })
      .expect(404);
  });

  it('applies the operations as a new version and re-validates it', async () => {
    const res = await client(app)
      .post(`/api/v1/datasets/${datasetId}/cleaning-jobs`, owner, orgA)
      .send({ operations: RECIPE })
      .expect(202);
    const job = await poll(
      async () =>
        (await client(app).get(`/api/v1/cleaning-jobs/${res.body.id}`, owner, orgA))
          .body as CleaningJob,
      (j) => j.status === 'SUCCEEDED' || j.status === 'FAILED',
    );
    expect(job).toMatchObject({ status: 'SUCCEEDED', sourceVersionId, sourceVersionNo: 1 });
    expect(job.operations.map((o) => [o.affectedRows, o.removedRows])).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
      [1, 0],
      [null, 1],
      [null, 1],
      [null, 0],
    ]);
    cleanedVersionId = job.targetVersionId!;

    // The new version exists next to the source, which stays active.
    const d = await detail();
    expect(d.activeVersion?.id).toBe(sourceVersionId);
    expect(d.versions[0]).toMatchObject({
      id: cleanedVersionId,
      versionNo: 2,
      origin: 'CLEANING',
      parentVersionId: sourceVersionId,
      cleaningJobId: job.id,
      rowCount: 8,
    });

    const page = await rows(cleanedVersionId);
    expect(page.columns.map((c) => [c.name, c.dataType])).toEqual([
      ['ma_don', 'TEXT'],
      ['ngay_dat', 'DATE'],
      ['thanh_pho', 'TEXT'],
      ['so_luong', 'INTEGER'],
      ['don_gia', 'INTEGER'],
      ['note', 'TEXT'],
    ]);
    expect(page.rows.map((r) => r.rowId)).toEqual([1, 2, 3, 4, 5, 8, 9, 10]);
    expect(page.rows.find((r) => r.rowId === 3)?.values).toEqual([
      'DH3',
      '2026-10-03',
      'Ha Noi',
      '4',
      '100',
      'x',
    ]);
    expect(new Set(page.rows.map((r) => r.values[2]))).toEqual(new Set(['Ha Noi', 'HCM']));
    // The source version is untouched.
    expect((await rows(sourceVersionId)).rows).toHaveLength(10);

    // Re-validation with the same rules.
    const check = await settledCheck(cleanedVersionId);
    expect(check).toMatchObject({ trigger: 'CLEANING', status: 'SUCCEEDED' });
  });

  it('compares the versions column by column and rule by rule', async () => {
    const res = await client(app)
      .get(
        `/api/v1/datasets/${datasetId}/versions/compare?base=${sourceVersionId}&target=${cleanedVersionId}`,
        owner,
        orgA,
      )
      .expect(200);
    const comparison = res.body as VersionComparison;
    // Rows 2 (trim), 3 (case + fill) and 4 (date).
    expect(comparison.rows).toEqual({ removed: 2, added: 0, changed: 3 });
    expect(comparison.base).toMatchObject({ versionNo: 1, rowCount: 10 });
    expect(comparison.target).toMatchObject({ versionNo: 2, rowCount: 8, origin: 'CLEANING' });
    const columns = new Map(comparison.columns.map((c) => [c.name, c]));
    expect(columns.get('thanh_pho')).toMatchObject({ status: 'unchanged', changedRows: 2 });
    expect(columns.get('note')).toMatchObject({ status: 'unchanged', changedRows: 0 });

    const rules = new Map(comparison.rules.map((r) => [r.ruleName, r]));
    expect(rules.get('Quantity present')).toMatchObject({ baseFailed: 1, targetFailed: 0 });
    expect(rules.get('Quantity not negative')).toMatchObject({ baseFailed: 1, targetFailed: 0 });
    const castable = comparison.rules.find(
      (r) => r.baseFailed === 1 && r.ruleName.includes('ngay_dat'),
    );
    expect(castable?.targetFailed).toBe(0);
    expect(comparison.target.qualityScore).toBeGreaterThan(comparison.base.qualityScore!);
  });

  it('cleans a cleaned version again (original values stay available)', async () => {
    const res = await client(app)
      .post(`/api/v1/datasets/${datasetId}/cleaning/preview`, owner, orgA)
      .send({
        sourceVersionId: cleanedVersionId,
        operations: [{ type: 'cast_column', column: 'note', targetType: 'BOOLEAN' }],
      })
      .expect(200);
    const preview = res.body as CleaningPreview;
    expect(preview).toMatchObject({ sourceVersionId: cleanedVersionId, rowCountBefore: 8 });
    expect(preview.operations[0]?.affectedRows).toBe(8); // "x" is not a boolean
  });

  it('activates the cleaned version and rolls back to the original', async () => {
    await client(app)
      .post(`/api/v1/datasets/${datasetId}/versions/${cleanedVersionId}/activate`, viewer, orgA)
      .expect(403);
    const activated = await client(app)
      .post(`/api/v1/datasets/${datasetId}/versions/${cleanedVersionId}/activate`, owner, orgA)
      .expect(200);
    expect(activated.body.activeVersion.id).toBe(cleanedVersionId);
    expect((await detail()).columns.map((c) => c.name)).toContain('note');

    await client(app)
      .post(`/api/v1/datasets/${datasetId}/versions/${sourceVersionId}/activate`, owner, orgA)
      .expect(200);
    const d = await detail();
    expect(d.activeVersion?.id).toBe(sourceVersionId);
    expect(d.versions).toHaveLength(2);

    const audit = await admin.query<{ action: string }>(
      `SELECT action FROM app.audit_logs WHERE resource_id = $1 ORDER BY created_at`,
      [datasetId],
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('cleaning.requested');
    expect(actions.filter((a) => a === 'dataset.version_activated')).toHaveLength(2);
  });

  it('keeps the cleaning history immutable for the application role', async () => {
    const jobs = (
      await client(app).get(`/api/v1/datasets/${datasetId}/cleaning-jobs`, owner, orgA).expect(200)
    ).body as CleaningJob[];
    expect(jobs).toHaveLength(1);
    const grants = await admin.query<{ privilege_type: string; table_name: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'app' AND table_name IN ('cleaning_jobs', 'cleaning_operations')
          AND grantee = (SELECT usename FROM pg_user WHERE usename LIKE '%app%' AND usename NOT LIKE '%owner%' LIMIT 1)`,
    );
    const privileges = grants.rows.map((g) => `${g.table_name}:${g.privilege_type}`);
    expect(privileges).not.toContain('cleaning_jobs:DELETE');
    expect(privileges).not.toContain('cleaning_operations:DELETE');
    expect(privileges).not.toContain('cleaning_operations:UPDATE');
  });
});
