import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const postgresUrl = z
  .url()
  .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
    message: 'must be a postgres:// URL',
  });

/**
 * Single source of truth for environment configuration. Parsed once at boot;
 * the process refuses to start on invalid configuration.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    /** Express `trust proxy` hop count; set when running behind a reverse proxy so client IPs are correct. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    RATE_LIMIT_ENABLED: booleanString.default(true),

    /** HS256 signing key for access tokens. */
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

    /** Metadata plane, role without BYPASSRLS. */
    DATABASE_URL: postgresUrl,
    /** Tenant provisioning only: CREATEROLE + CREATE on the database, no access to metadata or data. */
    DATABASE_PROVISIONER_URL: postgresUrl,
    /** Data plane read pool (AI/KPI queries); only allowed to SET ROLE to tenant reader roles. */
    DATABASE_ANALYTICS_URL: postgresUrl,
    /** Data plane write pool (import/cleaning workers); only allowed to SET ROLE to tenant writer roles. */
    DATABASE_INGEST_URL: postgresUrl,

    REDIS_URL: z.url(),
    /**
     * BullMQ key prefix. Integration tests use their own so that a locally running dev worker never
     * picks up test jobs (and vice versa).
     */
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,30}$/)
      .default('bull'),

    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(3),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: booleanString.default(false),

    /** Temporary directory for uploads and import working files (deleted after use). */
    WORK_DIR: z.string().min(1).optional(),
    /** Overrides of the import limits in @insightai/contracts IMPORT_LIMITS (tests use small values). */
    IMPORT_MAX_FILE_BYTES: z.coerce.number().int().positive().optional(),
    IMPORT_MAX_ROWS: z.coerce.number().int().positive().optional(),
    IMPORT_MAX_COLUMNS: z.coerce.number().int().positive().optional(),

    /** LLM provider (D-08). Without a key the AI features report AI_UNAVAILABLE. */
    OPENAI_API_KEY: z.string().min(1).optional(),
    /** Chat model id; required together with the key (no built-in default model). */
    OPENAI_MODEL: z.string().min(1).optional(),
    OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
    /** Questions per organization and day. */
    AI_DAILY_QUESTION_LIMIT: z.coerce.number().int().positive().default(200),
    /** Total time for one answer (all model calls and queries); then AI_TIMEOUT. */
    AI_ANSWER_TIMEOUT_MS: z.coerce.number().int().min(1).max(600_000).default(90_000),
    /** SSE comment sent while an answer is in progress, so proxies keep the stream open. */
    AI_SSE_HEARTBEAT_MS: z.coerce.number().int().min(10).max(60_000).default(15_000),
  })
  .refine((env) => !env.OPENAI_API_KEY || env.OPENAI_MODEL, {
    message: 'OPENAI_MODEL is required when OPENAI_API_KEY is set',
    path: ['OPENAI_MODEL'],
  })
  // Redis holds sessions' rate limits, queues and cached query results: never unauthenticated
  // in production.
  .refine((env) => env.NODE_ENV !== 'production' || new URL(env.REDIS_URL).password !== '', {
    message: 'REDIS_URL must include a password in production',
    path: ['REDIS_URL'],
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Only report variable names and messages, never values (they may be secrets).
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
