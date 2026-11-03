import {
  type AuthResponse,
  authResponseSchema,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  type UserSummary,
} from '@insightai/contracts';

/**
 * Client-side session (decision D-21). The access token lives only in memory: it is never
 * written to localStorage, so a script injected into the page cannot lift a long-lived
 * credential. On page load the session is restored from the httpOnly refresh cookie.
 */
export type SessionStatus = 'unknown' | 'authenticated' | 'anonymous';

export interface SessionSnapshot {
  status: SessionStatus;
  user: UserSummary | null;
}

let accessToken: string | null = null;
let snapshot: SessionSnapshot = { status: 'unknown', user: null };
const listeners = new Set<() => void>();

function publish(next: SessionSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

// Arrow functions: React calls these detached from the object (useSyncExternalStore).
export const sessionStore = {
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: (): SessionSnapshot => snapshot,
};

export function getAccessToken(): string | null {
  return accessToken;
}

export function startSession(auth: AuthResponse): void {
  accessToken = auth.accessToken;
  publish({ status: 'authenticated', user: auth.user });
}

export function endSession(): void {
  accessToken = null;
  publish({ status: 'anonymous', user: null });
}

let inFlightRefresh: Promise<boolean> | null = null;

/**
 * Exchanges the refresh cookie for a new access token. Concurrent callers share one request:
 * the server rotates refresh tokens, so parallel refreshes from one tab would race each other.
 */
export function refreshSession(): Promise<boolean> {
  inFlightRefresh ??= (async () => {
    try {
      const response = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
      });
      if (!response.ok) {
        endSession();
        return false;
      }
      startSession(authResponseSchema.parse(await response.json()));
      return true;
    } catch {
      endSession();
      return false;
    } finally {
      inFlightRefresh = null;
    }
  })();
  return inFlightRefresh;
}

export async function logoutSession(): Promise<void> {
  try {
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE },
    });
  } finally {
    endSession();
  }
}

// ── Active organization ────────────────────────────────────────────────────────
// A per-browser convenience only: the server verifies membership on every request.

const ORG_STORAGE_KEY = 'insightai.organization';
let activeOrganizationId: string | null = readStoredOrganization();
const orgListeners = new Set<() => void>();

function readStoredOrganization(): string | null {
  try {
    return localStorage.getItem(ORG_STORAGE_KEY);
  } catch {
    return null;
  }
}

export const organizationStore = {
  subscribe: (listener: () => void): (() => void) => {
    orgListeners.add(listener);
    return () => orgListeners.delete(listener);
  },
  getSnapshot: (): string | null => activeOrganizationId,
};

export function getActiveOrganizationId(): string | null {
  return activeOrganizationId;
}

export function setActiveOrganizationId(id: string | null): void {
  if (id === activeOrganizationId) return;
  activeOrganizationId = id;
  try {
    if (id) localStorage.setItem(ORG_STORAGE_KEY, id);
    else localStorage.removeItem(ORG_STORAGE_KEY);
  } catch {
    // Storage unavailable: the choice lasts for this page load only.
  }
  for (const listener of orgListeners) listener();
}

/** Test helper: resets module state between tests. */
export function resetSessionForTests(): void {
  accessToken = null;
  inFlightRefresh = null;
  activeOrganizationId = null;
  snapshot = { status: 'unknown', user: null };
}
