import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { REDIS_CLIENT } from '../../platform/queue/queue.module';
import { StorageService } from '../../platform/storage/storage.service';

const CHECK_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS).unref(),
    ),
  ]);
}

/** Readiness checks for infrastructure the API cannot serve requests without. */
@Injectable()
export class DependencyHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  database(): Promise<HealthIndicatorResult> {
    return this.check('database', () => this.prisma.ping());
  }

  redisCheck(): Promise<HealthIndicatorResult> {
    return this.check('redis', async () => {
      if (this.redis.status === 'wait') await this.redis.connect();
      await this.redis.ping();
    });
  }

  objectStorage(): Promise<HealthIndicatorResult> {
    return this.check('storage', () => this.storage.checkBucket());
  }

  private async check(key: string, probe: () => Promise<void>): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    try {
      await withTimeout(probe());
      return indicator.up();
    } catch {
      // Error details stay out of the public response (they can contain hostnames).
      return indicator.down();
    }
  }
}
