import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation } from 'react-router';
import { useMe, useSession } from './use-session';

function FullPageMessage({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground flex min-h-svh items-center justify-center text-sm">
      {children}
    </div>
  );
}

/**
 * Renders children only for signed-in users who belong to at least one organization.
 * This is navigation, not security: the API authorizes every request itself.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const session = useSession();
  const me = useMe();

  if (session.status === 'unknown' || (session.status === 'authenticated' && me.isPending)) {
    return <FullPageMessage>{t('auth.sessionLoading')}</FullPageMessage>;
  }
  if (session.status === 'anonymous') {
    const redirectTo = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?redirectTo=${redirectTo}`} replace />;
  }
  if (me.data && me.data.memberships.length === 0) {
    return <Navigate to="/onboarding" replace />;
  }
  return <>{children}</>;
}

/** Sends signed-in users away from login/register. */
export function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const session = useSession();
  if (session.status === 'unknown') {
    return <FullPageMessage>{t('auth.sessionLoading')}</FullPageMessage>;
  }
  if (session.status === 'authenticated') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Signed in, but membership is not required (onboarding). */
export function RequireSession({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const session = useSession();
  if (session.status === 'unknown') {
    return <FullPageMessage>{t('auth.sessionLoading')}</FullPageMessage>;
  }
  if (session.status === 'anonymous') return <Navigate to="/login" replace />;
  return <>{children}</>;
}
