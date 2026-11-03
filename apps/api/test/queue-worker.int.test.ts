import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type Queue, QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAppConfig } from '../src/platform/config/config.module';
import { QueueName, SystemJob } from '../src/platform/queue/queues';
import { redisOptionsFromUrl } from '../src/platform/queue/redis-options';
import { WorkerModule } from '../src/worker.module';
import type { PingResult } from '../src/worker/system.processor';

describe('queue → worker (integration)', () => {
  let worker: INestApplicationContext;
  let queueEvents: QueueEvents;

  beforeAll(async () => {
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    queueEvents = new QueueEvents(QueueName.SYSTEM, {
      connection: redisOptionsFromUrl(loadAppConfig().REDIS_URL),
    });
    await queueEvents.waitUntilReady();
  });

  afterAll(async () => {
    await queueEvents?.close();
    await worker?.close();
  });

  it('processes a ping job and is idempotent on jobId', async () => {
    const queue = worker.get<Queue>(getQueueToken(QueueName.SYSTEM));
    const jobId = `ping-${Date.now()}`;

    const job = await queue.add(SystemJob.PING, {}, { jobId });
    const duplicate = await queue.add(SystemJob.PING, {}, { jobId });
    expect(duplicate.id).toBe(job.id);

    const result = (await job.waitUntilFinished(queueEvents, 10_000)) as PingResult;
    expect(result.pong).toBe(true);
  });
});
