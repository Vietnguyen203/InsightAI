import type {
  AiStatus,
  Answer,
  AskEvent,
  Catalog,
  ConversationDetail,
  SemanticModelSummary,
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

const CONV_ID = '0190f5a0-0000-7000-8000-00000000c001';
const MSG = (n: number) => `0190f5a0-0000-7000-8000-00000000d00${n}`;
const HISTORY_ID = '0190f5a0-0000-7000-8000-00000000e001';
const DATASET_ID = '0190f5a0-0000-7000-8000-00000000f001';
const CREATED = '2026-11-05T00:00:00.000Z';

const status = (extra: Partial<AiStatus> = {}): AiStatus => ({
  enabled: true,
  dailyLimit: 200,
  remainingToday: 199,
  provider: 'api.openai.com',
  ...extra,
});

const modelSummary: SemanticModelSummary = {
  id: '0190f5a0-0000-7000-8000-0000000000a1',
  key: 'sales',
  name: 'Bán hàng',
  description: null,
  status: 'PUBLISHED',
  hasDraftChanges: false,
  validationStatus: 'VALID',
  revision: 2,
  publishedAt: CREATED,
  entityCount: 2,
  createdAt: CREATED,
  updatedAt: CREATED,
};

const catalog: Catalog = {
  model: { key: 'sales', name: 'Bán hàng', revision: 2 },
  metrics: [
    {
      key: 'paid_revenue',
      label: 'Doanh thu',
      businessDefinition: null,
      unit: 'VND',
      format: 'currency',
      type: 'SIMPLE',
      version: 3,
      timeDimension: 'order.order_date',
      synonyms: [],
      additive: true,
      ratio: null,
    },
  ],
  dimensions: [],
};

const answer: Answer = {
  status: 'ANSWERED',
  narrative: 'South dẫn đầu với 200 VND.',
  query: {
    model: 'sales',
    metrics: ['paid_revenue'],
    measures: [],
    dimensions: ['customer.region'],
    filters: [],
    orderBy: [],
    limit: 50,
  },
  result: {
    columns: [
      {
        key: 'customer.region',
        name: 'Khu vực',
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
      ['South', '200'],
      ['North', '100'],
    ],
    truncated: false,
    dateRange: null,
    compareRange: null,
    metrics: [{ key: 'paid_revenue', version: 3 }],
    modelRevision: 2,
    queryHistoryId: HISTORY_ID,
    cached: false,
    policiesApplied: [],
  },
  chart: { type: 'bar', x: 'customer.region', series: ['paid_revenue'] },
  clarification: null,
  provenance: {
    interpretedAs: 'Doanh thu · theo Khu vực · toàn bộ thời gian',
    queryHistoryId: HISTORY_ID,
    modelRevision: 2,
    metrics: [{ key: 'paid_revenue', version: 3, label: 'Doanh thu' }],
    datasets: [{ id: DATASET_ID, name: 'orders', versionNo: 2, qualityScore: 96.4 }],
    policiesApplied: [],
  },
};

const clarification: Answer = {
  status: 'CLARIFICATION',
  narrative: null,
  query: null,
  result: null,
  chart: null,
  clarification: { question: 'Bạn muốn xem khu vực nào?', options: ['North', 'South'] },
  provenance: null,
};

const detail = (turns: [string, Answer][]): ConversationDetail => ({
  id: CONV_ID,
  title: turns[0]?.[0] ?? '',
  model: 'sales',
  lastMessageAt: CREATED,
  createdAt: CREATED,
  messages: turns.flatMap(([q, a], i) => [
    { id: MSG(i * 2), role: 'USER' as const, content: q, answer: null, createdAt: CREATED },
    {
      id: MSG(i * 2 + 1),
      role: 'ASSISTANT' as const,
      content: a.narrative ?? '',
      answer: a,
      createdAt: CREATED,
    },
  ]),
});

/** An SSE response as the API streams it (split mid-event to exercise buffering). */
const sse = (events: AskEvent[]) => () => {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const half = Math.floor(text.length / 2);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text.slice(0, half)));
      controller.enqueue(encoder.encode(text.slice(half)));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
};

const answered = (a: Answer): AskEvent[] => [
  { type: 'conversation', conversationId: CONV_ID },
  { type: 'stage', stage: 'understanding' },
  { type: 'stage', stage: 'executing' },
  { type: 'result', answer: a },
  { type: 'done', messageId: MSG(1) },
];

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const baseRoutes = (role: 'owner' | 'analyst' | 'viewer' = 'analyst', s = status()) => ({
  ...signedInRoutes(role),
  'GET /api/v1/ai/status': json(s),
  'GET /api/v1/semantic-models': json([modelSummary]),
  'GET /api/v1/catalog': json(catalog),
  'GET /api/v1/ai/conversations': json([]),
});

const askBody = (calls: { key: string; init: RequestInit | undefined }[], n = 0) =>
  JSON.parse(
    calls.filter((c) => c.key === 'POST /api/v1/ai/ask')[n]?.init?.body as string,
  ) as unknown;

