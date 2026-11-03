import type {
  AuditLogEntry,
  CreatedInvitation,
  CreateInvitationRequest,
  Invitation,
  Member,
  Organization,
  Page,
  SystemRole,
  UpdateOrganizationRequest,
} from '@insightai/contracts';
import { apiFetch } from '@/lib/api-client';

export const organizationsApi = {
  create: (name: string) =>
    apiFetch<Organization>('/api/v1/organizations', {
      method: 'POST',
      body: { name },
      organization: false,
    }),
  update: (body: UpdateOrganizationRequest) =>
    apiFetch<Organization>('/api/v1/organizations/current', { method: 'PATCH', body }),

  members: () => apiFetch<Member[]>('/api/v1/members'),
  changeRole: (membershipId: string, role: SystemRole) =>
    apiFetch<Member>(`/api/v1/members/${membershipId}`, { method: 'PATCH', body: { role } }),
  removeMember: (membershipId: string) =>
    apiFetch<void>(`/api/v1/members/${membershipId}`, { method: 'DELETE' }),

  invitations: () => apiFetch<Invitation[]>('/api/v1/invitations'),
  createInvitation: (body: CreateInvitationRequest) =>
    apiFetch<CreatedInvitation>('/api/v1/invitations', { method: 'POST', body }),
  revokeInvitation: (id: string) =>
    apiFetch<void>(`/api/v1/invitations/${id}`, { method: 'DELETE' }),

  auditLogs: (cursor?: string) =>
    apiFetch<Page<AuditLogEntry>>(
      `/api/v1/audit-logs?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
};
