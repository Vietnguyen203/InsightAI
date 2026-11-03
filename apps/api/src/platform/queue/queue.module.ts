import { BullModule } from '@nestjs/bullmq';
import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/config.module';
import { DEFAULT_JOB_OPTIONS, QueueName } from './queues';
import { redisOptionsFromUrl } from './redis-options';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

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
    BullModule.registerQueue({ name: QueueName.SYSTEM }),
  ],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Redis({ ...redisOptionsFromUrl(config.REDIS_URL), lazyConnect: true }),
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
