import type { INestApplication } from '@nestjs/common';
import { problemDetailsSchema } from '@insightai/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAdmin } from './support/admin-db';
import {
  cleanupTestData,
  client,
  createTestApp,
  refreshCookieFrom,
  registerUser,
  TEST_PASSWORD,
  testEmail,
  type TestUser,
} from './support/test-app';

describe('auth (integration)', () => {
  let app: INestApplication;
  let admin: pg.Client;
  let alice: TestUser;

  beforeAll(async () => {
    admin = await connectAdmin();
    app = await createTestApp();
    alice = await registerUser(app, { label: 'alice', organizationName: 'Công ty Alice' });
  });

  afterAll(async () => {
    await app?.close();
    if (admin) {
      await cleanupTestData(admin);
      await admin.end();
    }
  });

  it('registration creates an owner membership in an ACTIVE, provisioned organization', async () => {
    const me = await client(app).get('/api/v1/auth/me', alice).expect(200);
    expect(me.body.user.email).toBe(alice.email);
    expect(me.body.memberships).toEqual([
      expect.objectContaining({
        organizationName: 'Công ty Alice',
        organizationStatus: 'ACTIVE',
        role: 'owner',
      }),
    ]);
    expect(me.body.memberships[0].organizationSlug).toMatch(/^cong-ty-alice-[a-z0-9]{4}$/);

    const org = await admin.query<{ data_schema: string }>(
      'SELECT data_schema FROM app.organizations WHERE id = $1',
      [alice.organizationId],
    );
    const schema = org.rows[0]!.data_schema;
    const namespace = await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
    const roles = await admin.query(
      'SELECT rolname FROM pg_roles WHERE rolname LIKE $1 ORDER BY 1',
      [`${schema}_%`],
    );
    expect(namespace.rowCount).toBe(1);
    expect(roles.rows.map((r) => r.rolname)).toEqual([`${schema}_reader`, `${schema}_writer`]);
  });

  it('stores an Argon2id hash, never the password', async () => {
    const row = await admin.query<{ password_hash: string }>(
      'SELECT password_hash FROM app.users WHERE id = $1',
      [alice.userId],
    );
    expect(row.rows[0]!.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('sets the refresh token as an httpOnly, SameSite=Strict cookie scoped to /api/v1/auth', async () => {
    const res = await client(app)
      .post('/api/v1/auth/login')
      .send({ email: alice.email, password: TEST_PASSWORD })
      .expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('insightai_rt='),
    );
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(res.body).not.toHaveProperty('refreshToken');
  });

  it('rejects duplicate emails (case-insensitive)', async () => {
    const res = await client(app)
      .post('/api/v1/auth/register')
      .send({
        email: alice.email.toUpperCase(),
        password: TEST_PASSWORD,
        fullName: 'Copy',
        organizationName: 'Dup Org',
      })
      .expect(409);
    expect(problemDetailsSchema.parse(res.body).code).toBe('CONFLICT');
  });

  it('validates input with field-level errors', async () => {
    const res = await client(app)
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: 'short', fullName: '' })
      .expect(400);
    const problem = problemDetailsSchema.parse(res.body);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors?.map((e) => e.path)).toEqual(
      expect.arrayContaining(['email', 'password', 'fullName']),
    );
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await client(app)
      .post('/api/v1/auth/login')
      .send({ email: alice.email, password: 'wrong password!!' })
      .expect(401);
    const unknownEmail = await client(app)
      .post('/api/v1/auth/login')
      .send({ email: testEmail('nobody'), password: 'wrong password!!' })
      .expect(401);
    expect(wrongPassword.body.detail).toBe(unknownEmail.body.detail);
  });

  it('requires a valid access token on protected routes', async () => {
    await client(app).get('/api/v1/auth/me').expect(401);
    await client(app).get('/api/v1/auth/me').set('authorization', 'Bearer not.a.jwt').expect(401);
    const forged = alice.accessToken.slice(0, -4) + 'AAAA';
    await client(app).get('/api/v1/auth/me').set('authorization', `Bearer ${forged}`).expect(401);
  });

  it('refresh requires the CSRF header', async () => {
    await client(app).post('/api/v1/auth/refresh').set('cookie', alice.refreshCookie).expect(403);
  });

  it('rotates refresh tokens and tolerates a concurrent reuse within the grace period', async () => {
    const session = await registerUser(app, { label: 'rotate' });
    const first = await client(app).refresh(session.refreshCookie).expect(200);
    const rotatedCookie = refreshCookieFrom(first);
    expect(rotatedCookie).not.toBe(session.refreshCookie);

    // Same old token again right away (e.g. a second tab): rejected, but the session survives.
    await client(app).refresh(session.refreshCookie).expect(401);
    await client(app).refresh(rotatedCookie).expect(200);
  });

  it('revokes the whole session family when a rotated token is replayed later', async () => {
    const session = await registerUser(app, { label: 'replay' });
    const rotated = refreshCookieFrom(await client(app).refresh(session.refreshCookie).expect(200));

    // Simulate the replay happening after the grace window.
    await admin.query(
      `UPDATE app.refresh_tokens SET revoked_at = now() - interval '1 minute'
        WHERE user_id = $1 AND replaced_by IS NOT NULL`,
      [session.userId],
    );
    await client(app).refresh(session.refreshCookie).expect(401);
    await client(app).refresh(rotated).expect(401); // the legitimate token died with the family

    const audit = await admin.query(
      `SELECT 1 FROM app.audit_logs WHERE actor_user_id = $1 AND action = 'auth.refresh_reuse_detected'`,
      [session.userId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('logout revokes the session', async () => {
    const session = await registerUser(app, { label: 'logout' });
    await client(app)
      .post('/api/v1/auth/logout')
      .set('cookie', session.refreshCookie)
      .set('x-requested-with', 'insightai')
      .expect(204);
    await client(app).refresh(session.refreshCookie).expect(401);
  });
});

describe('rate limiting (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({ rateLimit: true });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('limits login attempts per client', async () => {
    const email = testEmail('ratelimit');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await client(app)
        .post('/api/v1/auth/login')
        .set('x-forwarded-for', '203.0.113.7') // ignored: no trusted proxy hops configured
        .send({ email, password: 'whatever-password' });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(problemDetailsSchema.parse(res.body).code).toBe('RATE_LIMITED');
      }
    }
    // Counters live in Redis for 60s, so a re-run may start partway through the window:
    // assert the shape (at most 10 attempts pass, then only 429s) rather than exact positions.
    const firstBlocked = statuses.indexOf(429);
    expect(firstBlocked).toBeGreaterThanOrEqual(0);
    expect(firstBlocked).toBeLessThanOrEqual(10);
    expect(statuses.slice(0, firstBlocked).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(firstBlocked).every((s) => s === 429)).toBe(true);
  });
});
