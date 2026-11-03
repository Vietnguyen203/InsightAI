import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/config.module';
import { redisOptionsFromUrl } from '../queue/redis-options';

const THROTTLER_REDIS = Symbol('THROTTLER_REDIS');

@Module({
  providers: [
    {
      provide: THROTTLER_REDIS,
      inject: [APP_CONFIG],
      // Fail fast instead of queueing requests forever if Redis is unavailable.
      useFactory: (config: AppConfig) =>
        new Redis({ ...redisOptionsFromUrl(config.REDIS_URL), maxRetriesPerRequest: 2 }),
    },
  ],
  exports: [THROTTLER_REDIS],
})
class ThrottlerRedisModule implements OnModuleDestroy {
  constructor(@Inject(THROTTLER_REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

/**
 * Global rate limiting backed by Redis, so limits hold across API instances.
 * Default: 300 requests/minute per client IP; credential endpoints set stricter limits
 * with @Throttle. Disabled only when RATE_LIMIT_ENABLED=false (integration tests).
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ThrottlerRedisModule],
      inject: [APP_CONFIG, THROTTLER_REDIS],
      useFactory: (config: AppConfig, redis: Redis) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
        storage: new ThrottlerStorageRedisService(redis),
        skipIf: () => !config.RATE_LIMIT_ENABLED,
      }),
    }),
  ],
})
export class RateLimitModule {}
