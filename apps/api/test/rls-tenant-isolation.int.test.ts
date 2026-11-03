import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAppConfig } from '../src/platform/config/config.module';
import { PrismaService } from '../src/platform/prisma/prisma.service';
import { connectAdmin, roleFromUrl } from './support/admin-db';

/**
 * Phase 1 spike for decision D-06: PostgreSQL RLS on the metadata plane, driven by Prisma
 * through `PrismaService.runInTenant`. Uses a throwaway fixture table owned by this test.
 */
describe('metadata-plane RLS via Prisma (integration)', () => {
  const orgA = randomUUID();
  const orgB = randomUUID();
  let admin: pg.Client;
  let prisma: PrismaService;

  beforeAll(async () => {
    admin = await connectAdmin();
    const appRole = admin.escapeIdentifier(roleFromUrl('DATABASE_URL'));
    await admin.query(`DROP TABLE IF EXISTS app.rls_spike`);
    await admin.query(`
      CREATE TABLE app.rls_spike (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        label text NOT NULL
      )`);
    await admin.query(`ALTER TABLE app.rls_spike ENABLE ROW LEVEL SECURITY`);
    await admin.query(`ALTER TABLE app.rls_spike FORCE ROW LEVEL SECURITY`);
    await admin.query(`
      -- NULLIF: once set_config(..., true) has run on a pooled connection, the setting reverts
      -- to '' (not NULL) after the transaction, and ''::uuid would raise instead of matching nothing.
      CREATE POLICY tenant_isolation ON app.rls_spike
        USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
        WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON app.rls_spike TO ${appRole}`);
    await admin.query(
      `INSERT INTO app.rls_spike (organization_id, label) VALUES ($1, 'a1'), ($1, 'a2'), ($2, 'b1')`,
      [orgA, orgB],
    );

    prisma = new PrismaService(loadAppConfig());
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await admin?.query(`DROP TABLE IF EXISTS app.rls_spike`);
    await admin?.end();
  });

  const labels = (rows: { label: string }[]) => rows.map((r) => r.label).sort();

  it('only returns rows of the current tenant', async () => {
    const rowsA = await prisma.runInTenant(
      orgA,
      (tx) => tx.$queryRaw<{ label: string }[]>`SELECT label FROM app.rls_spike`,
    );
    const rowsB = await prisma.runInTenant(
      orgB,
      (tx) => tx.$queryRaw<{ label: string }[]>`SELECT label FROM app.rls_spike`,
    );
    expect(labels(rowsA)).toEqual(['a1', 'a2']);
    expect(labels(rowsB)).toEqual(['b1']);
  });

  it('returns nothing when no tenant context is set (fail closed)', async () => {
    const rows = await prisma.$queryRaw<{ label: string }[]>`SELECT label FROM app.rls_spike`;
    expect(rows).toEqual([]);
  });

  it('does not leak the tenant setting to the next use of a pooled connection', async () => {
    await prisma.runInTenant(orgA, (tx) => tx.$queryRaw`SELECT 1`);
    const rows = await prisma.$queryRaw<{ label: string }[]>`SELECT label FROM app.rls_spike`;
    expect(rows).toEqual([]);
  });

  it('rejects writes into another tenant', async () => {
    await expect(
      prisma.runInTenant(
        orgA,
        (tx) =>
          tx.$executeRaw`INSERT INTO app.rls_spike (organization_id, label) VALUES (${orgB}::uuid, 'evil')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot update rows of another tenant', async () => {
    const updated = await prisma.runInTenant(
      orgA,
      (tx) => tx.$executeRaw`UPDATE app.rls_spike SET label = 'hijacked' WHERE label = 'b1'`,
    );
    expect(updated).toBe(0);
  });

  it('rejects a non-UUID tenant id before reaching SQL', async () => {
    await expect(prisma.runInTenant("x' OR '1'='1", () => Promise.resolve(1))).rejects.toThrow(
      /UUID/,
    );
  });
});