const typeAndSend = (text: string) => {
  fireEvent.change(screen.getByLabelText('Câu hỏi'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Gửi câu hỏi' }));
};

describe('Ask AI page', () => {
  beforeEach(async () => {
    resetSessionForTests();
    localStorage.clear();
    await i18n.changeLanguage('vi');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks a question, streams the answer and shows chart, data and sources', async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      'POST /api/v1/ai/ask': sse(answered(answer)),
      [`GET /api/v1/ai/conversations/${CONV_ID}`]: json(
        detail([['Doanh thu theo khu vực?', answer]]),
      ),
    });
    const router = renderAt('/ask');
    expect(await screen.findByText('Còn 199/200 câu hỏi hôm nay')).toBeInTheDocument();
    // Suggestions come from the catalog.
    expect(
      await screen.findByRole('button', { name: 'Doanh thu tháng này so với tháng trước?' }),
    ).toBeInTheDocument();

    typeAndSend('Doanh thu theo khu vực?');
    expect(await screen.findByText('South dẫn đầu với 200 VND.')).toBeInTheDocument();
    expect(askBody(calls)).toEqual({ model: 'sales', question: 'Doanh thu theo khu vực?' });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/ask/${CONV_ID}`));

    expect(screen.getByText('Doanh thu · theo Khu vực · toàn bộ thời gian')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Biểu đồ Doanh thu theo Khu vực' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Bảng dữ liệu \(2 dòng\)/ }));
    expect(screen.getByRole('cell', { name: '200 VND' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Nguồn & độ tin cậy/ }));
    expect(screen.getByText('Doanh thu · v3')).toBeInTheDocument();
    expect(screen.getByText(/chất lượng 96\/100/)).toBeInTheDocument();
  });

  it('answers a clarification option as a follow-up in the same conversation', async () => {
    let turns: [string, Answer][] = [['Doanh thu khu vực đó?', clarification]];
    const { calls } = mockApi({
      ...baseRoutes(),
      'GET /api/v1/ai/conversations': json([
        {
          id: CONV_ID,
          title: 'Doanh thu khu vực đó?',
          model: 'sales',
          lastMessageAt: CREATED,
          createdAt: CREATED,
        },
      ]),
      [`GET /api/v1/ai/conversations/${CONV_ID}`]: () => Response.json(detail(turns)),
      'POST /api/v1/ai/ask': () => {
        turns = [...turns, ['South', answer]];
        return sse(answered(answer))();
      },
    });
    renderAt(`/ask/${CONV_ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'South' }));
    expect(await screen.findByText('South dẫn đầu với 200 VND.')).toBeInTheDocument();
    expect(askBody(calls)).toEqual({ conversationId: CONV_ID, question: 'South' });
    expect(
      within(screen.getByRole('complementary', { name: 'Lịch sử hội thoại' })).getByRole('link', {
        current: 'page',
      }),
    ).toHaveTextContent('Doanh thu khu vực đó?');
  });

  it('explains when AI is not configured', async () => {
    mockApi(baseRoutes('analyst', status({ enabled: false })));
    renderAt('/ask');
    expect(
      await screen.findByText(/Tính năng AI chưa được cấu hình trên máy chủ/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Câu hỏi')).toBeDisabled();
  });

  it('shows the quota error and keeps the question', async () => {
    mockApi({ ...baseRoutes(), 'POST /api/v1/ai/ask': problem(429, 'RATE_LIMITED') });
    renderAt('/ask');
    await screen.findByText('Còn 199/200 câu hỏi hôm nay');
    typeAndSend('Doanh thu?');
    expect(
      await screen.findByText(
        'Tổ chức đã dùng hết số câu hỏi AI hôm nay. Vui lòng thử lại vào ngày mai.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Câu hỏi')).toHaveValue('Doanh thu?');
  });

  it('shows a provider error streamed during the answer', async () => {
    mockApi({
      ...baseRoutes(),
      'POST /api/v1/ai/ask': sse([
        { type: 'conversation', conversationId: CONV_ID },
        { type: 'stage', stage: 'understanding' },
        { type: 'error', code: 'AI_PROVIDER_ERROR', message: 'x' },
        { type: 'done', messageId: MSG(1) },
      ]),
      [`GET /api/v1/ai/conversations/${CONV_ID}`]: json({
        ...detail([]),
        messages: [
          { id: MSG(0), role: 'USER', content: 'Doanh thu?', answer: null, createdAt: CREATED },
          {
            id: MSG(1),
            role: 'ASSISTANT',
            content: '',
            answer: { ...clarification, status: 'ERROR', clarification: null },
            createdAt: CREATED,
          },
        ],
      }),
    });
    renderAt('/ask');
    await screen.findByText('Còn 199/200 câu hỏi hôm nay');
    typeAndSend('Doanh thu?');
    expect(
      await screen.findByText('Không trả lời được câu hỏi này. Vui lòng thử lại.'),
    ).toBeInTheDocument();
  });

  it('shows the SQL only to roles that may compile queries', async () => {
    const conversation = json(detail([['Doanh thu theo khu vực?', answer]]));
    mockApi({
      ...baseRoutes('viewer'),
      [`GET /api/v1/ai/conversations/${CONV_ID}`]: conversation,
    });
    renderAt(`/ask/${CONV_ID}`);
    expect(await screen.findByText('South dẫn đầu với 200 VND.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Xem SQL/ })).not.toBeInTheDocument();
  });

  it('lets analysts open the compiled SQL of an answer', async () => {
    const { calls } = mockApi({
      ...baseRoutes('analyst'),
      [`GET /api/v1/ai/conversations/${CONV_ID}`]: json(
        detail([['Doanh thu theo khu vực?', answer]]),
      ),
      'POST /api/v1/semantic-query/compile': json({
        sql: 'SELECT 1 AS "paid_revenue"',
        params: [],
        policiesApplied: [],
        modelRevision: 2,
      }),
    });
    renderAt(`/ask/${CONV_ID}`);
    fireEvent.click(await screen.findByRole('button', { name: /Xem SQL/ }));
    expect(await screen.findByText('SELECT 1 AS "paid_revenue"')).toBeInTheDocument();
    expect(calls.some((c) => c.key === 'POST /api/v1/semantic-query/compile')).toBe(true);
  });
});
