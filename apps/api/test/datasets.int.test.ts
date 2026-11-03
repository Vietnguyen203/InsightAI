import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { DatasetDetail, ImportJob, RowsPage } from '@insightai/contracts';
import ExcelJS from 'exceljs';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImportRunnerService } from '../src/modules/import/import-runner.service';
import { WorkerModule } from '../src/worker.module';
import { connectAdmin } from './support/admin-db';
import {
  cleanupTestData,
  client,
  createTestApp,
  registerUser,
  type TestUser,
} from './support/test-app';

const MAX_ROWS = 50;
const MAX_FILE_BYTES = 200_000;

/** A realistic Vietnamese export: BOM, `;` separator, VN number/date formats, quoted newline. */
const VN_CSV =
  '﻿' +
  [
    'Mã đơn;Ngày đặt;Doanh thu (VNĐ);Số lượng;Điện thoại;Đã thanh toán;Ghi chú',
    'DH001;15/10/2026;1.234.567,5;3;0912345678;Có;"Giao; trước 9h"',
    'DH002;01/11/2026;250.000;1;0987654321;Không;',
    'DH003;31/02/2026;99,75;12;0901111222;có;"Dòng 1\nDòng 2"',
    'DH004;05/11/2026;0;2;0933444555;không;Bình thường',
  ].join('\r\n') +
  '\r\n';

