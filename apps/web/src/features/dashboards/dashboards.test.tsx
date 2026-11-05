import type {
  Answer,
  ConversationDetail,
  DashboardDetail,
  DashboardSummary,
  DashboardWidget,
  SemanticQueryResult,
} from '@insightai/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { routes } from '@/app/router';
import i18n from '@/i18n';
import { resetSessionForTests } from '@/lib/session';
import { json, mockApi, signedInRoutes, USER_ID } from '@/test/mock-api';
import { applyMove } from './layout';

const DASH = '0190f5a0-0000-7000-8000-0000000000d1';
const W1 = '0190f5a0-0000-7000-8000-0000000000e1';
const W2 = '0190f5a0-0000-7000-8000-0000000000e2';
const OTHER_USER = '0190f5a0-0000-7000-8000-0000000000cc';
const CONV = '0190f5a0-0000-7000-8000-0000000000f1';
const MSG = '0190f5a0-0000-7000-8000-0000000000f3';
const AT = '2026-11-05T00:00:00.000Z';

const summary = (extra: Partial<DashboardSummary> = {}): DashboardSummary => ({
  id: DASH,
  name: 'Doanh thu tuần',
  description: null,
  visibility: 'PRIVATE',
  ownerId: USER_ID,
  ownerName: 'Nguyễn Lan',
  widgetCount: 2,
  canEdit: true,
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

const widget = (id: string, extra: Partial<DashboardWidget> = {}): DashboardWidget => ({
  id,
  dashboardId: DASH,
  title: 'Theo vùng',
  query: {
    model: 'sales',
    metrics: ['revenue'],
    measures: [],
    dimensions: ['customer.region'],
    filters: [],
    orderBy: [],
    limit: 100,
  },
  chart: { type: 'bar', x: 'customer.region', series: ['revenue'] },
  position: { x: 0, y: 0, w: 6, h: 4 },
  sourceMessageId: null,
  savedModelRevision: 1,
  savedMetricVersions: [{ key: 'revenue', version: 1 }],
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

const detail = (extra: Partial<DashboardDetail> = {}): DashboardDetail => ({
  ...summary(),
  widgets: [
    widget(W1),
    widget(W2, {
      title: 'Tổng',
      chart: { type: 'kpi', x: null, series: ['revenue'] },
      position: { x: 6, y: 0, w: 6, h: 4 },
    }),
  ],
  ...extra,
});

const result = (version = 1, extra: Partial<SemanticQueryResult> = {}): SemanticQueryResult => ({
  columns: [
    {
      key: 'customer.region',
      name: 'Vùng',
      kind: 'dimension',
      type: 'TEXT',
      granularity: null,
      comparison: false,
      unit: null,
      format: null,
    },
    {
      key: 'revenue',
      name: 'Doanh thu',
      kind: 'metric',
      type: 'DECIMAL',
      granularity: null,
      comparison: false,
      unit: 'VND',
      format: 'currency',
    },
  ],
  rows: [
    ['North', '100'],
    ['South', '200'],
  ],
  truncated: false,
  dateRange: null,
  compareRange: null,
  metrics: [{ key: 'revenue', version }],
  modelRevision: 1,
  queryHistoryId: null,
  cached: false,
  policiesApplied: [],
  ...extra,
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const bodyOf = (calls: { key: string; init: RequestInit | undefined }[], key: string) =>
  JSON.parse(calls.find((c) => c.key === key)?.init?.body as string) as unknown;

describe('Dashboards UI', () => {
  beforeEach(async () => {
    resetSessionForTests();
    localStorage.clear();
    await i18n.changeLanguage('vi');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists dashboards and creates a private one', async () => {
    const { calls } = mockApi({
      ...signedInRoutes('analyst'),
      'GET /api/v1/dashboards': json([summary({ visibility: 'ORG', name: 'Chung' })]),
      'POST /api/v1/dashboards': json(detail({ widgets: [], widgetCount: 0 }), 201),
      [`GET /api/v1/dashboards/${DASH}`]: json(detail({ widgets: [], widgetCount: 0 })),
    });
    const router = renderAt('/dashboards');
    const card = await screen.findByRole('link', { name: /Chung/ });
    expect(within(card).getByText('Cả tổ chức')).toBeInTheDocument();
    expect(within(card).getByText('2 widget')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Tạo dashboard' }));
    fireEvent.change(screen.getByLabelText('Tên dashboard'), { target: { value: 'Mới' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Tạo dashboard' }).at(-1)!);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/dashboards/${DASH}`));
    expect(bodyOf(calls, 'POST /api/v1/dashboards')).toEqual({
      name: 'Mới',
      visibility: 'PRIVATE',
    });
    expect(await screen.findByText(/Dashboard trống/)).toBeInTheDocument();
  });

  it('is read-only for viewers', async () => {
    mockApi({ ...signedInRoutes('viewer'), 'GET /api/v1/dashboards': json([]) });
    renderAt('/dashboards');
    expect(
      await screen.findByText('Chưa có dashboard nào được chia sẻ với tổ chức.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tạo dashboard' })).not.toBeInTheDocument();
  });

  it('runs every widget as the viewer and flags changed definitions', async () => {
    mockApi({
      ...signedInRoutes('viewer'),
      [`GET /api/v1/dashboards/${DASH}`]: json(
        detail({ canEdit: false, visibility: 'ORG', ownerId: OTHER_USER }),
      ),
      [`POST /api/v1/dashboard-widgets/${W1}/run`]: json(
        result(2, { policiesApplied: ['Viewers see the North'] }),
      ),
      [`POST /api/v1/dashboard-widgets/${W2}/run`]: json(result(1)),
    });
    renderAt(`/dashboards/${DASH}`);
    const bar = await screen.findByRole('article', { name: 'Theo vùng' });
    expect(
      await within(bar).findByRole('img', { name: /Biểu đồ Doanh thu theo Vùng/ }),
    ).toBeInTheDocument();
    expect(within(bar).getByText('Định nghĩa đã đổi (v1 → v2)')).toBeInTheDocument();
    expect(within(bar).getByText(/đã được lọc theo quyền truy cập/)).toBeInTheDocument();
    const kpi = screen.getByRole('article', { name: 'Tổng' });
    expect(within(kpi).queryByText(/Định nghĩa đã đổi/)).not.toBeInTheDocument();
    expect(screen.getByText(/Chỉ xem/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chỉnh bố cục' })).not.toBeInTheDocument();
  });

  it('explains widgets that can no longer run', async () => {
    mockApi({
      ...signedInRoutes('analyst'),
      [`GET /api/v1/dashboards/${DASH}`]: json(detail()),
      [`POST /api/v1/dashboard-widgets/${W1}/run`]: () =>
        Response.json(
          {
            type: 'about:blank',
            title: 'Rejected',
            status: 422,
            code: 'QUERY_REJECTED',
            errors: [{ path: 'reason.DATA_UNAVAILABLE', message: 'gone' }],
          },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      [`POST /api/v1/dashboard-widgets/${W2}/run`]: () =>
        Response.json(
          {
            type: 'about:blank',
            title: 'Rejected',
            status: 422,
            code: 'QUERY_REJECTED',
            errors: [{ path: 'reason.UNKNOWN_METRIC', message: 'x' }],
          },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    renderAt(`/dashboards/${DASH}`);
    const first = await screen.findByRole('article', { name: 'Theo vùng' });
    expect(await within(first).findByText('Widget cần cập nhật')).toBeInTheDocument();
    const second = screen.getByRole('article', { name: 'Tổng' });
    expect(await within(second).findByText(/không khả dụng với bạn/)).toBeInTheDocument();
  });

  it('moves and resizes widgets without overlaps in edit mode', async () => {
    const { calls } = mockApi({
      ...signedInRoutes('analyst'),
      [`GET /api/v1/dashboards/${DASH}`]: json(detail()),
      [`POST /api/v1/dashboard-widgets/${W1}/run`]: json(result()),
      [`POST /api/v1/dashboard-widgets/${W2}/run`]: json(result()),
      [`PUT /api/v1/dashboards/${DASH}/layout`]: json(
        detail({
          widgets: [widget(W1, { position: { x: 0, y: 0, w: 6, h: 5 } }), detail().widgets[1]!],
        }),
      ),
    });
    renderAt(`/dashboards/${DASH}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Chỉnh bố cục' }));
    const controls = screen.getByRole('contentinfo', { name: 'Điều chỉnh widget Theo vùng' });
    // Wider would cover the KPI widget on its right: not sent.
    fireEvent.click(within(controls).getByRole('button', { name: 'Rộng ra' }));
    expect(calls.some((c) => c.key.startsWith('PUT'))).toBe(false);
    fireEvent.click(within(controls).getByRole('button', { name: 'Cao lên' }));
    await waitFor(() =>
      expect(bodyOf(calls, `PUT /api/v1/dashboards/${DASH}/layout`)).toEqual({
        widgets: [{ id: W1, position: { x: 0, y: 0, w: 6, h: 5 } }],
      }),
    );
  });

  it('lets only the owner change who sees the dashboard', async () => {
    const { calls } = mockApi({
      ...signedInRoutes('analyst'),
      [`GET /api/v1/dashboards/${DASH}`]: json(detail({ widgets: [] })),
      [`PATCH /api/v1/dashboards/${DASH}`]: json(detail({ widgets: [], visibility: 'ORG' })),
    });
    renderAt(`/dashboards/${DASH}`);
    fireEvent.change(await screen.findByLabelText('Ai được xem'), { target: { value: 'ORG' } });
    await waitFor(() =>
      expect(bodyOf(calls, `PATCH /api/v1/dashboards/${DASH}`)).toEqual({ visibility: 'ORG' }),
    );
  });

  it('hides sharing from admins editing someone else’s dashboard', async () => {
    mockApi({
      ...signedInRoutes('admin'),
      [`GET /api/v1/dashboards/${DASH}`]: json(
        detail({ widgets: [], visibility: 'ORG', ownerId: OTHER_USER, canEdit: true }),
      ),
    });
    renderAt(`/dashboards/${DASH}`);
    expect(await screen.findByRole('button', { name: 'Đổi tên dashboard' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Ai được xem')).not.toBeInTheDocument();
  });

  it('pins an AI answer to an existing or a new dashboard', async () => {
    const answer: Answer = {
      status: 'ANSWERED',
      narrative: 'South dẫn đầu.',
      query: detail().widgets[0]!.query,
      result: result(),
      chart: { type: 'bar', x: 'customer.region', series: ['revenue'] },
      clarification: null,
      provenance: null,
    };
    const conversation: ConversationDetail = {
      id: CONV,
      title: 'Doanh thu theo vùng?',
      model: 'sales',
      lastMessageAt: AT,
      createdAt: AT,
      messages: [{ id: MSG, role: 'ASSISTANT', content: 'South dẫn đầu.', answer, createdAt: AT }],
    };
    const { calls } = mockApi({
      ...signedInRoutes('analyst'),
      'GET /api/v1/ai/status': json({ enabled: true, dailyLimit: 200, remainingToday: 200 }),
      'GET /api/v1/semantic-models': json([]),
      'GET /api/v1/ai/conversations': json([]),
      [`GET /api/v1/ai/conversations/${CONV}`]: json(conversation),
      'GET /api/v1/dashboards': json([
        summary({ name: 'Không sửa được', canEdit: false, id: OTHER_USER }),
        summary(),
      ]),
      [`POST /api/v1/dashboards/${DASH}/widgets`]: json(detail(), 201),
      'POST /api/v1/dashboards': json(detail({ name: 'Mới', widgets: [] }), 201),
    });
    renderAt(`/ask/${CONV}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Ghim vào dashboard' }));
    const select = await screen.findByLabelText('Dashboard');
    await waitFor(() => expect(select).toHaveValue(DASH));
    expect(within(select).queryByText('Không sửa được')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ghim' }));
    expect(await screen.findByRole('link', { name: 'Doanh thu tuần' })).toBeInTheDocument();
    expect(bodyOf(calls, `POST /api/v1/dashboards/${DASH}/widgets`)).toEqual({
      fromMessageId: MSG,
    });
  });

  it('keeps a widget inside the grid and away from others', () => {
    const positions = new Map([
      [W1, { x: 0, y: 0, w: 6, h: 4 }],
      [W2, { x: 6, y: 0, w: 6, h: 4 }],
    ]);
    expect(applyMove(positions, W1, 'left')).toBeNull();
    expect(applyMove(positions, W1, 'right')).toBeNull();
    expect(applyMove(positions, W2, 'wider')).toBeNull();
    expect(applyMove(positions, W1, 'down')).toEqual({ x: 0, y: 1, w: 6, h: 4 });
    expect(applyMove(positions, W1, 'narrower')).toEqual({ x: 0, y: 0, w: 5, h: 4 });
  });
});
