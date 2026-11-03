import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.schema';

const valid = {
  DATABASE_URL: 'postgresql://app:secret@localhost:5432/insightai',
  DATABASE_ANALYTICS_URL: 'postgresql://analytics:secret@localhost:5432/insightai',
  DATABASE_INGEST_URL: 'postgresql://ingest:secret@localhost:5432/insightai',
  REDIS_URL: 'redis://localhost:6379',
  S3_BUCKET: 'insightai-dev',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'super-secret-value',
};

describe('parseEnv', () => {
  it('applies defaults and transforms', () => {
    const env = parseEnv({
      ...valid,
      CORS_ORIGINS: 'http://a.test, http://b.test',
      S3_FORCE_PATH_STYLE: 'true',
    });
    expect(env.PORT).toBe(3100);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('rejects non-postgres database URLs', () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: 'mysql://localhost/x' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('never echoes secret values in the error message', () => {
    const { S3_BUCKET: _omitted, ...missingBucket } = valid;
    try {
      parseEnv(missingBucket);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('S3_BUCKET');
      expect((error as Error).message).not.toContain('super-secret-value');
      expect((error as Error).message).not.toContain('secret@localhost');
    }
  });
});
