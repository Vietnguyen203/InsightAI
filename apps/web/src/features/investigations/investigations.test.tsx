import type {
  AiStatus,
  DashboardDetail,
  DashboardSummary,
  Evidence,
  InvestigationDetail,
  InvestigationEvent,
  InvestigationReport,
  InvestigationSummary,
  SemanticModelSummary,
  SemanticQueryResult,
} from '@insightai/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { routes } from '@/app/router';
import i18n from '@/i18n';
import { getEventStream } from '@/lib/event-stream';
import { resetSessionForTests } from '@/lib/session';
import { json, mockApi, problem, signedInRoutes, USER_ID } from '@/test/mock-api';

const INV = '0190f5a0-0000-7000-8000-000000000101';
const EV1 = '0190f5a0-0000-7000-8000-000000000201';
const EV2 = '0190f5a0-0000-7000-8000-000000000202';
const F1 = '0190f5a0-0000-7000-8000-000000000301';
const F2 = '0190f5a0-0000-7000-8000-000000000302';
const DASH = '0190f5a0-0000-7000-8000-000000000401';
const DS = '0190f5a0-0000-7000-8000-000000000501';
const AT = '2026-11-06T00:00:00.000Z';

const model: SemanticModelSummary = {
  id: '0190f5a0-0000-7000-8000-0000000000a1',
  key: 'sales',
  name: 'Bán hàng',
  description: null,
  status: 'PUBLISHED',
  hasDraftChanges: false,
  validationStatus: 'VALID',
  revision: 1,
  publishedAt: AT,
  entityCount: 2,
  createdAt: AT,
  updatedAt: AT,
};
const aiOn: AiStatus = { enabled: true, remainingToday: 10, dailyLimit: 50 };

const summary = (extra: Partial<InvestigationSummary> = {}): InvestigationSummary => ({
  id: INV,
  model: 'sales',
  goal: 'Vì sao doanh thu tháng 10 tăng?',
  status: 'COMPLETED',
  errorCode: null,
  createdAt: AT,
  finishedAt: AT,
  ...extra,
});

const step = (stepKey: string, tool: string, purpose: string, status = 'SUCCEEDED') =>
  ({
    id: `0190f5a0-0000-7000-8000-00000000060${stepKey.slice(1)}`,
    stepKey,
    tool,
    purpose,
    status,
    attempt: 1,
    output: null,
    queryHistoryIds: [],
    errorCode: null,
    startedAt: AT,
    finishedAt: AT,
  }) as InvestigationDetail['steps'][number];

const detail = (extra: Partial<InvestigationDetail> = {}): InvestigationDetail => ({
  ...summary(),
  requireApproval: false,
  plan: {
    version: 1,
    goal: 'Explain the change',
    primaryMetric: 'paid_revenue',
    hypotheses: [
      {
        id: 'h1',
        statement: 'Miền Bắc dẫn dắt thay đổi',
        expectation: { kind: 'member_drives_change', stepId: 's2' },
      },
    ],
    steps: [],
  },
  pinned: { modelRevision: 1, metrics: { paid_revenue: 1 } },
  budget: { maxSteps: 12, maxQueries: 30, maxTokens: 60000, maxDurationMs: 300000 },
  usage: { steps: 2, queries: 6, tokens: 1200, durationMs: 900 },
  cancelRequested: false,
  errorMessage: null,
  steps: [
    step('s1', 'compare_periods', 'Thay đổi tổng thể'),
    step('s2', 'contribution', 'Vùng nào đóng góp'),
  ],
  hypotheses: [],
  findings: [],
  startedAt: AT,
  ...extra,
});

const byRegion: SemanticQueryResult = {
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
      key: 'paid_revenue',
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
    ['North', '5180'],
    ['South', '1560'],
  ],
  truncated: false,
  dateRange: { from: '2026-10-01', to: '2026-10-31' },
  compareRange: null,
  metrics: [{ key: 'paid_revenue', version: 1 }],
  modelRevision: 1,
  queryHistoryId: null,
  cached: false,
  policiesApplied: [],
};

const evidence = (id: string, stepKey: string, kind: string): Evidence => ({
  id,
  stepKey,
  kind,
  queries: [
    {
      model: 'sales',
      metrics: ['paid_revenue'],
      measures: [],
      dimensions: ['customer.region'],
      filters: [],
      orderBy: [],
      limit: 100,
    },
  ],
  queryHistoryIds: [],
  versions: {
    modelRevision: 1,
    metrics: [{ key: 'paid_revenue', version: 1 }],
    datasets: [{ id: DS, name: 'orders', versionNo: 2, qualityScore: 96.4 }],
  },
  policiesApplied: ['Chỉ miền Bắc'],
  results: [byRegion],
  values: {},
  limitations: ['POLICY_FILTERED'],
  createdAt: AT,
});

