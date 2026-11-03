import pg from 'pg';
import { loadAppConfig } from '../../src/platform/config/config.module';

/**
 * Superuser connection for integration-test setup/teardown only (creating fixture tables,
 * schemas and roles). Application code under test never uses it.
 */
export async function connectAdmin(): Promise<pg.Client> {
  loadAppConfig(); // populates process.env from the repo-root .env when present
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL is required for integration tests');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

export function roleFromUrl(variable: string): string {
  const url = process.env[variable];
  if (!url) throw new Error(`${variable} is required for integration tests`);
  return decodeURIComponent(new URL(url).username);
}
