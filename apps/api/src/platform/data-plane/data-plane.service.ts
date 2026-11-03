import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config.module';
import { assertTenantSchema, tenantReaderRole, tenantWriterRole } from './tenant-schema';

export interface TenantSessionOptions {
  /** Hard limit enforced by PostgreSQL for every statement in the session. */
  statementTimeoutMs: number;
}

const DEFAULT_READ_TIMEOUT_MS = 15_000;
const DEFAULT_WRITE_TIMEOUT_MS = 300_000;

/**
 * Access to tenant data tables (schemas `t_*`). This is the only place that opens
 * data-plane connections. Isolation does not rely on SQL validation alone: each session
 * switches to the tenant's own role, which has no privileges on any other tenant schema
 * or on the metadata schema (decisions D-04, D-06).
 */
@Injectable()
export class DataPlaneService implements OnModuleDestroy {
  private readonly analyticsPool: pg.Pool;
  private readonly ingestPool: pg.Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.analyticsPool = new pg.Pool({
      connectionString: config.DATABASE_ANALYTICS_URL,
      max: 10,
      application_name: 'insightai-analytics',
    });
    this.ingestPool = new pg.Pool({
      connectionString: config.DATABASE_INGEST_URL,
      max: 5,
      application_name: 'insightai-ingest',
    });
  }

  /** Read-only transaction as the tenant reader role. */
  withTenantRead<T>(
    schema: string,
    work: (client: pg.PoolClient) => Promise<T>,
    options: TenantSessionOptions = { statementTimeoutMs: DEFAULT_READ_TIMEOUT_MS },
  ): Promise<T> {
    return this.run(this.analyticsPool, schema, tenantReaderRole(schema), true, options, work);
  }

  /** Read-write transaction as the tenant writer role (import / cleaning workers). */
  withTenantWrite<T>(
    schema: string,
    work: (client: pg.PoolClient) => Promise<T>,
    options: TenantSessionOptions = { statementTimeoutMs: DEFAULT_WRITE_TIMEOUT_MS },
  ): Promise<T> {
    return this.run(this.ingestPool, schema, tenantWriterRole(schema), false, options, work);
  }

  private async run<T>(
    pool: pg.Pool,
    schema: string,
    role: string,
    readOnly: boolean,
    options: TenantSessionOptions,
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    assertTenantSchema(schema);
    const timeout = Math.trunc(options.statementTimeoutMs);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new RangeError('statementTimeoutMs must be a positive number');
    }

    const client = await pool.connect();
    try {
      await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      // All SET LOCAL values revert at COMMIT/ROLLBACK, so pooled connections stay clean.
      await client.query(`SET LOCAL ROLE ${client.escapeIdentifier(role)}`);
      await client.query(`SET LOCAL search_path TO ${client.escapeIdentifier(schema)}`);
      await client.query(`SET LOCAL statement_timeout = ${timeout}`);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.analyticsPool.end(), this.ingestPool.end()]);
  }
}
