import { BullModule } from '@nestjs/bullmq';
import { Global, Inject, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/config.module';
import { DEFAULT_JOB_OPTIONS, QueueName } from './queues';
import { redisOptionsFromUrl } from './redis-options';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
const logger = new Logger('Redis');

/** General-purpose Redis client (health checks, cache, rate limiting). BullMQ manages its own connections. */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        connection: redisOptionsFromUrl(config.REDIS_URL),
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
    }),
    BullModule.registerQueue(
      { name: QueueName.SYSTEM },
      { name: QueueName.IMPORT },
      { name: QueueName.PROFILING },
      { name: QueueName.QUALITY },
    ),
  ],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const redis = new Redis({ ...redisOptionsFromUrl(config.REDIS_URL), lazyConnect: true });
        // Without a listener ioredis prints "Unhandled error event" on every reconnect attempt.
        redis.on('error', (error: Error) => logger.warn(`Redis unavailable: ${error.message}`));
        return redis;
      },
    },
  ],
  exports: [BullModule, REDIS_CLIENT],
})
export class QueueModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
