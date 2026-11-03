import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAppConfig } from '../src/platform/config/config.module';
import { DataPlaneService } from '../src/platform/data-plane/data-plane.service';
import { connectAdmin, roleFromUrl } from './support/admin-db';

/**
 * Phase 1 spike for decisions D-04/D-06: tenant data lives in its own schema and is reached
 * only through per-tenant roles via `SET LOCAL ROLE`. Provisioning here mimics what the
 * organization module will do in Phase 2.
 */
describe('data-plane tenant isolation (integration)', () => {
  const tenantA = 't_spikeaaaa1';
  const tenantB = 't_spikebbbb1';
  let admin: pg.Client;
  let dataPlane: DataPlaneService;

  async function provisionTenant(schema: string, label: string) {
    const id = (value: string) => admin.escapeIdentifier(value);
    const analytics = id(roleFromUrl('DATABASE_ANALYTICS_URL'));
    const ingest = id(roleFromUrl('DATABASE_INGEST_URL'));
    await dropTenant(schema);
    await admin.query(`CREATE ROLE ${id(`${schema}_reader`)} NOLOGIN`);
    await admin.query(`CREATE ROLE ${id(`${schema}_writer`)} NOLOGIN`);
    await admin.query(`CREATE SCHEMA ${id(schema)} AUTHORIZATION ${id(`${schema}_writer`)}`);
    await admin.query(`GRANT USAGE ON SCHEMA ${id(schema)} TO ${id(`${schema}_reader`)}`);
    await admin.query(`GRANT ${id(`${schema}_reader`)} TO ${analytics}`);
    await admin.query(`GRANT ${id(`${schema}_writer`)} TO ${ingest}`);
    await admin.query(
      `CREATE TABLE ${id(schema)}.ds_sample (_row_id bigint PRIMARY KEY, label text)`,
    );
    await admin.query(`ALTER TABLE ${id(schema)}.ds_sample OWNER TO ${id(`${schema}_writer`)}`);
    await admin.query(`GRANT SELECT ON ${id(schema)}.ds_sample TO ${id(`${schema}_reader`)}`);
    await admin.query(`INSERT INTO ${id(schema)}.ds_sample VALUES (1, $1)`, [label]);
  }

  async function dropTenant(schema: string) {
    const id = (value: string) => admin.escapeIdentifier(value);
    await admin.query(`DROP SCHEMA IF EXISTS ${id(schema)} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${id(`${schema}_reader`)}`);
    await admin.query(`DROP ROLE IF EXISTS ${id(`${schema}_writer`)}`);
  }

  beforeAll(async () => {
    admin = await connectAdmin();
    await provisionTenant(tenantA, 'from A');
    await provisionTenant(tenantB, 'from B');
    dataPlane = new DataPlaneService(loadAppConfig());
  });

  afterAll(async () => {
    await dataPlane?.onModuleDestroy();
    if (admin) {
      await dropTenant(tenantA);
      await dropTenant(tenantB);
      await admin.end();
    }
  });

  it('reads its own tenant table via search_path', async () => {
    const rows = await dataPlane.withTenantRead(tenantA, async (client) => {
      const result = await client.query<{ label: string }>('SELECT label FROM ds_sample');
      return result.rows;
    });
    expect(rows).toEqual([{ label: 'from A' }]);
  });

  it('cannot read another tenant schema even with a fully qualified name', async () => {
    await expect(
      dataPlane.withTenantRead(tenantA, (client) =>
        client.query(`SELECT * FROM ${tenantB}.ds_sample`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot read the metadata schema', async () => {
    await expect(
      dataPlane.withTenantRead(tenantA, (client) =>
        client.query('SELECT * FROM app._prisma_migrations'),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot write in a read session', async () => {
    await expect(
      dataPlane.withTenantRead(tenantA, (client) =>
        client.query(`INSERT INTO ds_sample VALUES (2, 'x')`),
      ),
    ).rejects.toThrow(/read-only transaction/i);
  });

  it('cannot escalate with RESET ROLE inside a read session', async () => {
    await expect(
      dataPlane.withTenantRead(tenantA, async (client) => {
        await client.query('RESET ROLE');
        return client.query(`SELECT * FROM ${tenantB}.ds_sample`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('enforces the statement timeout', async () => {
    await expect(
      dataPlane.withTenantRead(tenantA, (client) => client.query('SELECT pg_sleep(2)'), {
        statementTimeoutMs: 200,
      }),
    ).rejects.toThrow(/statement timeout/i);
  });

  it('writer session can create tables only in its own schema', async () => {
    await dataPlane.withTenantWrite(tenantA, (client) =>
      client.query('CREATE TABLE ds_created_by_writer (_row_id bigint PRIMARY KEY)'),
    );
    await expect(
      dataPlane.withTenantWrite(tenantA, (client) =>
        client.query(`CREATE TABLE ${tenantB}.ds_intruder (_row_id bigint)`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
