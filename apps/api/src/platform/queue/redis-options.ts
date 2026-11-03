import type { RedisOptions } from 'ioredis';

/** Converts a redis:// or rediss:// URL into ioredis options (BullMQ does not accept URLs directly). */
export function redisOptionsFromUrl(url: string): RedisOptions {
  const parsed = new URL(url);
  const db = parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0;
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number.isInteger(db) ? db : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    // Required by BullMQ workers: blocking commands must not be retried by ioredis itself.
    maxRetriesPerRequest: null,
  };
}
