import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { routes } from '@/app/router';
import i18n from '@/i18n';
import { resetSessionForTests } from '@/lib/session';
import { currentOrganization, json, mockApi, signedInRoutes } from '@/test/mock-api';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('Organization settings – AI data sharing', () => {
  beforeEach(async () => {
    resetSessionForTests();
    localStorage.clear();
    await i18n.changeLanguage('vi');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('defaults to metadata only and lets the owner allow result samples', async () => {
    const { calls } = mockApi({
      ...signedInRoutes('owner'),
      'GET /api/v1/ai/status': json({
        enabled: true,
        dailyLimit: 200,
        remainingToday: 200,
        provider: 'api.groq.com',
      }),
      'PATCH /api/v1/organizations/current': json({
        ...currentOrganization('owner'),
        aiDataSharing: 'FULL',
      }),
    });
    renderAt('/settings/organization');
    const select = await screen.findByLabelText('Dữ liệu gửi tới dịch vụ AI');
    expect(select).toHaveValue('METADATA_ONLY');
    // The notice names the provider configured on the server (L9), not a fixed vendor.
    expect(
      await screen.findByText(/Dịch vụ AI \(api\.groq\.com\) xử lý ngoài Việt Nam/),
    ).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'FULL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'PATCH /api/v1/organizations/current')).toBe(true),
    );
    const body = JSON.parse(
      calls.find((c) => c.key === 'PATCH /api/v1/organizations/current')!.init!.body as string,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ aiDataSharing: 'FULL' });
  });

  it('is read-only for members who cannot change the organization', async () => {
    mockApi(signedInRoutes('viewer'));
    renderAt('/settings/organization');
    expect(await screen.findByLabelText('Dữ liệu gửi tới dịch vụ AI')).toBeDisabled();
  });
});
