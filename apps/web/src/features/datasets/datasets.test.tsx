import type { DatasetDetail, DatasetProfile, DatasetSummary, RowsPage } from '@insightai/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { routes } from '@/app/router';
import i18n from '@/i18n';
import { resetSessionForTests } from '@/lib/session';
import { json, mockApi, signedInRoutes } from '@/test/mock-api';

const DATASET_ID = '0190f5a0-0000-7000-8000-0000000000d1';
const VERSION_ID = '0190f5a0-0000-7000-8000-0000000000e1';

const version = {
  id: VERSION_ID,
  versionNo: 2,
  origin: 'IMPORT' as const,
  rowCount: 1234,
  importJobId: null,
  parentVersionId: null,
  cleaningJobId: null,
  profileStatus: 'SUCCEEDED' as const,
  qualityStatus: 'PASSED' as const,
  qualityScore: 100,
  createdAt: '2026-11-03T00:00:00.000Z',
};

const summary: DatasetSummary = {
  id: DATASET_ID,
  name: 'Đơn hàng',
  description: 'Xuất từ POS',
  status: 'READY',
  activeVersion: version,
  columnCount: 2,
  latestImport: {
    id: '0190f5a0-0000-7000-8000-0000000000f1',
    status: 'SUCCEEDED',
    createdAt: version.createdAt,
  },
  createdAt: version.createdAt,
  updatedAt: version.createdAt,
};

const detail: DatasetDetail = {
  ...summary,
  versions: [version],
  columns: [
    {
      ordinal: 1,
      name: 'ngay_dat',
      originalName: 'Ngày đặt',
      dataType: 'DATE',
      inferredType: 'DATE',
      typeConfidence: 0.75,
      detectedFormat: 'dd/MM/yyyy',
      nonEmptyCount: 4,
      invalidCount: 1,
    },
    {
      ordinal: 2,
      name: 'doanh_thu',
      originalName: 'Doanh thu',
      dataType: 'DECIMAL',
      inferredType: 'DECIMAL',
      typeConfidence: 1,
      detectedFormat: '1.234,56',
      nonEmptyCount: 4,
      invalidCount: 0,
    },
  ],
};

const rows: RowsPage = {
  versionId: VERSION_ID,
  columns: detail.columns.map((c) => ({
    name: c.name,
    originalName: c.originalName,
    dataType: c.dataType,
  })),
  rows: [
    { rowId: 1, values: ['2026-10-15', '1234567.5'] },
    { rowId: 2, values: [null, '99.75'] },
  ],
  nextAfter: null,
};