const report = (extra: Partial<InvestigationReport> = {}): InvestigationReport => ({
  investigationId: INV,
  lang: 'vi',
  renderer: 'llm',
  status: 'COMPLETED',
  goal: summary().goal,
  summary: {
    source: 'llm',
    segments: [
      { type: 'text', text: 'Doanh thu tăng ' },
      { type: 'value', text: '+1.820 VND', evidenceId: EV1, name: 'paid_revenue.delta' },
      { type: 'text', text: ', chủ yếu ở North.' },
    ],
  },
  findings: [
    {
      findingId: F1,
      kind: 'driver',
      templateKey: 'driver.same_direction',
      verified: true,
      importance: 0.8,
      evidenceIds: [EV2],
      text: {
        source: 'template',
        segments: [
          { type: 'value', text: 'North', evidenceId: EV2, name: 'member' },
          { type: 'text', text: ' đóng góp nhiều nhất.' },
        ],
      },
      chart: {
        evidenceId: EV2,
        resultIndex: 0,
        spec: { type: 'bar', x: 'customer.region', series: ['paid_revenue'] },
      },
      limitations: [],
    },
    {
      findingId: F2,
      kind: 'snapshot',
      templateKey: 'snapshot',
      verified: false,
      importance: 0.05,
      evidenceIds: [EV1],
      text: { source: 'template', segments: [{ type: 'text', text: 'Ảnh chụp chỉ số.' }] },
      chart: null,
      limitations: ['NO_DATA'],
    },
  ],
  hypotheses: [
    {
      key: 'h1',
      statement: 'Miền Bắc dẫn dắt thay đổi',
      status: 'SUPPORTED',
      label: 'Có bằng chứng ủng hộ (tương quan, không chứng minh nhân quả)',
      evidenceIds: [EV2],
    },
  ],
  recommendations: [
    {
      text: { source: 'llm', segments: [{ type: 'text', text: 'Rà soát kênh bán ở miền Bắc.' }] },
      findingIds: [F1],
    },
  ],
  limitations: [
    {
      code: 'DATA_QUALITY',
      text: 'Bộ dữ liệu “orders” (phiên bản 2): điểm chất lượng 96/100.',
      evidenceIds: [EV1],
    },
  ],
  createdAt: AT,
  ...extra,
});

