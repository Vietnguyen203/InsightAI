import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ImportJob } from '@insightai/contracts';
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

const ROWS = Number(process.env.PERF_ROWS ?? 200_000);

/**
 * Opt-in throughput check (PERF_TEST=true pnpm test:int): imports a large Vietnamese CSV end to
 * end and reports timing. Not part of CI; used to validate the streaming design and timeouts.
 */
describe.runIf(process.env.PERF_TEST === 'true')('import performance (opt-in)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let admin: pg.Client;
  let owner: TestUser;
  let dir: string;

  beforeAll(async () => {
    admin = await connectAdmin();
    app = await createTestApp();
    worker = await NestFactory.createApplicationContext(WorkerModule, {
      logger: process.env.TEST_APP_LOGS === 'true' ? ['error'] : false,
    });
    owner = await registerUser(app, { label: 'perf', organizationName: 'Perf Org' });
    dir = await mkdtemp(join(tmpdir(), 'insightai-perf-'));
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true });
    if (admin) {
      await cleanupTestData(admin);
      await admin.end();
    }
  });

  it(`imports ${ROWS.toLocaleString('en-US')} rows`, { timeout: 15 * 60_000 }, async () => {
    const file = join(dir, 'orders.csv');
    const out = createWriteStream(file);
    const bom = String.fromCharCode(0xfeff);
    out.write(`${bom}Mã đơn;Ngày đặt;Khách hàng;Khu vực;Sản phẩm;Số lượng;Đơn giá;Thành tiền
`);
    const regions = ['Miền Bắc', 'Miền Trung', 'Miền Nam'];
    for (let i = 1; i <= ROWS; i++) {
      const qty = (i % 9) + 1;
      const price = 10_000 + (i % 97) * 1_500;
      const line = `DH${String(i).padStart(7, '0')};${String((i % 28) + 1).padStart(2, '0')}/${String((i % 12) + 1).padStart(2, '0')}/2026;KH${i % 5000};${regions[i % 3]};SP${i % 300};${qty};${price.toLocaleString('vi-VN')};${(qty * price).toLocaleString('vi-VN')}\n`;
      if (!out.write(line))
        await new Promise<void>((resolve) => out.once('drain', () => resolve()));
    }
    await new Promise<void>((resolve) => out.end(() => resolve()));
    const { size } = await stat(file);

    const dataset = await client(app)
      .post('/api/v1/datasets', owner, owner.organizationId)
      .send({ name: 'Perf' })
      .expect(201);

    const t0 = Date.now();
    const res = await client(app)
      .post(`/api/v1/datasets/${dataset.body.id}/imports`, owner, owner.organizationId)
      .attach('file', file)
      .expect(202);
    const uploadMs = Date.now() - t0;

    let job: ImportJob | undefined;
    for (;;) {
      job = (await client(app).get(`/api/v1/imports/${res.body.id}`, owner, owner.organizationId))
        .body;
      if (job?.status === 'SUCCEEDED' || job?.status === 'FAILED') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const totalMs = Date.now() - t0;
    const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(
      `[perf] rows=${ROWS} size=${(size / 1024 / 1024).toFixed(1)}MB upload=${uploadMs}ms ` +
        `total=${totalMs}ms rate=${Math.round(ROWS / (totalMs / 1000))} rows/s rss=${memoryMb}MB`,
    );
    // Profiling starts right after the import; measure until the profile is ready.
    const p0 = Date.now();
    let profileStatus = 'PENDING';
    while (profileStatus === 'PENDING' || profileStatus === 'RUNNING') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const res2 = await client(app)
        .get(`/api/v1/datasets/${dataset.body.id}/profile`, owner, owner.organizationId)
        .expect(200);
      profileStatus = (res2.body as { status: string }).status;
    }
    console.log(`[perf] profiling=${Date.now() - p0}ms status=${profileStatus}`);

    // The automatic quality check (system rules: type conversion per column + duplicate rows).
    const q0 = Date.now();
    let check: { status: string; rulesTotal: number; score: number | null } | undefined;
    for (;;) {
      const res3 = await client(app)
        .get(`/api/v1/datasets/${dataset.body.id}/quality-checks`, owner, owner.organizationId)
        .expect(200);
      check = (res3.body as { status: string; rulesTotal: number; score: number | null }[])[0];
      if (check && (check.status === 'SUCCEEDED' || check.status === 'FAILED')) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.log(
      `[perf] quality=${Date.now() - q0}ms (after profiling) rules=${check.rulesTotal} score=${check.score}`,
    );
    expect(check.status).toBe('SUCCEEDED');
    expect(profileStatus).toBe('SUCCEEDED');

    // Cleaning: suggestions, preview (whole-table impact) and apply of a typical recipe.
    const operations = [
      { type: 'trim_whitespace', columns: ['khach_hang', 'khu_vuc'] },
      { type: 'change_case', columns: ['khu_vuc'], mode: 'upper' },
      { type: 'fill_null', column: 'so_luong', strategy: 'median' },
      { type: 'deduplicate', keyColumns: ['ma_don'] },
      { type: 'drop_rows', condition: 'so_luong > 8' },
    ];
    const s0 = Date.now();
    await client(app)
      .get(`/api/v1/datasets/${dataset.body.id}/cleaning/suggestions`, owner, owner.organizationId)
      .expect(200);
    const s1 = Date.now();
    await client(app)
      .post(`/api/v1/datasets/${dataset.body.id}/cleaning/preview`, owner, owner.organizationId)
      .send({ operations })
      .expect(200);
    const s2 = Date.now();
    const applied = await client(app)
      .post(`/api/v1/datasets/${dataset.body.id}/cleaning-jobs`, owner, owner.organizationId)
      .send({ operations })
      .expect(202);
    let cleaning: { status: string } | undefined;
    for (;;) {
      cleaning = (
        await client(app).get(
          `/api/v1/cleaning-jobs/${applied.body.id}`,
          owner,
          owner.organizationId,
        )
      ).body as { status: string };
      if (cleaning.status === 'SUCCEEDED' || cleaning.status === 'FAILED') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.log(
      `[perf] suggestions=${s1 - s0}ms preview=${s2 - s1}ms apply=${Date.now() - s2}ms status=${cleaning.status}`,
    );
    expect(cleaning.status).toBe('SUCCEEDED');

    expect({ status: job?.status, error: job?.error, rowsRead: job?.rowsRead }).toEqual({
      status: 'SUCCEEDED',
      error: null,
      rowsRead: ROWS,
    });
  });
});