describe('datasets and imports (integration)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let admin: pg.Client;
  let owner: TestUser;
  let other: TestUser;
  let orgA: string;
  let datasetId: string;

  beforeAll(async () => {
    process.env.IMPORT_MAX_ROWS = String(MAX_ROWS);
    process.env.IMPORT_MAX_FILE_BYTES = String(MAX_FILE_BYTES);
    admin = await connectAdmin();
    app = await createTestApp();
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    owner = await registerUser(app, { label: 'data-owner', organizationName: 'Data Org' });
    other = await registerUser(app, { label: 'data-other', organizationName: 'Other Org' });
    orgA = owner.organizationId!;
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    delete process.env.IMPORT_MAX_ROWS;
    delete process.env.IMPORT_MAX_FILE_BYTES;
    if (admin) {
      await cleanupTestData(admin);
      await admin.end();
    }
  });

  async function waitForImport(importId: string): Promise<ImportJob> {
    for (let i = 0; i < 100; i++) {
      const res = await client(app).get(`/api/v1/imports/${importId}`, owner, orgA).expect(200);
      const job = res.body as ImportJob;
      if (job.status === 'SUCCEEDED' || job.status === 'FAILED') return job;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Import did not finish in time');
  }

  function upload(filename: string, content: Buffer | string, options?: object) {
    const req = client(app)
      .post(`/api/v1/datasets/${datasetId}/imports`, owner, orgA)
      .attach('file', Buffer.from(content), filename);
    if (options) req.field('options', JSON.stringify(options));
    return req;
  }

  async function detail(): Promise<DatasetDetail> {
    return (await client(app).get(`/api/v1/datasets/${datasetId}`, owner, orgA).expect(200)).body;
  }

  it('creates an empty dataset', async () => {
    const res = await client(app)
      .post('/api/v1/datasets', owner, orgA)
      .send({ name: 'Đơn hàng', description: 'Xuất từ phần mềm bán hàng' })
      .expect(201);
    datasetId = res.body.id;
    expect(res.body).toMatchObject({ status: 'DRAFT', activeVersion: null, latestImport: null });
  });

  it('imports a Vietnamese CSV and infers column types', async () => {
    const res = await upload('don-hang.csv', VN_CSV, { locale: 'vi' }).expect(202);
    expect(res.body).toMatchObject({ status: 'PENDING', dataSource: { fileFormat: 'csv' } });

    const job = await waitForImport(res.body.id);
    expect(job).toMatchObject({ status: 'SUCCEEDED', rowsRead: 4, error: null });
    expect(job.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['COLUMNS_RENAMED', 'INVALID_VALUES']),
    );

    const dataset = await detail();
    expect(dataset.status).toBe('READY');
    expect(dataset.activeVersion).toMatchObject({ versionNo: 1, rowCount: 4, origin: 'IMPORT' });
    const types = Object.fromEntries(dataset.columns.map((c) => [c.name, c.dataType]));
    expect(types).toEqual({
      ma_don: 'TEXT',
      ngay_dat: 'DATE',
      doanh_thu_vnd: 'DECIMAL',
      so_luong: 'INTEGER',
      dien_thoai: 'TEXT', // leading zero ⇒ identifier, not a number
      da_thanh_toan: 'BOOLEAN',
      ghi_chu: 'TEXT',
    });
    const date = dataset.columns.find((c) => c.name === 'ngay_dat');
    expect(date).toMatchObject({ detectedFormat: 'dd/MM/yyyy', nonEmptyCount: 4, invalidCount: 1 });
    expect(dataset.columns[2]?.originalName).toBe('Doanh thu (VNĐ)');
  });

  it('previews exact values with keyset pagination', async () => {
    const first = (
      await client(app).get(`/api/v1/datasets/${datasetId}/rows?limit=2`, owner, orgA).expect(200)
    ).body as RowsPage;
    expect(first.rows.map((r) => r.rowId)).toEqual([1, 2]);
    expect(first.nextAfter).toBe(2);
    expect(first.rows[0]?.values).toEqual([
      'DH001',
      '2026-10-15',
      '1234567.5',
      '3',
      '0912345678',
      'true',
      'Giao; trước 9h',
    ]);

    const second = (
      await client(app)
        .get(`/api/v1/datasets/${datasetId}/rows?limit=2&after=${first.nextAfter}`, owner, orgA)
        .expect(200)
    ).body as RowsPage;
    expect(second.rows.map((r) => r.rowId)).toEqual([3, 4]);
    expect(second.nextAfter).toBeNull();
    // 31/02/2026 is not a date: stored as NULL (the raw table keeps the original text).
    expect(second.rows[0]?.values.slice(1, 3)).toEqual([null, '99.75']);
    expect(second.rows[0]?.values[6]).toBe('Dòng 1\nDòng 2');
  });

  it('keeps the original text in the raw table', async () => {
    const meta = await admin.query<{ raw_table: string; data_schema: string }>(
      `SELECT v.raw_table, o.data_schema FROM app.dataset_versions v
         JOIN app.organizations o ON o.id = v.organization_id WHERE v.dataset_id = $1`,
      [datasetId],
    );
    const { raw_table: raw, data_schema: schema } = meta.rows[0]!;
    const row = await admin.query(
      `SELECT c_2, c_3 FROM ${admin.escapeIdentifier(schema)}.${admin.escapeIdentifier(raw)} WHERE _row_id = 3`,
    );
    expect(row.rows[0]).toEqual({ c_2: '31/02/2026', c_3: '99,75' });
  });

  it('imports XLSX with native numbers and dates as a new active version', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Đơn hàng');
    sheet.addRow(['Mã', 'Ngày', 'Tổng tiền', 'Ghi chú']);
    sheet.addRow(['A1', new Date(Date.UTC(2026, 9, 15)), 1234567.5, 'ok']);
    sheet.addRow([
      'A2',
      new Date(Date.UTC(2026, 10, 1)),
      250000,
      { richText: [{ text: 'x' }, { text: 'y' }] },
    ]);
    sheet.getColumn(2).numFmt = 'dd/mm/yyyy';
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const res = await upload('don-hang.xlsx', buffer).expect(202);
    const job = await waitForImport(res.body.id);
    expect({ status: job.status, error: job.error }).toEqual({ status: 'SUCCEEDED', error: null });

    const dataset = await detail();
    expect(dataset.activeVersion?.versionNo).toBe(2);
    expect(dataset.versions.map((v) => v.versionNo)).toEqual([2, 1]);
    expect(Object.fromEntries(dataset.columns.map((c) => [c.name, c.dataType]))).toEqual({
      ma: 'TEXT',
      ngay: 'DATE',
      tong_tien: 'DECIMAL',
      ghi_chu: 'TEXT',
    });
    const rows = (
      await client(app).get(`/api/v1/datasets/${datasetId}/rows`, owner, orgA).expect(200)
    ).body as RowsPage;
    expect(rows.rows[1]?.values).toEqual(['A2', '2026-11-01', '250000', 'xy']);
  });

  it('reads the first sheet in workbook order, or the sheet named in options', async () => {
    const workbook = new ExcelJS.Workbook();
    const summary = workbook.addWorksheet('Tổng hợp');
    summary.addRow(['Tháng']);
    summary.addRow(['11/2026']);
    const detailSheet = workbook.addWorksheet('Chi tiết & ghi chú');
    detailSheet.addRow(['Mã', 'Số tiền']);
    detailSheet.addRow(['X1', 10]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const first = await waitForImport((await upload('two.xlsx', buffer).expect(202)).body.id);
    expect(first.status).toBe('SUCCEEDED');
    expect((await detail()).columns.map((c) => c.name)).toEqual(['thang']);

    const named = await waitForImport(
      (await upload('two.xlsx', buffer, { sheetName: 'Chi tiết & ghi chú' }).expect(202)).body.id,
    );
    expect(named.status).toBe('SUCCEEDED');
    expect((await detail()).columns.map((c) => c.name)).toEqual(['ma', 'so_tien']);

    const missing = await waitForImport(
      (await upload('two.xlsx', buffer, { sheetName: 'Không có' }).expect(202)).body.id,
    );
    expect(missing).toMatchObject({ status: 'FAILED', error: { code: 'SHEET_NOT_FOUND' } });
  });

  it('re-imports a stored file with column type overrides', async () => {
    const imports = (
      await client(app).get(`/api/v1/datasets/${datasetId}/imports`, owner, orgA).expect(200)
    ).body as ImportJob[];
    const csvImport = imports.find((i) => i.dataSource.fileFormat === 'csv')!;
    const res = await client(app)
      .post(`/api/v1/datasets/${datasetId}/reimports`, owner, orgA)
      .send({
        dataSourceId: csvImport.dataSource.id,
        options: { locale: 'vi', columnTypes: { so_luong: 'TEXT' } },
      })
      .expect(202);
    expect((await waitForImport(res.body.id)).status).toBe('SUCCEEDED');

    const dataset = await detail();
    const column = dataset.columns.find((c) => c.name === 'so_luong');
    expect(column).toMatchObject({ dataType: 'TEXT', inferredType: 'INTEGER' });
  });

  it('is idempotent: running a finished job again does nothing', async () => {
    const before = await detail();
    const imports = (
      await client(app).get(`/api/v1/datasets/${datasetId}/imports`, owner, orgA).expect(200)
    ).body as ImportJob[];
    const runner = worker.get(ImportRunnerService);
    await expect(runner.run(orgA, imports[0]!.id, true)).resolves.toBe('skipped');
    expect((await detail()).versions).toHaveLength(before.versions.length);
  });

  describe('rejections', () => {
    it('rejects files whose content does not match the extension', async () => {
      const res = await upload('evil.csv', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])).expect(400);
      expect(res.body.detail).toMatch(/binary/);
      await upload('old.xls', 'a,b').expect(400);
      await upload('fake.xlsx', 'a,b\n1,2').expect(400);
      await client(app).post(`/api/v1/datasets/${datasetId}/imports`, owner, orgA).expect(400);
    });

    it('rejects files above the size limit', async () => {
      await upload('big.csv', `a\n${'1\n'.repeat(MAX_FILE_BYTES)}`).expect(413);
    });

    it('fails the job (without retrying) when the data breaks a limit', async () => {
      const csv = `n\n${Array.from({ length: MAX_ROWS + 5 }, (_, i) => i).join('\n')}\n`;
      const res = await upload('many.csv', csv).expect(202);
      const job = await waitForImport(res.body.id);
      expect(job).toMatchObject({ status: 'FAILED', error: { code: 'TOO_MANY_ROWS' } });
      // The failed import does not change the active version.
      expect((await detail()).activeVersion?.versionNo).toBe(5);
    });

    it('rejects unknown columns in type overrides', async () => {
      const res = await upload('x.csv', 'a;b\n1;2\n', { columnTypes: { nope: 'TEXT' } }).expect(
        202,
      );
      const job = await waitForImport(res.body.id);
      expect(job).toMatchObject({ status: 'FAILED', error: { code: 'UNKNOWN_COLUMN' } });
    });

    it('rejects invalid options', async () => {
      await upload('x.csv', 'a\n1\n', { delimiter: '#' }).expect(400);
    });
  });

  describe('tenant isolation', () => {
    it('hides datasets of other organizations', async () => {
      await client(app)
        .get(`/api/v1/datasets/${datasetId}`, other, other.organizationId)
        .expect(404);
      await client(app)
        .get(`/api/v1/datasets/${datasetId}/rows`, other, other.organizationId)
        .expect(404);
      const list = await client(app)
        .get('/api/v1/datasets', other, other.organizationId)
        .expect(200);
      expect(list.body).toEqual([]);
      await client(app)
        .post(`/api/v1/datasets/${datasetId}/imports`, other, other.organizationId)
        .attach('file', Buffer.from('a\n1\n'), 'x.csv')
        .expect(404);
    });
  });

  it('archives instead of deleting, and blocks new imports', async () => {
    await client(app).post(`/api/v1/datasets/${datasetId}/archive`, owner, orgA).expect(204);
    const list = await client(app).get('/api/v1/datasets', owner, orgA).expect(200);
    expect(list.body.find((d: { id: string }) => d.id === datasetId)).toBeUndefined();
    await upload('late.csv', 'a\n1\n').expect(409);
    // Versions are still there.
    expect((await detail()).versions.length).toBeGreaterThan(0);
  });
});
