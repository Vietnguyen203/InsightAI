import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config.module';
import { randomBase36 } from '../crypto/ids';
import { assertTenantSchema, tenantReaderRole, tenantWriterRole } from './tenant-schema';

const loginRole = (url: string): string => decodeURIComponent(new URL(url).username);

export function generateTenantSchemaName(): string {
  return assertTenantSchema(`t_${randomBase36(10)}`);
}

/**
 * Creates a tenant's data-plane schema and its reader/writer roles (decisions D-04, D-06).
 * Runs as a dedicated role with CREATEROLE and CREATE on the database only: it cannot read
 * the metadata schema and owns no tenant tables.
 *
 * Idempotent and serialized per schema with an advisory lock, so a failed or concurrent
 * provisioning can simply be retried.
 */
@Injectable()
export class TenantProvisioningService implements OnModuleDestroy {
  private readonly pool: pg.Pool;
  private readonly analyticsRole: string;
  private readonly ingestRole: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new pg.Pool({
      connectionString: config.DATABASE_PROVISIONER_URL,
      max: 2,
      application_name: 'insightai-provisioner',
    });
    this.analyticsRole = loginRole(config.DATABASE_ANALYTICS_URL);
    this.ingestRole = loginRole(config.DATABASE_INGEST_URL);
  }

  async ensureTenant(schema: string): Promise<void> {
    assertTenantSchema(schema);
    const reader = tenantReaderRole(schema);
    const writer = tenantWriterRole(schema);

    const client = await this.pool.connect();
    const id = (value: string) => client.escapeIdentifier(value);
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema]);

      for (const role of [reader, writer]) {
        const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        if (exists.rowCount === 0) {
          await client.query(`CREATE ROLE ${id(role)} NOLOGIN NOINHERIT`);
        }
      }
      // Login roles may only reach tenant data through an explicit SET ROLE (they are NOINHERIT).
      await client.query(`GRANT ${id(reader)} TO ${id(this.analyticsRole)}`);
      await client.query(`GRANT ${id(writer)} TO ${id(this.ingestRole)}`);

      await client.query(`CREATE SCHEMA IF NOT EXISTS ${id(schema)}`);
      await client.query(`REVOKE ALL ON SCHEMA ${id(schema)} FROM PUBLIC`);
      await client.query(`GRANT USAGE ON SCHEMA ${id(schema)} TO ${id(reader)}`);
      await client.query(`GRANT USAGE, CREATE ON SCHEMA ${id(schema)} TO ${id(writer)}`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
