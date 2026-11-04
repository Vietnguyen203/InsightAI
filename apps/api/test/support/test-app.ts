import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CSRF_HEADER, CSRF_HEADER_VALUE, ORGANIZATION_HEADER } from '@insightai/contracts';
import type pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/configure-app';
import { LLM_PROVIDER, type LlmProvider } from '../../src/modules/ai/llm-provider';

/** Every account created by integration tests uses this domain, so cleanup can target it exactly. */
export const TEST_EMAIL_DOMAIN = 'int-test.insightai.local';

export const testEmail = (label: string) =>
  `${label}-${randomBytes(4).toString('hex')}@${TEST_EMAIL_DOMAIN}`;

export const TEST_PASSWORD = 'correct horse battery staple';

export async function createTestApp(
  options: { rateLimit?: boolean; llm?: LlmProvider | null } = {},
): Promise<INestApplication> {
  process.env.RATE_LIMIT_ENABLED = options.rateLimit ? 'true' : 'false';
  process.env.LOG_LEVEL = 'fatal'; // keep request logs out of test output
  const builder = Test.createTestingModule({ imports: [AppModule] });
  // Tests never call a real LLM: they inject a scripted provider (or none).
  const moduleRef = await builder
    .overrideProvider(LLM_PROVIDER)
    .useValue(options.llm ?? null)
    .compile();
  const app = moduleRef.createNestApplication({
    logger: process.env.TEST_APP_LOGS === 'true' ? ['error'] : false,
  });
  configureApp(app);
  await app.init();
  return app;
}

export interface TestUser {
  email: string;
  accessToken: string;
  refreshCookie: string;
  userId: string;
  organizationId?: string;
}

export function client(app: INestApplication) {
  const server = app.getHttpServer() as App;
  const withAuth = (req: request.Test, user?: TestUser, organizationId?: string) => {
    if (user) req.set('authorization', `Bearer ${user.accessToken}`);
    if (organizationId) req.set(ORGANIZATION_HEADER, organizationId);
    return req;
  };
  return {
    get: (path: string, user?: TestUser, org?: string) =>
      withAuth(request(server).get(path), user, org),
    post: (path: string, user?: TestUser, org?: string) =>
      withAuth(request(server).post(path), user, org),
    patch: (path: string, user?: TestUser, org?: string) =>
      withAuth(request(server).patch(path), user, org),
    delete: (path: string, user?: TestUser, org?: string) =>
      withAuth(request(server).delete(path), user, org),
    /** Cookie-authenticated call with the CSRF header. */
    refresh: (cookie: string) =>
      request(server)
        .post('/api/v1/auth/refresh')
        .set('cookie', cookie)
        .set(CSRF_HEADER, CSRF_HEADER_VALUE),
  };
}

export function refreshCookieFrom(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((value) => value.startsWith('insightai_rt='));
  if (!cookie) throw new Error('No refresh cookie in response');
  return cookie.split(';')[0]!;
}

export async function registerUser(
  app: INestApplication,
  options: { label: string; organizationName?: string; invitationToken?: string },
): Promise<TestUser> {
  const email = testEmail(options.label);
  const res = await client(app)
    .post('/api/v1/auth/register')
    .send({
      email,
      password: TEST_PASSWORD,
      fullName: `Test ${options.label}`,
      ...(options.invitationToken
        ? { invitationToken: options.invitationToken }
        : { organizationName: options.organizationName ?? `Org ${options.label}` }),
    })
    .expect(201);

  const user: TestUser = {
    email,
    accessToken: res.body.accessToken as string,
    refreshCookie: refreshCookieFrom(res),
    userId: res.body.user.id as string,
  };
  const me = await client(app).get('/api/v1/auth/me', user).expect(200);
  user.organizationId = (me.body.memberships as { organizationId: string }[])[0]?.organizationId;
  return user;
}

/**
 * Removes every account, organization and tenant schema created by tests (identified by the
 * test email domain). Runs as the superuser, which bypasses RLS and the append-only grant on
 * audit_logs; never touches rows that do not belong to test accounts.
 */
