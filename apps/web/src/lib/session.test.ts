import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAccessToken, refreshSession, resetSessionForTests, sessionStore } from './session';

const auth = {
  accessToken: 'new-access',
  expiresIn: 900,
  user: { id: '01a1ce6e-0000-7000-8000-000000000001', email: 'a@example.test', fullName: 'A' },
};
const ok = () => new Response(JSON.stringify(auth), { status: 200 });
const rejected = () => new Response('{"code":"UNAUTHENTICATED"}', { status: 401 });

describe('refreshSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetSessionForTests();
  });

  it('retries once after a 401: another tab may have rotated the cookie at the same time', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);

    expect(await refreshSession()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAccessToken()).toBe('new-access');
    expect(sessionStore.getSnapshot().status).toBe('authenticated');
  });

  it('ends the session when the retry is rejected too', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(rejected()));
    vi.stubGlobal('fetch', fetchMock);

    expect(await refreshSession()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sessionStore.getSnapshot().status).toBe('anonymous');
  });

  it('does not retry other failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await refreshSession()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