const profile: DatasetProfile = {
  versionId: VERSION_ID,
  status: 'SUCCEEDED',
  computedAt: version.createdAt,
  columns: [
    {
      name: 'doanh_thu',
      originalName: 'Doanh thu',
      dataType: 'DECIMAL',
      rowCount: 4,
      nullCount: 0,
      distinctCount: 4,
      approximate: false,
      min: '0',
      max: '1234567.5',
      mean: '371166.8125',
      stddev: '600000',
      percentiles: { p25: '74.8125', p50: '125049.875', p75: '496141.875' },
      histogram: [
        { from: '0', to: '617283.75', count: 3 },
        { from: '617283.75', to: '1234567.5', count: 1 },
      ],
      topValues: [],
    },
  ],
};

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('Datasets UI', () => {
  beforeEach(async () => {
    resetSessionForTests();
    localStorage.clear();
    await i18n.changeLanguage('vi');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists datasets with row counts formatted for Vietnamese', async () => {
    mockApi({ ...signedInRoutes('analyst'), 'GET /api/v1/datasets': json([summary]) });
    renderAt('/datasets');
    expect(await screen.findByRole('link', { name: 'Đơn hàng' })).toHaveAttribute(
      'href',
      `/datasets/${DATASET_ID}`,
    );
    expect(screen.getByText('1.234')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tạo dataset' })).toBeInTheDocument();
  });

  it('hides write actions from viewers', async () => {
    mockApi({
      ...signedInRoutes('viewer'),
      'GET /api/v1/datasets': json([summary]),
      [`GET /api/v1/datasets/${DATASET_ID}`]: json(detail),
      [`GET /api/v1/datasets/${DATASET_ID}/rows`]: json(rows),
    });
    renderAt('/datasets');
    await screen.findByRole('link', { name: 'Đơn hàng' });
    expect(screen.queryByRole('button', { name: 'Tạo dataset' })).not.toBeInTheDocument();

    renderAt(`/datasets/${DATASET_ID}`);
    await screen.findAllByText('Phiên bản 2');
    expect(screen.queryByText('Tải dữ liệu lên')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lưu trữ' })).not.toBeInTheDocument();
  });

  it('shows data with formatted numbers and marks empty cells', async () => {
    mockApi({
      ...signedInRoutes('owner'),
      [`GET /api/v1/datasets/${DATASET_ID}`]: json(detail),
      [`GET /api/v1/datasets/${DATASET_ID}/rows`]: json(rows),
    });
    renderAt(`/datasets/${DATASET_ID}`);
    expect(await screen.findByText('1.234.567,5')).toBeInTheDocument();
    expect(screen.getByText('99,75')).toBeInTheDocument();
    expect(screen.getByText('(trống)')).toBeInTheDocument();
    // With data present the upload form is collapsed behind a button.
    expect(screen.queryByText('Tải dữ liệu lên')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tải dữ liệu mới' }));
    expect(screen.getByText('Tải dữ liệu lên')).toBeInTheDocument();
  });

  it('shows the detected structure with invalid values highlighted', async () => {
    mockApi({ ...signedInRoutes('owner'), [`GET /api/v1/datasets/${DATASET_ID}`]: json(detail) });
    renderAt(`/datasets/${DATASET_ID}?tab=schema`);
    const row = (await screen.findByText('ngay_dat')).closest('tr')!;
    expect(within(row).getByText('Ngày')).toBeInTheDocument();
    expect(within(row).getByText('75%')).toBeInTheDocument();
    expect(within(row).getByText('1')).toHaveClass('text-destructive');
  });

  it('renders column profiles', async () => {
    mockApi({
      ...signedInRoutes('owner'),
      [`GET /api/v1/datasets/${DATASET_ID}`]: json(detail),
      [`GET /api/v1/datasets/${DATASET_ID}/profile`]: json(profile),
    });
    renderAt(`/datasets/${DATASET_ID}?tab=profile`);
    const card = await screen.findByRole('region', { name: 'Doanh thu' });
    expect(within(card).getByText('125.049,875')).toBeInTheDocument(); // median
    expect(within(card).getByText('371.166,81')).toBeInTheDocument(); // mean, 2 decimals
    expect(within(card).getAllByRole('listitem')).toHaveLength(2); // histogram buckets
  });

  it('uploads a file and reports the import result', async () => {
    const { calls } = mockApi({
      ...signedInRoutes('owner'),
      [`GET /api/v1/datasets/${DATASET_ID}`]: json({
        ...detail,
        activeVersion: null,
        status: 'DRAFT',
      }),
      [`GET /api/v1/datasets/${DATASET_ID}/imports`]: json([]),
      'GET /api/v1/datasets': json([]),
      'GET /api/v1/imports/job-1': json({
        id: 'job-1',
        status: 'SUCCEEDED',
        rowsRead: 4,
        warnings: [{ code: 'INVALID_VALUES', message: 'server text', count: 1 }],
        error: null,
      }),
    });
    // XHR upload: replaced by a minimal fake that answers 202 with the job id.
    const sent: FormData[] = [];
    class FakeXhr {
      status = 202;
      responseText = JSON.stringify({ id: 'job-1', status: 'PENDING' });
      upload = { onprogress: null as unknown };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      send(body: FormData) {
        sent.push(body);
        setTimeout(() => this.onload?.(), 0);
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    renderAt(`/datasets/${DATASET_ID}`);
    const input = await screen.findByLabelText<HTMLInputElement>('File');
    fireEvent.change(input, {
      target: { files: [new File(['a;b\n1;2\n'], 'don-hang.csv', { type: 'text/csv' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tải lên' }));

    expect(await screen.findByText('Đã import 4 dòng.')).toBeInTheDocument();
    expect(screen.getByText(/Một số giá trị không chuyển được/)).toBeInTheDocument();
    expect(screen.queryByText(/server text/)).not.toBeInTheDocument();
    expect(JSON.parse(sent[0]?.get('options') as string)).toEqual({
      hasHeader: true,
      locale: 'vi',
    });
    await waitFor(() =>
      expect(
        calls.filter((c) => c.key === `GET /api/v1/datasets/${DATASET_ID}`).length,
      ).toBeGreaterThan(1),
    );
  });
});
