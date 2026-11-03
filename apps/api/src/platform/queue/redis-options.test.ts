import { describe, expect, it } from 'vitest';
import { redisOptionsFromUrl } from './redis-options';

describe('redisOptionsFromUrl', () => {
  it('parses host, port, credentials and db', () => {
    expect(redisOptionsFromUrl('redis://user:p%40ss@cache.local:6380/2')).toMatchObject({
      host: 'cache.local',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 2,
      tls: undefined,
      maxRetriesPerRequest: null,
    });
  });

  it('defaults port/db and enables TLS for rediss', () => {
    expect(redisOptionsFromUrl('rediss://cache.local')).toMatchObject({
      port: 6379,
      db: 0,
      tls: {},
    });
  });
});