/** An SSE response as the API streams it (`id:` + `data:` blocks). */
const sse = (events: InvestigationEvent[]) => () => {
  const text = events.map((e, i) => `id: ${i + 1}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
};

const finishedRoutes = (extra: Record<string, () => Response> = {}) => ({
  ...signedInRoutes('analyst'),
  [`GET /api/v1/investigations/${INV}`]: json(detail()),
  [`GET /api/v1/investigations/${INV}/report`]: json(report()),
  [`GET /api/v1/investigations/${INV}/evidence`]: json([
    evidence(EV1, 's1', 'compare_periods'),
    evidence(EV2, 's2', 'contribution'),
  ]),
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

describe('Investigations UI', () => {
  beforeEach(async () => {
    resetSessionForTests();
    localStorage.clear();
    await i18n.changeLanguage('vi');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists the user investigations with their status, from the main navigation', async () => {
    mockApi({
      ...signedInRoutes('analyst'),
      'GET /api/v1/investigations': json([
        summary(),
        summary({ id: EV1, goal: 'Lợi nhuận quý 3', status: 'FAILED' }),
      ]),
      'GET /api/v1/ai/status': json(aiOn),
      'GET /api/v1/semantic-models': json([model]),
    });
    renderAt('/investigations');
    expect(await screen.findByText('Vì sao doanh thu tháng 10 tăng?')).toBeInTheDocument();
    const failed = screen.getByText('Lợi nhuận quý 3').closest('a')!;
    expect(within(failed).getByText('Thất bại')).toBeInTheDocument();
    expect(failed).toHaveAttribute('href', `/investigations/${EV1}`);
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'Điều tra',
      }),
    ).toHaveAttribute('href', '/investigations');
  });

  it('starts an investigation and opens it', async () => {
    const { calls } = mockApi({
      ...finishedRoutes(),
      'GET /api/v1/investigations': json([]),
      'GET /api/v1/ai/status': json(aiOn),
      'GET /api/v1/semantic-models': json([model]),
      'POST /api/v1/investigations': json(detail({ status: 'QUEUED' }), 202),
      [`GET /api/v1/investigations/${INV}/events`]: sse([{ type: 'done', status: 'COMPLETED' }]),
    });
    const router = renderAt('/investigations');
    expect(await screen.findByText(/Chưa có cuộc điều tra nào/)).toBeInTheDocument();
    const start = screen.getByRole('button', { name: 'Bắt đầu điều tra' });
    fireEvent.change(screen.getByLabelText('Vấn đề cần điều tra'), {
      target: { value: 'Vì sao doanh thu giảm?' },
    });
    fireEvent.click(screen.getByLabelText('Cho tôi duyệt kế hoạch trước khi chạy'));
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/investigations/${INV}`));
    const body = JSON.parse(
      calls.find((c) => c.key === 'POST /api/v1/investigations')!.init!.body as string,
    ) as unknown;
    expect(body).toEqual({ model: 'sales', goal: 'Vì sao doanh thu giảm?', requireApproval: true });
  });

  it('cannot start when AI is disabled on the server', async () => {
    mockApi({
      ...signedInRoutes('analyst'),
      'GET /api/v1/investigations': json([]),
      'GET /api/v1/ai/status': json({ ...aiOn, enabled: false }),
      'GET /api/v1/semantic-models': json([model]),
    });
    renderAt('/investigations');
    expect(await screen.findByText('AI chưa được bật trên máy chủ này.')).toBeInTheDocument();
    expect(screen.getByLabelText('Vấn đề cần điều tra')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Bắt đầu điều tra' })).toBeDisabled();
  });

  it('follows a running investigation through its event stream, then shows the report', async () => {
    let gets = 0;
    const { calls } = mockApi({
      ...finishedRoutes(),
      [`GET /api/v1/investigations/${INV}`]: () => {
        gets += 1;
        return Response.json(
          gets === 1
            ? detail({
                status: 'RUNNING',
                steps: [
                  step('s1', 'compare_periods', 'Thay đổi tổng thể'),
                  step('s2', 'contribution', 'Vùng nào đóng góp', 'RUNNING'),
                ],
              })
            : detail(),
        );
      },
      [`GET /api/v1/investigations/${INV}/events`]: sse([
        { type: 'step_completed', stepKey: 's2' },
        { type: 'report_ready', renderer: 'llm' },
        { type: 'done', status: 'COMPLETED' },
      ]),
    });
    renderAt(`/investigations/${INV}`);
    expect(await screen.findByText('Đang chạy')).toBeInTheDocument();
    expect(screen.getByText(/Đã dùng 2\/12 bước, 6\/30 truy vấn/)).toBeInTheDocument();
    expect(await screen.findByText('Hoàn tất')).toBeInTheDocument();
    expect(await screen.findByRole('article', { name: 'Báo cáo' })).toBeInTheDocument();
    expect(calls.some((c) => c.key === `GET /api/v1/investigations/${INV}/events`)).toBe(true);
    expect(
      screen.getByText('Lời văn do AI viết, mọi số liệu lấy từ bằng chứng', { exact: false }),
    ).toBeInTheDocument();
  });

  it('waits for approval, then approves the plan', async () => {
    const { calls } = mockApi({
      ...signedInRoutes('analyst'),
      [`GET /api/v1/investigations/${INV}`]: json(
        detail({
          status: 'AWAITING_APPROVAL',
          steps: [step('s1', 'compare_periods', 'Thay đổi tổng thể', 'PENDING')],
        }),
      ),
      [`GET /api/v1/investigations/${INV}/events`]: sse([]),
      [`POST /api/v1/investigations/${INV}/approve`]: json(detail({ status: 'RUNNING' })),
    });
    renderAt(`/investigations/${INV}`);
    expect(
      await screen.findByText('Kế hoạch đã sẵn sàng – hãy xem và duyệt để chạy.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Miền Bắc dẫn dắt thay đổi')).toBeInTheDocument();
    expect(screen.getByText(/So sánh kỳ · Chờ chạy/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Duyệt và chạy' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === `POST /api/v1/investigations/${INV}/approve`)).toBe(true),
    );
  });

  it('renders the report: findings, hypotheses, suggestions and limitations', async () => {
    mockApi(finishedRoutes());
    renderAt(`/investigations/${INV}`);
    const article = await screen.findByRole('article', { name: 'Báo cáo' });
    expect(within(article).getByText('đóng góp nhiều nhất.', { exact: false })).toBeInTheDocument();
    expect(within(article).getByText('Chưa kiểm chứng')).toBeInTheDocument();
    expect(
      within(article).getByText('Có bằng chứng ủng hộ (tương quan, không chứng minh nhân quả)'),
    ).toBeInTheDocument();
    expect(within(article).getByText('Rà soát kênh bán ở miền Bắc.')).toBeInTheDocument();
    expect(within(article).getByText('Gợi ý')).toBeInTheDocument();
    expect(
      within(article).getByText('Bộ dữ liệu “orders” (phiên bản 2): điểm chất lượng 96/100.'),
    ).toBeInTheDocument();
  });

  it('opens the evidence behind a figure: versions, policies, quality and rows', async () => {
    mockApi(finishedRoutes());
    renderAt(`/investigations/${INV}`);
    fireEvent.click(await screen.findByRole('button', { name: '+1.820 VND' }));
    const panel = await screen.findByRole('region', { name: 'Bằng chứng' });
    expect(within(panel).getByText(/Thay đổi tổng thể · So sánh kỳ/)).toBeInTheDocument();
    expect(within(panel).getByText('Bản sửa đổi 1')).toBeInTheDocument();
    expect(within(panel).getByText('paid_revenue · v1')).toBeInTheDocument();
    expect(within(panel).getByText('orders · phiên bản 2 · chất lượng 96')).toBeInTheDocument();
    expect(within(panel).getByText('Chỉ miền Bắc')).toBeInTheDocument();
    expect(within(panel).getByText('POLICY_FILTERED')).toBeInTheDocument();
    expect(within(panel).getByRole('table')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Đóng' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Bằng chứng' })).toBeNull());
  });

  it('pins a finding to a dashboard with its evidence', async () => {
    const editable: DashboardSummary = {
      id: DASH,
      name: 'Doanh thu',
      description: null,
      visibility: 'PRIVATE',
      ownerId: USER_ID,
      ownerName: null,
      widgetCount: 0,
      canEdit: true,
      createdAt: AT,
      updatedAt: AT,
    };
    const { calls } = mockApi(
      finishedRoutes({
        'GET /api/v1/dashboards': json([editable]),
        [`POST /api/v1/dashboards/${DASH}/widgets`]: json(
          { ...editable, widgets: [] } satisfies DashboardDetail,
          201,
        ),
      }),
    );
    renderAt(`/investigations/${INV}`);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Ghim vào dashboard' }))[0]!);
    await screen.findByRole('option', { name: 'Doanh thu' });
    fireEvent.click(screen.getByRole('button', { name: 'Ghim' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === `POST /api/v1/dashboards/${DASH}/widgets`)).toBe(true),
    );
    const body = JSON.parse(
      calls.find((c) => c.key === `POST /api/v1/dashboards/${DASH}/widgets`)!.init!.body as string,
    ) as unknown;
    expect(body).toEqual({ fromEvidenceId: EV2 });
  });

  it('prints the report with the browser', async () => {
    mockApi(finishedRoutes());
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    renderAt(`/investigations/${INV}`);
    fireEvent.click(await screen.findByRole('button', { name: 'In / PDF' }));
    expect(print).toHaveBeenCalled();
  });

  it('explains why a run failed, without a report', async () => {
    const { calls } = mockApi({
      ...signedInRoutes('analyst'),
      [`GET /api/v1/investigations/${INV}`]: json(
        detail({ status: 'FAILED', errorCode: 'MODEL_CHANGED', steps: [] }),
      ),
    });
    renderAt(`/investigations/${INV}`);
    expect(await screen.findByText(/đổi phiên bản trong lúc chạy/)).toBeInTheDocument();
    expect(calls.some((c) => c.key.endsWith('/report'))).toBe(false);
  });

  it('shows the error of a report that is not available', async () => {
    mockApi(
      finishedRoutes({
        [`GET /api/v1/investigations/${INV}/report`]: problem(409, 'CONFLICT'),
      }),
    );
    renderAt(`/investigations/${INV}`);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('getEventStream', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resumes after Last-Event-ID and reports the id of each event', async () => {
    const { calls } = mockApi({
      'GET /api/v1/x/events': sse([
        { type: 'status', status: 'RUNNING' },
        { type: 'done', status: 'COMPLETED' },
      ]),
    });
    const seen: [unknown, string | null][] = [];
    await getEventStream('/api/v1/x/events', (data, id) => seen.push([data, id]), {
      lastEventId: '41',
    });
    expect(seen).toEqual([
      [{ type: 'status', status: 'RUNNING' }, '1'],
      [{ type: 'done', status: 'COMPLETED' }, '2'],
    ]);
    expect(new Headers(calls[0]!.init!.headers).get('Last-Event-ID')).toBe('41');
  });
});
