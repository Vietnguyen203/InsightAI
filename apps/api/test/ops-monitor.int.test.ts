import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AlertNotification } from '../src/platform/ops/alert-rules';
import {
  epochMinute,
  OpsMetricsService,
  opsKeys,
  utcDay,
} from '../src/platform/ops/ops-metrics.service';
import { REDIS_CLIENT } from '../src/platform/queue/queue.module';
import { OpsMonitorService } from '../src/worker/ops-monitor.service';
import { WorkerModule } from '../src/worker.module';
import { createTestApp } from './support/test-app';

const OPS_ENV = [
  'OPS_MONITOR_ENABLED',
  'OPS_STATUS_TOKEN',
  'OPS_ALERT_WEBHOOK_URL',
  'OPS_API_URL',
  'OPS_LLM_PRICE_INPUT_PER_MTOK',
  'OPS_LLM_PRICE_OUTPUT_PER_MTOK',
  'OPS_LLM_DAILY_BUDGET_USD',
] as const;

describe('operations monitor (integration)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let webhook: Server;
  let monitor: OpsMonitorService;
  let ops: OpsMetricsService;
  let redis: Redis;
  let keys: ReturnType<typeof opsKeys>;
  const received: { text: string; alert: AlertNotification }[] = [];
  const token = randomBytes(24).toString('hex');
  const server = () => app.getHttpServer() as App;

  const clearCounters = async () => {
    const minute = epochMinute(Date.now());
    const minuteKeys = Array.from({ length: 7 }, (_, i) => keys.serverErrors(minute - i + 1));
    await redis.del(...minuteKeys, keys.llmDay(utcDay(Date.now())));
  };

  beforeAll(async () => {
    webhook = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        received.push(JSON.parse(raw) as { text: string; alert: AlertNotification });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => webhook.listen(0, '127.0.0.1', resolve));

    process.env.OPS_MONITOR_ENABLED = 'false'; // the test drives the checks itself
    process.env.OPS_STATUS_TOKEN = token;
    process.env.OPS_ALERT_WEBHOOK_URL = `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/hook`;
    process.env.OPS_LLM_PRICE_INPUT_PER_MTOK = '1';
    process.env.OPS_LLM_PRICE_OUTPUT_PER_MTOK = '2';
    process.env.OPS_LLM_DAILY_BUDGET_USD = '0.5';

    app = await createTestApp();
    await app.listen(0, '127.0.0.1');
    process.env.OPS_API_URL = await app.getUrl();
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    monitor = worker.get(OpsMonitorService);
    ops = app.get(OpsMetricsService);
    redis = app.get<Redis>(REDIS_CLIENT);
    keys = opsKeys(process.env.QUEUE_PREFIX ?? 'bull');
    await clearCounters();
    await redis.del(keys.snapshot, keys.alerts);
  }, 120_000);

  afterAll(async () => {
    if (redis) {
      await clearCounters();
      await redis.del(keys.snapshot, keys.alerts);
    }
    await worker?.close();
    await app?.close();
    await new Promise((resolve) => webhook?.close(resolve));
    for (const name of OPS_ENV) delete process.env[name];
  });

  it('protects GET /health/ops with the operations token', async () => {
    await request(server()).get('/health/ops').expect(401);
    await request(server()).get('/health/ops').set('authorization', 'Bearer wrong').expect(401);
    const res = await request(server())
      .get('/health/ops')
      .set('authorization', `Bearer ${token}`)
      .expect(503);
    expect(res.body).toMatchObject({ status: 'unknown' });
  });

  it('measures the five indicators of a healthy system', async () => {
    const { snapshot, notifications } = await monitor.check();
    expect(snapshot.api).toEqual({ ok: true, status: 200, detail: null });
    expect(snapshot.serverErrors5m).toBe(0);
    expect(snapshot.queues.map((q) => q.name)).toEqual([
      'import',
      'profiling',
      'quality',
      'cleaning',
      'investigation',
    ]);
    expect(snapshot.disks).toHaveLength(1);
    expect(snapshot.disks[0]!.usedPercent).toBeGreaterThan(0);
    expect(snapshot.llm).toMatchObject({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
    const ours = ['api_not_ready', 'server_errors', 'llm_cost'];
    expect(notifications.filter((n) => ours.includes(n.key))).toEqual([]);
  });

  it('fires on 5xx and LLM cost, sends to the webhook, then resolves once', async () => {
    for (let i = 0; i < 10; i++) ops.recordServerError();
    await ops.recordLlmUsage('gpt-test', { promptTokens: 300_000, completionTokens: 50_000 });
    await ops.recordLlmUsage('gpt-test', { promptTokens: 300_000, completionTokens: 50_000 });
    // recordServerError is fire-and-forget: wait until the counter is visible.
    for (let i = 0; i < 50; i++) {
      const value = await redis.get(keys.serverErrors(epochMinute(Date.now())));
      if (Number(value) >= 10) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    received.length = 0;

    const firing = await monitor.check();
    expect(firing.snapshot.serverErrors5m).toBe(10);
    expect(firing.snapshot.llm).toMatchObject({
      promptTokens: 600_000,
      completionTokens: 100_000,
      calls: 2,
    });
    expect(firing.snapshot.llm.costUsd).toBeCloseTo(0.8);
    const sent = received.map((r) => `${r.alert.status} ${r.alert.key}`);
    expect(sent).toEqual(expect.arrayContaining(['FIRING server_errors', 'FIRING llm_cost']));
    expect(received.find((r) => r.alert.key === 'llm_cost')!.text).toContain('0.80 USD');

    const status = await request(server())
      .get('/health/ops')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.body.serverErrors5m).toBe(10);
    expect((status.body.alerts as { key: string }[]).map((a) => a.key)).toEqual(
      expect.arrayContaining(['server_errors', 'llm_cost']),
    );
    // Totals only: no organization, user or tenant identifiers.
    expect(JSON.stringify(status.body)).not.toMatch(/organization|userId|t_[0-9a-f]{8}/);

    received.length = 0;
    await monitor.check();
    expect(received.filter((r) => ['server_errors', 'llm_cost'].includes(r.alert.key))).toEqual([]);

    await clearCounters();
    await monitor.check();
    const resolved = received.map((r) => `${r.alert.status} ${r.alert.key}`);
    expect(resolved).toEqual(
      expect.arrayContaining(['RESOLVED server_errors', 'RESOLVED llm_cost']),
    );
  });
});
