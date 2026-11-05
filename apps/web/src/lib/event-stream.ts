import { ORGANIZATION_HEADER, problemDetailsSchema } from '@insightai/contracts';
import { ApiError } from './api-client';
import { getAccessToken, getActiveOrganizationId, refreshSession } from './session';

function send(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const token = getAccessToken();
  const organizationId = getActiveOrganizationId();
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(organizationId ? { [ORGANIZATION_HEADER]: organizationId } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * POST that answers with server-sent events (`data: <JSON>` blocks). EventSource cannot send a
 * body or the bearer token, so the stream is read from fetch. Errors before the stream starts
 * are RFC 7807 problems (ApiError), with the same refresh-and-retry on 401 as apiFetch.
 */
export async function postEventStream(
  path: string,
  body: unknown,
  onEvent: (data: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response = await send(path, body, signal);
  if (response.status === 401 && getAccessToken() !== null && (await refreshSession())) {
    response = await send(path, body, signal);
  }
  if (!response.ok) {
    const parsed = problemDetailsSchema.safeParse(await response.json().catch(() => undefined));
    throw new ApiError(response.status, parsed.success ? parsed.data : undefined);
  }
  if (!response.body) throw new TypeError('Empty event stream');

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const flush = (block: string) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) onEvent(JSON.parse(data));
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
