import { Outlet } from 'react-router';
import { useBootstrapSession } from '@/features/auth/use-session';

/** Top-level route: restores the session from the refresh cookie once per page load. */
export function Root() {
  useBootstrapSession();
  return <Outlet />;
}
