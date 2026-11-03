import type { INestApplication } from '@nestjs/common';
import {
  ALL_PERMISSIONS,
  problemDetailsSchema,
  SYSTEM_ROLE_PERMISSIONS,
} from '@insightai/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAppConfig } from '../src/platform/config/config.module';
import { DataPlaneService } from '../src/platform/data-plane/data-plane.service';
import { PrismaService } from '../src/platform/prisma/prisma.service';
import { connectAdmin } from './support/admin-db';
import {
  cleanupTestData,
  client,
  createTestApp,
  registerUser,
  type TestUser,
} from './support/test-app';

describe('tenancy, RBAC and invitations (integration)', () => {
  let app: INestApplication;
  let admin: pg.Client;
  let owner: TestUser; // owner of org A
  let other: TestUser; // owner of org B
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    admin = await connectAdmin();
    app = await createTestApp();
    owner = await registerUser(app, { label: 'owner-a', organizationName: 'Org A' });
    other = await registerUser(app, { label: 'owner-b', organizationName: 'Org B' });
    orgA = owner.organizationId!;
    orgB = other.organizationId!;
  });

  afterAll(async () => {
    await app?.close();
    if (admin) {
      await cleanupTestData(admin);
      await admin.end();
    }
  });

  async function invite(role: string, by: TestUser = owner, org = orgA): Promise<string> {
    const res = await client(app).post('/api/v1/invitations', by, org).send({ role }).expect(201);
    return res.body.token as string;
  }

  describe('seed data', () => {
    it('matches the permission matrix in @insightai/contracts', async () => {
      const permissions = await admin.query<{ code: string }>('SELECT code FROM app.permissions');
      expect(permissions.rows.map((r) => r.code).sort()).toEqual([...ALL_PERMISSIONS].sort());

      const grants = await admin.query<{ key: string; codes: string[] }>(
        `SELECT r.key, array_agg(rp.permission_code ORDER BY rp.permission_code) AS codes
           FROM app.roles r JOIN app.role_permissions rp ON rp.role_id = r.id
          WHERE r.organization_id IS NULL GROUP BY r.key`,
      );
      const fromDb = Object.fromEntries(grants.rows.map((r) => [r.key, r.codes]));
      for (const [role, codes] of Object.entries(SYSTEM_ROLE_PERMISSIONS)) {
        expect(fromDb[role], role).toEqual([...codes].sort());
      }
    });
  });

  describe('tenant isolation', () => {
    it('requires the organization header on tenant routes', async () => {
      const res = await client(app).get('/api/v1/members', owner).expect(400);
      expect(problemDetailsSchema.parse(res.body).code).toBe('VALIDATION_FAILED');
    });

    it('rejects access to an organization the caller does not belong to', async () => {
      const res = await client(app).get('/api/v1/members', owner, orgB).expect(403);
      expect(problemDetailsSchema.parse(res.body).code).toBe('FORBIDDEN');
      // Same answer for an organization that does not exist.
      await client(app)
        .get('/api/v1/members', owner, '0190f5a0-0000-7000-8000-000000000000')
        .expect(403);
    });

    it('only lists members and audit entries of the current organization', async () => {
      const members = await client(app).get('/api/v1/members', owner, orgA).expect(200);
      expect(members.body.map((m: { user: { email: string } }) => m.user.email)).toEqual([
        owner.email,
      ]);

      const audit = await client(app).get('/api/v1/audit-logs', owner, orgA).expect(200);
      expect(audit.body.items.length).toBeGreaterThan(0);
      expect(
        audit.body.items.every((e: { resourceId: string | null }) => e.resourceId !== orgB),
      ).toBe(true);
    });

    it('RLS hides other users and organizations even from direct queries', async () => {
      const prisma = new PrismaService(loadAppConfig());
      try {
        const asOwner = await prisma.runInContext({ userId: owner.userId }, async (tx) => ({
          users: await tx.user.findMany({ select: { id: true } }),
          orgs: await tx.organization.findMany({ select: { id: true } }),
        }));
        expect(asOwner.users.map((u) => u.id)).toEqual([owner.userId]);
        expect(asOwner.orgs.map((o) => o.id)).toEqual([orgA]);

        const noContext = await prisma.runInContext({}, (tx) => tx.user.count());
        expect(noContext).toBe(0);
      } finally {
        await prisma.$disconnect();
      }
    });

    it("each organization's data plane is reachable only through its own roles", async () => {
      const rows = await admin.query<{ id: string; data_schema: string }>(
        'SELECT id, data_schema FROM app.organizations WHERE id = ANY($1::uuid[])',
        [[orgA, orgB]],
      );
      const schemaOf = Object.fromEntries(rows.rows.map((r) => [r.id, r.data_schema]));
      const dataPlane = new DataPlaneService(loadAppConfig());
      try {
        await dataPlane.withTenantWrite(schemaOf[orgB]!, async (c) => {
          await c.query('CREATE TABLE ds_secret (_row_id bigint PRIMARY KEY)');
        });
        await expect(
          dataPlane.withTenantRead(schemaOf[orgA]!, (c) =>
            c.query(`SELECT * FROM ${schemaOf[orgB]!}.ds_secret`),
          ),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await dataPlane.onModuleDestroy();
      }
    });
  });

  describe('organization settings', () => {
    it('accepts the default time zone (an ICU alias) and records the change', async () => {
      // Regression: Intl.supportedValuesOf lists Asia/Saigon, not Asia/Ho_Chi_Minh.
      const res = await client(app)
        .patch('/api/v1/organizations/current', owner, orgA)
        .send({ timezone: 'Asia/Ho_Chi_Minh', locale: 'en' })
        .expect(200);
      expect(res.body).toMatchObject({ timezone: 'Asia/Ho_Chi_Minh', locale: 'en' });
      await client(app)
        .patch('/api/v1/organizations/current', owner, orgA)
        .send({ timezone: 'Mars/Olympus_Mons' })
        .expect(400);
    });
  });

  describe('invitations and roles', () => {
    let viewer: TestUser;
    let viewerMembershipId: string;

    it('invites a viewer through a single-use link', async () => {
      const token = await invite('viewer');

      const preview = await client(app)
        .post('/api/v1/invitations/preview')
        .send({ token })
        .expect(200);
      expect(preview.body).toMatchObject({ organizationName: 'Org A', role: 'viewer' });

      viewer = await registerUser(app, { label: 'viewer', invitationToken: token });
      expect(viewer.organizationId).toBe(orgA);

      const me = await client(app).get('/api/v1/auth/me', viewer).expect(200);
      expect(me.body.memberships).toEqual([
        expect.objectContaining({ organizationId: orgA, role: 'viewer' }),
      ]);

      // The link cannot be used twice.
      await client(app).post('/api/v1/invitations/accept', other).send({ token }).expect(404);

      const members = await client(app).get('/api/v1/members', owner, orgA).expect(200);
      viewerMembershipId = members.body.find(
        (m: { user: { email: string } }) => m.user.email === viewer.email,
      ).id as string;
    });

    it('does not create an account when the invitation is invalid', async () => {
      await client(app)
        .post('/api/v1/auth/register')
        .send({
          email: `bad-invite@int-test.insightai.local`,
          password: 'correct horse battery staple',
          fullName: 'Nope',
          invitationToken: 'x'.repeat(43),
        })
        .expect(404);
      const row = await admin.query(
        `SELECT 1 FROM app.users WHERE email = 'bad-invite@int-test.insightai.local'`,
      );
      expect(row.rowCount).toBe(0);
    });

    it('enforces permissions per role', async () => {
      await client(app).get('/api/v1/members', viewer, orgA).expect(200); // member:read
      await client(app)
        .post('/api/v1/invitations', viewer, orgA)
        .send({ role: 'viewer' })
        .expect(403);
      await client(app).get('/api/v1/audit-logs', viewer, orgA).expect(403);
      await client(app)
        .patch('/api/v1/organizations/current', viewer, orgA)
        .send({ name: 'X' })
        .expect(403);

      const current = await client(app)
        .get('/api/v1/organizations/current', viewer, orgA)
        .expect(200);
      expect(current.body.role).toBe('viewer');
      expect(current.body.permissions).not.toContain('member:manage');
    });

    it('role changes take effect on the next request', async () => {
      await client(app)
        .patch(`/api/v1/members/${viewerMembershipId}`, owner, orgA)
        .send({ role: 'admin' })
        .expect(200);
      await client(app).get('/api/v1/audit-logs', viewer, orgA).expect(200);
    });

    it('only an owner can grant the owner role', async () => {
      const analystToken = await invite('analyst');
      const analyst = await registerUser(app, { label: 'analyst', invitationToken: analystToken });
      const members = await client(app).get('/api/v1/members', owner, orgA).expect(200);
      const analystMembership = members.body.find(
        (m: { user: { email: string } }) => m.user.email === analyst.email,
      ).id as string;

      // `viewer` is an admin now: may manage members, but not hand out ownership.
      await client(app)
        .patch(`/api/v1/members/${analystMembership}`, viewer, orgA)
        .send({ role: 'owner' })
        .expect(403);
      await client(app)
        .post('/api/v1/invitations', viewer, orgA)
        .send({ role: 'owner' })
        .expect(403);
    });

    it('keeps at least one owner', async () => {
      const members = await client(app).get('/api/v1/members', owner, orgA).expect(200);
      const ownerMembership = members.body.find(
        (m: { user: { email: string } }) => m.user.email === owner.email,
      ).id as string;
      await client(app)
        .patch(`/api/v1/members/${ownerMembership}`, owner, orgA)
        .send({ role: 'admin' })
        .expect(409);
      await client(app).delete(`/api/v1/members/${ownerMembership}`, owner, orgA).expect(409);
    });

    it('cannot touch memberships of another organization by id', async () => {
      await client(app)
        .patch(`/api/v1/members/${viewerMembershipId}`, other, orgB)
        .send({ role: 'viewer' })
        .expect(404);
    });

    it('removing a member revokes access immediately and is audited', async () => {
      await client(app).delete(`/api/v1/members/${viewerMembershipId}`, owner, orgA).expect(204);
      await client(app).get('/api/v1/members', viewer, orgA).expect(403);

      const audit = await client(app).get('/api/v1/audit-logs', owner, orgA).expect(200);
      const actions = audit.body.items.map((e: { action: string }) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'organization.created',
          'invitation.created',
          'invitation.accepted',
          'member.role_changed',
          'member.removed',
        ]),
      );
    });

    it('revoked invitations cannot be previewed', async () => {
      const token = await invite('viewer');
      const list = await client(app).get('/api/v1/invitations', owner, orgA).expect(200);
      const id = list.body[0].id as string;
      await client(app).delete(`/api/v1/invitations/${id}`, owner, orgA).expect(204);
      await client(app).post('/api/v1/invitations/preview').send({ token }).expect(404);
    });
  });
});
