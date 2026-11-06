import { ORGANIZATION_HEADER, problemDetailsSchema } from '@insightai/contracts';
import { ApiError } from './api-client';
import { getAccessToken, getActiveOrganizationId, refreshSession } from './session';

function send(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> },
  signal?: AbortSignal,
): Promise<Response> {
  const token = getAccessToken();
  const organizationId = getActiveOrganizationId();
  return fetch(path, {
    method: init.method,
    credentials: 'same-origin',
    headers: {
      Accept: 'text/event-stream',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(organizationId ? { [ORGANIZATION_HEADER]: organizationId } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal,
  });
}

/**
 * Reads a server-sent event stream (`id:` / `data: <JSON>` blocks) from fetch: EventSource cannot
 * send the bearer token. Errors before the stream starts are RFC 7807 problems (ApiError), with
 * the same refresh-and-retry on 401 as apiFetch.
 */
async function readEventStream(
  path: string,
  init: Parameters<typeof send>[1],
  onEvent: (data: unknown, id: string | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response = await send(path, init, signal);
  if (response.status === 401 && getAccessToken() !== null && (await refreshSession())) {
    response = await send(path, init, signal);
  }
  if (!response.ok) {
    const parsed = problemDetailsSchema.safeParse(await response.json().catch(() => undefined));
    throw new ApiError(response.status, parsed.success ? parsed.data : undefined);
  }
  if (!response.body) throw new TypeError('Empty event stream');

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const flush = (block: string) => {
    const lines = block.split('\n');
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    const id =
      lines
        .find((line) => line.startsWith('id:'))
        ?.slice(3)
        .trim() ?? null;
    if (data) onEvent(JSON.parse(data), id);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value.replaceAll('\r\n', '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      flush(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
  }
  if (buffer.trim()) flush(buffer);
}

/** POST that answers with server-sent events. */
export function postEventStream(
  path: string,
  body: unknown,
  onEvent: (data: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  return readEventStream(path, { method: 'POST', body }, (data) => onEvent(data), signal);
}

/** GET event stream that can resume after `lastEventId` (sent as `Last-Event-ID`). */
export function getEventStream(
  path: string,
  onEvent: (data: unknown, id: string | null) => void,
  options: { signal?: AbortSignal; lastEventId?: string | null } = {},
): Promise<void> {
  return readEventStream(
    path,
    {
      method: 'GET',
      headers: options.lastEventId ? { 'Last-Event-ID': options.lastEventId } : undefined,
    },
    onEvent,
    options.signal,
  );
}
