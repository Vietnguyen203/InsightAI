import {
  type CurrentOrganization,
  type MembershipSummary,
  type Permission,
} from '@insightai/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '@/lib/api-client';
import { organizationStore, setActiveOrganizationId } from '@/lib/session';
import { useMe } from '../auth/use-session';

/** All tenant-scoped query keys start with this, so switching organization never mixes caches. */
export const orgKey = (organizationId: string | null, ...rest: unknown[]) =>
  ['org', organizationId, ...rest] as const;

/**
 * The organization the user is working in. Falls back to the first membership when the stored
 * choice is missing or no longer valid (e.g. the user was removed from it).
 */
export function useActiveOrganization(): {
  organizationId: string | null;
  membership: MembershipSummary | null;
  memberships: MembershipSummary[];
} {
  const stored = useSyncExternalStore(organizationStore.subscribe, organizationStore.getSnapshot);
  const { data: me } = useMe();
  const memberships = me?.memberships ?? [];
  const membership = memberships.find((m) => m.organizationId === stored) ?? memberships[0] ?? null;

  useEffect(() => {
    if (me && membership?.organizationId !== stored) {
      setActiveOrganizationId(membership?.organizationId ?? null);
    }
  }, [me, membership, stored]);

  return { organizationId: membership?.organizationId ?? null, membership, memberships };
}

export function useCurrentOrganization() {
  const { organizationId } = useActiveOrganization();
  return useQuery({
    queryKey: orgKey(organizationId, 'current'),
    queryFn: () =>
      apiFetch<CurrentOrganization>('/api/v1/organizations/current', {
        organization: organizationId ?? false,
      }),
    enabled: organizationId !== null,
  });
}

/**
 * UI-only permission check, for hiding controls the user cannot use. The server enforces
 * every permission independently; this is never a security boundary.
 */
export function usePermission(permission: Permission): boolean {
  const { data } = useCurrentOrganization();
  return data?.permissions.includes(permission) ?? false;
}
