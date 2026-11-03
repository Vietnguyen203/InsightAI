import { type AuthResponse } from '@insightai/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  endSession,
  logoutSession,
  refreshSession,
  type SessionSnapshot,
  sessionStore,
  startSession,
} from '@/lib/session';
import { authApi } from './auth-api';

export const ME_QUERY_KEY = ['me'] as const;

export function useSession(): SessionSnapshot {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
}

/** Restores the session from the refresh cookie once, when the app starts. */
export function useBootstrapSession(): void {
  const { status } = useSession();
  useEffect(() => {
    if (status === 'unknown') void refreshSession();
  }, [status]);
}

export function useMe() {
  const { status } = useSession();
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: authApi.me,
    enabled: status === 'authenticated',
    staleTime: 60_000,
  });
}

export function useSessionActions() {
  const queryClient = useQueryClient();

  const signIn = useCallback(
    async (auth: AuthResponse) => {
      queryClient.clear(); // never show the previous user's cached data
      startSession(auth);
      await queryClient.fetchQuery({ queryKey: ME_QUERY_KEY, queryFn: authApi.me });
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    await logoutSession().catch(() => endSession());
    queryClient.clear();
  }, [queryClient]);

  return { signIn, signOut };
}
