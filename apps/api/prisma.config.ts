import { existsSync } from 'node:fs';
import { defineConfig, env } from 'prisma/config';

// Prisma CLI does not load .env files; local development keeps one at the repo root.
if (process.env.NODE_ENV !== 'production' && existsSync('../../.env')) {
  process.loadEnvFile('../../.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Migrations run as the schema owner; the application itself connects with a less privileged role.
  datasource: { url: env('DATABASE_MIGRATE_URL') },
});
