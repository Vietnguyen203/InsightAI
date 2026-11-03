import {
  ORGANIZATION_HEADER,
  type ProblemDetails,
  problemDetailsSchema,
} from '@insightai/contracts';
import { getAccessToken, getActiveOrganizationId, refreshSession } from './session';

/** Error thrown for any non-2xx response; carries the server's RFC 7807 problem when present. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | undefined,
  ) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Accept these non-2xx statuses as a normal response (e.g. 503 from readiness checks). */
  acceptStatuses?: number[];
  /**
   * Send X-Organization-Id with the active organization (default true). Pass a string to target
   * a specific organization, or false for user-level endpoints.
   */
  organization?: boolean | string;
}

async function send(path: string, options: ApiRequestOptions): Promise<Response> {
  const { body, acceptStatuses: _accept, organization = true, headers, ...init } = options;
  const token = getAccessToken();
  const organizationId =
    typeof organization === 'string'
      ? organization
      : organization
        ? getActiveOrganizationId()
        : null;

  return fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(organizationId ? { [ORGANIZATION_HEADER]: organizationId } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/**
 * Thin fetch wrapper. Paths are same-origin (`/api/v1/...`, `/health/...`); in development
 * Vite proxies them to the API, in production a reverse proxy does. A 401 triggers one
 * refresh-and-retry; if the refresh fails the session ends and the error propagates.
 */
export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  let response = await send(path, options);

  const isAuthEndpoint = path.startsWith('/api/v1/auth/');
  if (response.status === 401 && !isAuthEndpoint && getAccessToken() !== null) {
    if (await refreshSession()) response = await send(path, options);
  }

  if (!response.ok && !(options.acceptStatuses ?? []).includes(response.status)) {
    let problem: ProblemDetails | undefined;
    if (response.headers.get('content-type')?.includes('json')) {
      const parsed = problemDetailsSchema.safeParse(await response.json().catch(() => undefined));
      problem = parsed.success ? parsed.data : undefined;
    }
    throw new ApiError(response.status, problem);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
