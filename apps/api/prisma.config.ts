import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma CLI does not load .env files; local development keeps one at the repo root.
if (process.env.NODE_ENV !== 'production' && existsSync('../../.env')) {
  process.loadEnvFile('../../.env');
}

// Migrations run as the schema owner; the application itself connects with a less privileged role.
// The URL is optional here so that `prisma generate` (which needs no database) works in CI jobs and
// builds without database credentials; `migrate` commands fail clearly when it is missing.
const migrateUrl = process.env.DATABASE_MIGRATE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(migrateUrl ? { datasource: { url: migrateUrl } } : {}),
});
