import { type ProblemDetails, problemDetailsSchema } from '@insightai/contracts';

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
}

/**
 * Thin fetch wrapper. Paths are same-origin (`/api/v1/...`, `/health/...`); in development
 * Vite proxies them to the API, in production a reverse proxy does.
 */
export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { body, acceptStatuses = [], headers, ...init } = options;
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok && !acceptStatuses.includes(response.status)) {
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
