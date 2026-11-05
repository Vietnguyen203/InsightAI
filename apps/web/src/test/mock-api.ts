import type {
  AuthResponse,
  CurrentOrganization,
  MeResponse,
  Permission,
  SystemRole,
} from '@insightai/contracts';
import { SYSTEM_ROLE_PERMISSIONS } from '@insightai/contracts';
import { vi } from 'vitest';

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Minimal fetch router for component tests: `routes['POST /api/v1/auth/login'] = handler`.
 * Unmatched requests fail loudly so tests never pass by accident.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { key: string; init: RequestInit | undefined }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'http://localhost');
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push({ key, init });
    const handler = routes[key];
    if (!handler) throw new Error(`Unmocked request: ${key}`);
    return handler(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });

export const problem = (status: number, code: string) => () =>
  Response.json(
    { type: 'about:blank', title: 'Error', status, code },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

export const ORG_ID = '0190f5a0-0000-7000-8000-0000000000aa';
export const USER_ID = '0190f5a0-0000-7000-8000-0000000000bb';

export const authResponse: AuthResponse = {
  accessToken: 'test-access-token',
  expiresIn: 900,
  user: { id: USER_ID, email: 'lan@example.com', fullName: 'Nguyễn Lan' },
};

export const meResponse = (role: SystemRole = 'owner'): MeResponse => ({
  user: authResponse.user,
  memberships: [
    {
      organizationId: ORG_ID,
      organizationName: 'Công ty Lan',
      organizationSlug: 'cong-ty-lan-ab12',
      organizationStatus: 'ACTIVE',
      role,
    },
  ],
});

export const currentOrganization = (role: SystemRole = 'owner'): CurrentOrganization => ({
  id: ORG_ID,
  name: 'Công ty Lan',
  slug: 'cong-ty-lan-ab12',
  status: 'ACTIVE',
  timezone: 'Asia/Ho_Chi_Minh',
  locale: 'vi',
  defaultCurrency: 'VND',
  aiDataSharing: 'METADATA_ONLY',
  createdAt: '2026-11-03T00:00:00.000Z',
  role,
  permissions: [...SYSTEM_ROLE_PERMISSIONS[role]] as Permission[],
});

/** Routes for a signed-in user with the given role (session restored from the refresh cookie). */
export function signedInRoutes(role: SystemRole = 'owner'): Record<string, Handler> {
  return {
    'POST /api/v1/auth/refresh': json(authResponse),
    'GET /api/v1/auth/me': json(meResponse(role)),
    'GET /api/v1/organizations/current': json(currentOrganization(role)),
  };
}
