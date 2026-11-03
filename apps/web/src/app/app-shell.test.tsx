import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { resetSessionForTests } from '@/lib/session';
import {
  authResponse,
  currentOrganization,
  json,
  meResponse,
  mockApi,
  ORG_ID,
  problem,
  signedInRoutes,
  USER_ID,
} from '@/test/mock-api';
import { createQueryClient } from './query-client';
import { routes } from './router';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const member = (role: string, email: string, fullName: string, id: string) => ({
  id,
  user: { id: `user-${id}`, email, fullName },
  role,
  status: 'ACTIVE',
  joinedAt: '2026-11-03T00:00:00.000Z',
});

describe('App', () => {
  beforeEach(async () => {
    resetSessionForTests();
    localStorage.clear();
    await i18n.changeLanguage('vi');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('authentication', () => {
    it('sends anonymous visitors to the login page, keeping the destination', async () => {
      mockApi({ 'POST /api/v1/auth/refresh': problem(401, 'UNAUTHENTICATED') });
      const router = renderAt('/settings/members');
      expect(await screen.findByText('Đăng nhập để tiếp tục với InsightAI.')).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/login');
      expect(router.state.location.search).toBe('?redirectTo=%2Fsettings%2Fmembers');
    });

    it('signs in and returns to the requested page', async () => {
      const { calls } = mockApi({
        'POST /api/v1/auth/refresh': problem(401, 'UNAUTHENTICATED'),
        'POST /api/v1/auth/login': json(authResponse),
        'GET /api/v1/auth/me': json(meResponse()),
        'GET /api/v1/organizations/current': json(currentOrganization()),
        'GET /api/v1/members': json([]),
        'GET /api/v1/invitations': json([]),
      });
      const router = renderAt('/login?redirectTo=%2Fsettings%2Fmembers');

      fireEvent.change(await screen.findByLabelText('Email'), {
        target: { value: 'Lan@Example.com' },
      });
      fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'secret-password' } });
      fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));

      await waitFor(() => expect(router.state.location.pathname).toBe('/settings/members'));
      const login = calls.find((c) => c.key === 'POST /api/v1/auth/login');
      expect(JSON.parse(login?.init?.body as string)).toEqual({
        email: 'lan@example.com',
        password: 'secret-password',
      });
      // Tenant requests carry the bearer token and the active organization.
      const members = calls.find((c) => c.key === 'GET /api/v1/members');
      const headers = members?.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-access-token');
      expect(headers['x-organization-id']).toBe(ORG_ID);
    });

    it('shows a generic message for wrong credentials', async () => {
      mockApi({
        'POST /api/v1/auth/refresh': problem(401, 'UNAUTHENTICATED'),
        'POST /api/v1/auth/login': problem(401, 'UNAUTHENTICATED'),
      });
      renderAt('/login');
      fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@b.co' } });
      fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'nope' } });
      fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
      expect(await screen.findByText('Email hoặc mật khẩu không đúng.')).toBeInTheDocument();
    });

    it('validates the form before calling the API', async () => {
      const { calls } = mockApi({ 'POST /api/v1/auth/refresh': problem(401, 'UNAUTHENTICATED') });
      renderAt('/login');
      fireEvent.change(await screen.findByLabelText('Email'), {
        target: { value: 'not-an-email' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
      expect(await screen.findByText('Email không hợp lệ.')).toBeInTheDocument();
      expect(calls.some((c) => c.key === 'POST /api/v1/auth/login')).toBe(false);
    });

    it('never stores the access token in web storage', async () => {
      mockApi(signedInRoutes());
      renderAt('/');
      await screen.findByText('Chào mừng đến với InsightAI');
      const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
      expect(stored).not.toContain('test-access-token');
    });
  });

  describe('permission-aware UI', () => {
    const membersRoutes = {
      'GET /api/v1/members': json([
        {
          ...member('owner', 'lan@example.com', 'Nguyễn Lan', 'm1'),
          user: { id: USER_ID, email: 'lan@example.com', fullName: 'Nguyễn Lan' },
        },
        member('viewer', 'minh@example.com', 'Trần Minh', 'm2'),
      ]),
      'GET /api/v1/invitations': json([]),
    };

    it('owners can manage members and create invitation links', async () => {
      mockApi({ ...signedInRoutes('owner'), ...membersRoutes });
      renderAt('/settings/members');
      expect(await screen.findByText('Trần Minh')).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Tạo link mời' })).toBeInTheDocument();
      expect(screen.getByLabelText('Vai trò: Trần Minh')).toBeInTheDocument();
      // No self-service role change/removal from the member table.
      expect(screen.queryByLabelText('Vai trò: Nguyễn Lan')).not.toBeInTheDocument();
      // Desktop sidebar and mobile nav both render in jsdom (no CSS).
      expect(screen.getAllByRole('link', { name: 'Nhật ký hoạt động' }).length).toBeGreaterThan(0);
    });

    it('viewers see the member list read-only, without invitations or audit log', async () => {
      mockApi({ ...signedInRoutes('viewer'), ...membersRoutes });
      renderAt('/settings/members');
      expect(await screen.findByText('Trần Minh')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Tạo link mời' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Vai trò: Trần Minh')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Nhật ký hoạt động' })).not.toBeInTheDocument();
    });

    it('shows a created invitation link once', async () => {
      mockApi({
        ...signedInRoutes('owner'),
        ...membersRoutes,
        'POST /api/v1/invitations': json(
          {
            id: '0190f5a0-0000-7000-8000-0000000000cc',
            role: 'viewer',
            createdBy: null,
            expiresAt: '2026-11-06T00:00:00.000Z',
            createdAt: '2026-11-03T00:00:00.000Z',
            token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCD',
          },
          201,
        ),
      });
      renderAt('/settings/members');
      fireEvent.click(await screen.findByRole('button', { name: 'Tạo link mời' }));
      const link = await screen.findByLabelText('Invitation link');
      expect((link as HTMLInputElement).value).toBe(
        `${window.location.origin}/invite/tok_abcdefghijklmnopqrstuvwxyz0123456789ABCD`,
      );
    });
  });

  describe('session refresh', () => {
    it('refreshes an expired access token once and retries the request', async () => {
      let membersCalls = 0;
      const { calls } = mockApi({
        ...signedInRoutes('owner'),
        'GET /api/v1/members': () => {
          membersCalls += 1;
          return membersCalls === 1
            ? problem(401, 'UNAUTHENTICATED')()
            : Response.json([member('owner', 'lan@example.com', 'Nguyễn Lan', 'm1')]);
        },
        'GET /api/v1/invitations': json([]),
      });
      renderAt('/settings/members');
      expect(await screen.findByText('lan@example.com')).toBeInTheDocument();
      expect(calls.filter((c) => c.key === 'POST /api/v1/auth/refresh')).toHaveLength(2);
    });
  });

  describe('shell', () => {
    it('switches language and theme', async () => {
      mockApi(signedInRoutes());
      renderAt('/');
      expect(await screen.findByText('Chào mừng đến với InsightAI')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Ngôn ngữ'), { target: { value: 'en' } });
      expect(await screen.findByText('Welcome to InsightAI')).toBeInTheDocument();

      const before = document.documentElement.classList.contains('dark');
      fireEvent.click(screen.getByRole('button', { name: 'Toggle light/dark theme' }));
      expect(document.documentElement.classList.contains('dark')).toBe(!before);
    });

    it('shows dependency status, including a degraded (503) readiness response', async () => {
      mockApi({
        ...signedInRoutes(),
        'GET /health/ready': json(
          {
            status: 'error',
            info: { database: { status: 'up' }, storage: { status: 'up' } },
            error: { redis: { status: 'down' } },
          },
          503,
        ),
      });
      renderAt('/system');
      await waitFor(() => expect(screen.getAllByText('Hoạt động')).toHaveLength(2));
      expect(screen.getByText('Lỗi')).toBeInTheDocument();
    });
  });
});
