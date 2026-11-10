import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/config.module';
import { REDIS_CLIENT } from '../queue/queue.module';

const MINUTE_TTL_SECONDS = 2 * 60 * 60;
const DAY_TTL_SECONDS = 8 * 24 * 60 * 60;

/** Redis keys of the operations counters, namespaced like the queues (tests never see dev data). */
export function opsKeys(prefix: string) {
  const base = `insightai:ops:${prefix}`;
  return {
    serverErrors: (minute: number) => `${base}:5xx:${minute}`,
    llmDay: (day: string) => `${base}:llm:${day}`,
    snapshot: `${base}:snapshot`,
    alerts: `${base}:alerts`,
    lock: `${base}:lock`,
  };
}

export const epochMinute = (now: number) => Math.floor(now / 60_000);
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * Process-wide counters for the operations monitor (D-58): 5xx responses per minute and LLM tokens
 * per UTC day and model. Only totals, never organization or user data, so the monitor needs no
 * access to tenant metadata. Recording never fails the request that triggered it.
 */
@Injectable()
export class OpsMetricsService {
  private readonly logger = new Logger(OpsMetricsService.name);
  private readonly keys: ReturnType<typeof opsKeys>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.keys = opsKeys(config.QUEUE_PREFIX);
  }

  recordServerError(now = Date.now()): void {
    const key = this.keys.serverErrors(epochMinute(now));
    void this.redis
      .multi()
      .incr(key)
      .expire(key, MINUTE_TTL_SECONDS)
      .exec()
      .catch((error: Error) => this.logger.warn(`5xx counter not recorded: ${error.message}`));
  }

  async recordLlmUsage(
    model: string,
    usage: { promptTokens: number; completionTokens: number },
    now = Date.now(),
  ): Promise<void> {
    const key = this.keys.llmDay(utcDay(now));
    try {
      await this.redis
        .multi()
        .hincrby(key, `${model}|prompt`, usage.promptTokens)
        .hincrby(key, `${model}|completion`, usage.completionTokens)
        .hincrby(key, `${model}|calls`, 1)
        .expire(key, DAY_TTL_SECONDS)
        .exec();
    } catch (error) {
      this.logger.warn(`LLM usage counter not recorded: ${(error as Error).message}`);
    }
  }
}
