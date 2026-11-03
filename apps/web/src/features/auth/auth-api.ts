import {
  type AuthResponse,
  type InvitationPreview,
  type LoginRequest,
  type MeResponse,
  type MembershipSummary,
  type RegisterRequest,
} from '@insightai/contracts';
import { apiFetch } from '@/lib/api-client';

export const authApi = {
  login: (body: LoginRequest) =>
    apiFetch<AuthResponse>('/api/v1/auth/login', { method: 'POST', body, organization: false }),
  register: (body: RegisterRequest) =>
    apiFetch<AuthResponse>('/api/v1/auth/register', { method: 'POST', body, organization: false }),
  me: () => apiFetch<MeResponse>('/api/v1/auth/me', { organization: false }),
  previewInvitation: (token: string) =>
    apiFetch<InvitationPreview>('/api/v1/invitations/preview', {
      method: 'POST',
      body: { token },
      organization: false,
    }),
  acceptInvitation: (token: string) =>
    apiFetch<MembershipSummary>('/api/v1/invitations/accept', {
      method: 'POST',
      body: { token },
      organization: false,
    }),
};
