import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { createQueryClient } from './query-client';
import { routes } from './router';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function mockHealth(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(body, { status }))),
  );
}

describe('App shell', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('vi');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders Vietnamese by default and switches to English', async () => {
    renderAt('/');
    expect(screen.getByText('Chào mừng đến với InsightAI')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Ngôn ngữ'), { target: { value: 'en' } });
    expect(await screen.findByText('Welcome to InsightAI')).toBeInTheDocument();
  });

  it('toggles dark mode on the document root', () => {
    renderAt('/');
    const before = document.documentElement.classList.contains('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Đổi giao diện sáng/tối' }));
    expect(document.documentElement.classList.contains('dark')).toBe(!before);
  });

  it('shows dependency status, including a degraded (503) readiness response', async () => {
    mockHealth(503, {
      status: 'error',
      info: { database: { status: 'up' }, storage: { status: 'up' } },
      error: { redis: { status: 'down' } },
    });
    renderAt('/system');

    await waitFor(() => expect(screen.getAllByText('Hoạt động')).toHaveLength(2));
    expect(screen.getByText('Lỗi')).toBeInTheDocument();
  });

  it('reports an unreachable API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderAt('/system');
    expect(
      await screen.findByText('Không kết nối được tới API.', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  });
});