export async function cleanupTestData(admin: pg.Client): Promise<void> {
  const users = await admin.query<{ id: string }>(`SELECT id FROM app.users WHERE email LIKE $1`, [
    `%@${TEST_EMAIL_DOMAIN}`,
  ]);
  const userIds = users.rows.map((row) => row.id);
  if (userIds.length === 0) return;

  const orgs = await admin.query<{ id: string; data_schema: string }>(
    `SELECT DISTINCT o.id, o.data_schema FROM app.organizations o
       JOIN app.memberships m ON m.organization_id = o.id
      WHERE m.user_id = ANY($1::uuid[])`,
    [userIds],
  );
  const orgIds = orgs.rows.map((row) => row.id);

  await admin.query('BEGIN');
  await admin.query(
    `DELETE FROM app.audit_logs WHERE organization_id = ANY($1::uuid[]) OR actor_user_id = ANY($2::uuid[])`,
    [orgIds, userIds],
  );
  await admin.query(`DELETE FROM app.invitations WHERE organization_id = ANY($1::uuid[])`, [
    orgIds,
  ]);
  // Data management (children first; the active-version link points back at versions).
  const byOrg = 'organization_id = ANY($1::uuid[])';
  await admin.query(`UPDATE app.datasets SET active_version_id = NULL WHERE ${byOrg}`, [orgIds]);
  await admin.query(`DELETE FROM app.quality_issues WHERE ${byOrg}`, [orgIds]);
  await admin.query(`DELETE FROM app.quality_check_results WHERE ${byOrg}`, [orgIds]);
  await admin.query(`DELETE FROM app.quality_checks WHERE ${byOrg}`, [orgIds]);
  await admin.query(`DELETE FROM app.quality_rules WHERE ${byOrg}`, [orgIds]);
  await admin.query(`DELETE FROM app.query_history WHERE ${byOrg}`, [orgIds]);
  await admin.query(`DELETE FROM app.llm_usage WHERE ${byOrg}`, [orgIds]);
  // Semantic members are removed with their model (FK cascade).
  await admin.query(`DELETE FROM app.semantic_models WHERE ${byOrg}`, [orgIds]);
  // Cleaning jobs and versions reference each other (source / produced version).
  await admin.query(`DELETE FROM app.cleaning_operations WHERE ${byOrg}`, [orgIds]);
  await admin.query(`UPDATE app.dataset_versions SET cleaning_job_id = NULL WHERE ${byOrg}`, [
    orgIds,
  ]);
  await admin.query(`DELETE FROM app.cleaning_jobs WHERE ${byOrg}`, [orgIds]);
  await admin.query(`DELETE FROM app.dataset_columns WHERE ${byOrg}`, [orgIds]);
  await admin.query(`DELETE FROM app.dataset_versions WHERE ${byOrg}`, [orgIds]);
  await admin.query(`DELETE FROM app.import_jobs WHERE ${byOrg}`, [orgIds]);
  await admin.query(`DELETE FROM app.datasets WHERE ${byOrg}`, [orgIds]);
  await admin.query(`DELETE FROM app.data_sources WHERE ${byOrg}`, [orgIds]);
  await admin.query(`DELETE FROM app.memberships WHERE organization_id = ANY($1::uuid[])`, [
    orgIds,
  ]);
  await admin.query(`DELETE FROM app.organizations WHERE id = ANY($1::uuid[])`, [orgIds]);
  await admin.query(`DELETE FROM app.refresh_tokens WHERE user_id = ANY($1::uuid[])`, [userIds]);
  await admin.query(`DELETE FROM app.users WHERE id = ANY($1::uuid[])`, [userIds]);
  await admin.query('COMMIT');

  for (const { data_schema: schema } of orgs.rows) {
    if (!/^t_[a-z0-9]{10}$/.test(schema)) continue;
    const id = (value: string) => admin.escapeIdentifier(value);
    await admin.query(`DROP SCHEMA IF EXISTS ${id(schema)} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${id(`${schema}_reader`)}`);
    await admin.query(`DROP ROLE IF EXISTS ${id(`${schema}_writer`)}`);
  }
}
