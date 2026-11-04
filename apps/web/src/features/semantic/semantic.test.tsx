import type {
  Catalog,
  Metric,
  MetricDetail,
  QueryColumn,
  SemanticModelDetail,
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
import { resetSessionForTests } from '@/lib/session';
import { json, mockApi, problem, signedInRoutes } from '@/test/mock-api';

const MODEL_ID = '0190f5a0-0000-7000-8000-0000000000a1';
const ENTITY_ID = '0190f5a0-0000-7000-8000-0000000000a2';
const METRIC_ID = '0190f5a0-0000-7000-8000-0000000000a3';
const CREATED = '2026-11-03T00:00:00.000Z';

const summary: SemanticModelSummary = {
  id: MODEL_ID,
  key: 'sales',
  name: 'Bán hàng',
  description: null,
  status: 'PUBLISHED',
  hasDraftChanges: false,
  validationStatus: 'VALID',
  revision: 2,
  publishedAt: CREATED,
  entityCount: 1,
  createdAt: CREATED,
  updatedAt: CREATED,
};

const model = (extra: Partial<SemanticModelDetail> = {}): SemanticModelDetail => ({
  ...summary,
  entities: [
    {
      id: ENTITY_ID,
      key: 'order',
      name: 'Đơn hàng',
      description: null,
      datasetId: '0190f5a0-0000-7000-8000-0000000000d1',
      datasetName: 'orders',
      primaryKey: ['order_id'],
      dimensions: [
        {
          id: '0190f5a0-0000-7000-8000-0000000000b1',
          key: 'order_date',
          name: 'Ngày đặt',
          description: null,
          type: 'TIME',
          expr: 'created_at',
          granularities: ['day', 'month'],
          hidden: false,
        },
        {
          id: '0190f5a0-0000-7000-8000-0000000000b2',
          key: 'status',
          name: 'Trạng thái',
          description: null,
          type: 'CATEGORICAL',
          expr: 'status',
          granularities: [],
          hidden: false,
        },
      ],
      measures: [
        {
          id: '0190f5a0-0000-7000-8000-0000000000b3',
          key: 'revenue',
          name: 'Doanh thu',
          description: null,
          agg: 'sum',
          expr: 'amount',
        },
      ],
    },
  ],
  relationships: [],
  validationReport: null,
  ...extra,
});

const version = {
  id: '0190f5a0-0000-7000-8000-0000000000c1',
  versionNo: 1,
  status: 'PUBLISHED' as const,
  label: 'Doanh thu',
  businessDefinition: 'Tổng giá trị đơn đã thanh toán.',
  unit: 'VND',
  format: 'currency' as const,
  definition: {
    type: 'SIMPLE' as const,
    measure: 'order.revenue',
    filters: [],
    timeDimension: 'order.order_date',
  },
  publishedAt: CREATED,
  createdAt: CREATED,
};
const metric: Metric = {
  id: METRIC_ID,
  semanticModelId: MODEL_ID,
  key: 'revenue',
  status: 'ACTIVE',
  published: version,
  draft: null,
  synonyms: [],
  createdAt: CREATED,
};
const catalog: Catalog = {
  model: { key: 'sales', name: 'Bán hàng', revision: 2 },
  metrics: [
    {
      key: 'revenue',
      label: 'Doanh thu',
      businessDefinition: null,
      unit: 'VND',
      format: 'currency',
      type: 'SIMPLE',
      version: 1,
      timeDimension: 'order.order_date',
      synonyms: [],
    },
  ],
  dimensions: [
    {
      key: 'order.status',
      name: 'Trạng thái',
      description: null,
      type: 'CATEGORICAL',
      granularities: [],
      synonyms: [],
    },
  ],
};
const column = (
  key: string,
  extra: Partial<QueryColumn> & Pick<QueryColumn, 'kind' | 'type'>,
): QueryColumn => ({
  key,
  name: key,
  granularity: null,
  comparison: false,
  unit: null,
  format: null,
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

describe('Semantic layer UI', () => {
  beforeEach(async () => {
    resetSessionForTests();
    localStorage.clear();
    await i18n.changeLanguage('vi');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists models and creates one', async () => {
    const { calls } = mockApi({
      ...signedInRoutes('analyst'),
      'GET /api/v1/semantic-models': json([summary]),
      'POST /api/v1/semantic-models': json(model({ id: MODEL_ID }), 201),
      [`GET /api/v1/semantic-models/${MODEL_ID}`]: json(model()),
    });
    const router = renderAt('/semantic');
    expect(await screen.findByText('Bán hàng')).toBeInTheDocument();
    expect(screen.getByText('Đã publish · r2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Tạo mô hình' }));
    fireEvent.change(screen.getByLabelText('Tên'), { target: { value: 'Kho' } });
    fireEvent.change(screen.getByLabelText('Khóa'), { target: { value: 'Bad Key' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Tạo mô hình' }).at(-1)!);
    expect(
      await screen.findByText('Khóa chỉ gồm chữ thường, số và _, bắt đầu bằng chữ.'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Khóa'), { target: { value: 'kho' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Tạo mô hình' }).at(-1)!);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/semantic/${MODEL_ID}`));
    expect(bodyOf(calls, 'POST /api/v1/semantic-models')).toEqual({
      name: 'Kho',
      key: 'kho',
      description: '',
    });
  });

  it('shows the validation report and explains a refused publish', async () => {
    const draft = model({
      hasDraftChanges: true,
      validationStatus: 'INVALID',
      validationReport: {
        status: 'INVALID',
        checkedAt: CREATED,
        issues: [{ severity: 'error', code: 'PRIMARY_KEY_DUPLICATE', message: 'x', path: 'order' }],
      },
    });
    mockApi({
      ...signedInRoutes('owner'),
      [`GET /api/v1/semantic-models/${MODEL_ID}`]: json(draft),
      [`POST /api/v1/semantic-models/${MODEL_ID}/publish`]: problem(409, 'CONFLICT'),
    });
    renderAt(`/semantic/${MODEL_ID}`);
    expect(await screen.findByText('Khóa chính bị trùng.')).toBeInTheDocument();
    expect(screen.getByText('Đơn hàng')).toBeInTheDocument();
    expect(screen.getByText('order.revenue')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(/Chưa publish được/)).toBeInTheDocument();
  });

  it('creates a simple metric with a condition', async () => {
    const created: MetricDetail = { ...metric, key: 'paid_revenue', versions: [] };
    const { calls } = mockApi({
      ...signedInRoutes('analyst'),
      [`GET /api/v1/semantic-models/${MODEL_ID}`]: json(model()),
      [`GET /api/v1/semantic-models/${MODEL_ID}/metrics`]: json([metric]),
      [`POST /api/v1/semantic-models/${MODEL_ID}/metrics`]: json(created, 201),
      [`GET /api/v1/metrics/${METRIC_ID}`]: json({ ...metric, versions: [version] }),
      [`GET /api/v1/semantic-models/${MODEL_ID}/synonyms`]: json([]),
    });
    renderAt(`/semantic/${MODEL_ID}?tab=metrics`);

    fireEvent.click(await screen.findByRole('button', { name: 'Thêm metric' }));
    const form = screen.getByRole('form', { name: 'Tạo metric (bản nháp)' });
    fireEvent.change(within(form).getByLabelText('Khóa'), { target: { value: 'paid_revenue' } });
    fireEvent.change(within(form).getByLabelText('Tên hiển thị'), {
      target: { value: 'Doanh thu đã thu' },
    });
    fireEvent.change(within(form).getByLabelText('Measure'), {
      target: { value: 'order.revenue' },
    });
    fireEvent.change(within(form).getByLabelText('Dimension thời gian mặc định'), {
      target: { value: 'order.order_date' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Thêm điều kiện' }));
    fireEvent.change(within(form).getByLabelText('Dimension'), {
      target: { value: 'order.status' },
    });
    fireEvent.change(within(form).getByLabelText('Giá trị'), { target: { value: 'PAID' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Tạo metric (bản nháp)' }));

    await waitFor(() =>
      expect(calls.some((c) => c.key === `POST /api/v1/semantic-models/${MODEL_ID}/metrics`)).toBe(
        true,
      ),
    );
    expect(bodyOf(calls, `POST /api/v1/semantic-models/${MODEL_ID}/metrics`)).toEqual({
      key: 'paid_revenue',
      label: 'Doanh thu đã thu',
      businessDefinition: null,
      unit: null,
      format: 'number',
      definition: {
        type: 'SIMPLE',
        measure: 'order.revenue',
        filters: [{ member: 'order.status', op: 'eq', values: ['PAID'] }],
        timeDimension: 'order.order_date',
      },
    });
  });

  it('runs a test query and explains rejections', async () => {
    let runs = 0;
    const result: SemanticQueryResult = {
      columns: [
        column('order.status', { kind: 'dimension', type: 'TEXT' }),
        column('revenue', { kind: 'metric', type: 'DECIMAL', unit: 'VND', format: 'currency' }),
      ],
      rows: [['PAID', '1234.5']],
      truncated: false,
      dateRange: null,
      compareRange: null,
      metrics: [{ key: 'revenue', version: 1 }],
      modelRevision: 2,
      cached: false,
      policiesApplied: [],
    };
    mockApi({
      ...signedInRoutes('viewer'),
      [`GET /api/v1/semantic-models/${MODEL_ID}`]: json(model()),
      'GET /api/v1/catalog': json(catalog),
      'POST /api/v1/semantic-query': () => {
        runs += 1;
        return runs === 1
          ? Response.json(result)
          : Response.json(
              {
                type: 'about:blank',
                title: 'x',
                status: 422,
                code: 'QUERY_REJECTED',
                errors: [{ path: 'reason.FANOUT_JOIN', message: 'x' }],
              },
              { status: 422, headers: { 'content-type': 'application/problem+json' } },
            );
      },
    });
    renderAt(`/semantic/${MODEL_ID}?tab=query`);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Doanh thu/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Trạng thái/ }));
    // Viewers run queries but do not see the SQL.
    expect(screen.queryByRole('button', { name: 'Xem SQL' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Chạy' }));
    expect(await screen.findByText('1.234,5 VND')).toBeInTheDocument();
    expect(screen.getByText('revenue v1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Chạy' }));
    expect(await screen.findByText(/sẽ làm đếm trùng/)).toBeInTheDocument();
  });

  it('shows KPI cards with the change against the previous period', async () => {
    mockApi({
      ...signedInRoutes('viewer'),
      [`GET /api/v1/semantic-models/${MODEL_ID}`]: json(model()),
      'GET /api/v1/catalog': json(catalog),
      'POST /api/v1/semantic-query': json({
        columns: [
          column('revenue', { kind: 'metric', type: 'DECIMAL', unit: 'VND', format: 'currency' }),
          column('revenue', {
            kind: 'metric',
            type: 'DECIMAL',
            unit: 'VND',
            format: 'currency',
            comparison: true,
          }),
        ],
        rows: [['1500', '1000']],
        truncated: false,
        dateRange: { from: '2026-11-01', to: '2026-11-04' },
        compareRange: { from: '2026-10-28', to: '2026-10-31' },
        metrics: [{ key: 'revenue', version: 1 }],
        modelRevision: 2,
        cached: false,
        policiesApplied: [],
      }),
    });
    renderAt(`/semantic/${MODEL_ID}?tab=kpi`);
    const card = await screen.findByRole('listitem', { name: 'Doanh thu' });
    expect(await within(card).findByText('1.500 VND')).toBeInTheDocument();
    expect(within(card).getByText('50%')).toBeInTheDocument();
    expect(within(card).getByText('kỳ trước 1.000 VND')).toBeInTheDocument();
  });

  it('hides editing from viewers', async () => {
    mockApi({
      ...signedInRoutes('viewer'),
      [`GET /api/v1/semantic-models/${MODEL_ID}`]: json(model()),
    });
    renderAt(`/semantic/${MODEL_ID}`);
    expect(await screen.findByText('Đơn hàng')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kiểm tra' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thêm entity' })).not.toBeInTheDocument();
  });
});
