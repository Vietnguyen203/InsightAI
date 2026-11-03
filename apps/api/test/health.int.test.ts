import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { problemDetailsSchema } from '@insightai/contracts';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { StorageService } from '../src/platform/storage/storage.service';

describe('HTTP foundation (integration)', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health/live returns ok without touching dependencies', async () => {
    const res = await request(server()).get('/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready reports database, redis and storage up', async () => {
    const res = await request(server()).get('/health/ready').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      info: {
        database: { status: 'up' },
        redis: { status: 'up' },
        storage: { status: 'up' },
      },
    });
  });

  it('returns RFC 7807 problem details for unknown routes', async () => {
    const res = await request(server())
      .get('/api/v1/does-not-exist')
      .set('x-request-id', 'test-request-0001')
      .expect(404);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.headers['x-request-id']).toBe('test-request-0001');
    const problem = problemDetailsSchema.parse(res.body);
    expect(problem).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      requestId: 'test-request-0001',
      instance: '/api/v1/does-not-exist',
    });
  });

  it('generates a request id when the client sends an invalid one', async () => {
    const res = await request(server())
      .get('/health/live')
      .set('x-request-id', 'bad id with spaces')
      .expect(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('serves the OpenAPI document outside production', async () => {
    const res = await request(server()).get('/docs-json').expect(200);
    expect(res.body.paths).toHaveProperty('/health/ready');
  });

  it('reports which dependency is down with a 503 health body', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StorageService)
      .useValue({ checkBucket: () => Promise.reject(new Error('storage offline')) })
      .compile();
    const degraded = moduleRef.createNestApplication({ logger: false });
    configureApp(degraded);
    await degraded.init();
    try {
      const res = await request(degraded.getHttpServer() as App)
        .get('/health/ready')
        .expect(503);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).toMatchObject({
        status: 'error',
        info: { database: { status: 'up' }, redis: { status: 'up' } },
        error: { storage: { status: 'down' } },
      });
    } finally {
      await degraded.close();
    }
  });

  it('sets security headers', async () => {
    const res = await request(server()).get('/health/live').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
