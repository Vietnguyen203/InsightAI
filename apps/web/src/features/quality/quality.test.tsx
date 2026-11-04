import type {
  CleaningJob,
  CleaningPreview,
  CleaningSuggestions,
  DatasetDetail,
  DatasetVersion,
  QualityCheckDetail,
  QualityCheckSummary,
  QualityRule,
  RowsPage,
  VersionComparison,
} from '@insightai/contracts';
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
const V1 = '0190f5a0-0000-7000-8000-0000000000e1';
const V2 = '0190f5a0-0000-7000-8000-0000000000e2';
const CHECK_ID = '0190f5a0-0000-7000-8000-0000000000c1';
const RESULT_ID = '0190f5a0-0000-7000-8000-0000000000f1';
const RULE_ID = '0190f5a0-0000-7000-8000-0000000000a1';
const CREATED = '2026-11-03T00:00:00.000Z';

const version = (id: string, no: number, extra: Partial<DatasetVersion> = {}): DatasetVersion => ({
  id,
  versionNo: no,
  origin: 'IMPORT',
  rowCount: 10,
  importJobId: null,
  parentVersionId: null,
  cleaningJobId: null,
  profileStatus: 'SUCCEEDED',
  qualityStatus: 'FAILED',
  qualityScore: 90,
  createdAt: CREATED,
  ...extra,
});

const v1 = version(V1, 1);
const v2 = version(V2, 2, {
  origin: 'CLEANING',
  parentVersionId: V1,
  rowCount: 8,
  qualityStatus: 'PASSED',
  qualityScore: 100,
});

function detail(versions: DatasetVersion[] = [v1]): DatasetDetail {
  return {
    id: DATASET_ID,
    name: 'Đơn hàng',
    description: null,
    status: 'READY',
    activeVersion: v1,
    columnCount: 2,
    latestImport: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    versions: [...versions].reverse(),
    columns: [
      {
        ordinal: 1,
        name: 'thanh_pho',
        originalName: 'Thành phố',
        dataType: 'TEXT',
        inferredType: 'TEXT',
        typeConfidence: 1,
        detectedFormat: null,
        nonEmptyCount: 10,
        invalidCount: 0,
      },
      {
        ordinal: 2,
        name: 'so_luong',
        originalName: 'Số lượng',
        dataType: 'INTEGER',
        inferredType: 'INTEGER',
        typeConfidence: 1,
        detectedFormat: '1.234',
        nonEmptyCount: 9,
        invalidCount: 0,
      },
    ],
  };
}

const rule: QualityRule = {
  id: RULE_ID,
  datasetId: DATASET_ID,
  name: 'Số lượng không âm',
  dimension: 'validity',
  definition: { type: 'range', column: 'so_luong', min: '0' },
  severity: 'error',
  weight: 1,
  threshold: 1,
  enabled: true,
  origin: 'user',
  createdAt: CREATED,
  updatedAt: CREATED,
};

const check: QualityCheckSummary = {
  id: CHECK_ID,
  datasetId: DATASET_ID,
  versionId: V1,
  versionNo: 1,
  trigger: 'IMPORT',
  status: 'SUCCEEDED',
  score: 90,
  qualityStatus: 'FAILED',
  dimensionScores: {
    completeness: 100,
    uniqueness: null,
    validity: 90,
    consistency: null,
    referential_integrity: null,
  },
  rulesTotal: 2,
  rulesFailed: 1,
  error: null,
  createdAt: CREATED,
  finishedAt: CREATED,
};

const checkDetail: QualityCheckDetail = {
  ...check,
  results: [
    {
      id: RESULT_ID,
      ruleId: RULE_ID,
      ruleName: rule.name,
      dimension: 'validity',
      definition: rule.definition,
      severity: 'error',
      weight: 1,
      threshold: 1,
      status: 'FAILED',
      evaluatedCount: 9,
      failedCount: 1,
      passRate: 0.888889,
      message: null,
      sampleCount: 1,
    },
  ],
};

const columnsPage: RowsPage = {
  versionId: V1,
  columns: detail().columns.map((c) => ({
    name: c.name,
    originalName: c.originalName,
    dataType: c.dataType,
  })),
  rows: [],
  nextAfter: null,
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

function renderAtWithUnmount(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const datasetRoutes = (versions?: DatasetVersion[]) => ({
  [`GET /api/v1/datasets/${DATASET_ID}`]: json(detail(versions)),
  [`GET /api/v1/datasets/${DATASET_ID}/quality-rules`]: json([rule]),
});

const bodyOf = (calls: { key: string; init: RequestInit | undefined }[], key: string) =>
  JSON.parse(calls.find((c) => c.key === key)?.init?.body as string) as unknown;

describe('Quality & cleaning UI', () => {
  beforeEach(async () => {
    resetSessionForTests();
    localStorage.clear();
    await i18n.changeLanguage('vi');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('quality tab', () => {
    const qualityRoutes = {
      ...datasetRoutes(),
      [`GET /api/v1/datasets/${DATASET_ID}/quality-checks`]: json([check]),
      [`GET /api/v1/quality-checks/${CHECK_ID}`]: json(checkDetail),
      [`GET /api/v1/quality-checks/${CHECK_ID}/results/${RESULT_ID}/issues`]: json({
        items: [{ rowId: 7, column: 'so_luong', value: '-1', rawValue: null }],
        nextCursor: null,
      }),
    };

    it('shows the score, dimensions and failing rows of a rule', async () => {
      mockApi({ ...signedInRoutes('analyst'), ...qualityRoutes });
      renderAt(`/datasets/${DATASET_ID}?tab=quality`);

      expect(await screen.findByText('1/2 quy tắc không đạt')).toBeInTheDocument();
      expect(screen.getByRole('meter', { name: 'Hợp lệ' })).toHaveAttribute('aria-valuenow', '90');
      expect(screen.getByRole('meter', { name: 'Nhất quán' })).not.toHaveAttribute('aria-valuenow');

      fireEvent.click(
        await screen.findByRole('button', { name: 'Xem dòng lỗi của Số lượng không âm' }),
      );
      expect(await screen.findByText('#7')).toBeInTheDocument();
      expect(screen.getByText('Hiển thị mẫu 1 trong 1 dòng lỗi.')).toBeInTheDocument();
    });

    it('creates an allowed-values rule from the editor', async () => {
      const { calls } = mockApi({
        ...signedInRoutes('analyst'),
        ...qualityRoutes,
        [`POST /api/v1/datasets/${DATASET_ID}/quality-rules`]: json(rule, 201),
      });
      renderAt(`/datasets/${DATASET_ID}?tab=quality`);

      fireEvent.click(await screen.findByRole('button', { name: 'Thêm quy tắc' }));
      const form = await screen.findByRole('form', { name: 'Quy tắc mới' });
      fireEvent.change(within(form).getByLabelText('Tên'), {
        target: { value: 'Thành phố hợp lệ' },
      });
      fireEvent.change(within(form).getByLabelText('Loại kiểm tra'), {
        target: { value: 'allowed_values' },
      });
      fireEvent.change(within(form).getByLabelText('Giá trị cho phép'), {
        target: { value: 'Hà Nội\n Đà Nẵng \n' },
      });
      fireEvent.click(within(form).getByRole('button', { name: 'Lưu' }));

      await waitFor(() =>
        expect(
          calls.some((c) => c.key === `POST /api/v1/datasets/${DATASET_ID}/quality-rules`),
        ).toBe(true),
      );
      expect(bodyOf(calls, `POST /api/v1/datasets/${DATASET_ID}/quality-rules`)).toEqual({
        name: 'Thành phố hợp lệ',
        definition: {
          type: 'allowed_values',
          column: 'thanh_pho',
          values: ['Hà Nội', 'Đà Nẵng'],
          caseSensitive: true,
        },
        severity: 'warning',
        weight: 1,
        threshold: 1,
        enabled: true,
      });
    });

    it('is read-only for viewers', async () => {
      mockApi({ ...signedInRoutes('viewer'), ...qualityRoutes });
      renderAt(`/datasets/${DATASET_ID}?tab=quality`);
      expect(await screen.findByText('1/2 quy tắc không đạt')).toBeInTheDocument();
      expect(await screen.findByText('Số lượng không âm', { selector: 'div' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Chạy kiểm tra' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Thêm quy tắc' })).not.toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Bật/tắt Số lượng không âm' })).toBeDisabled();
    });
  });

  describe('cleaning tab', () => {
    const suggestions: CleaningSuggestions = {
      versionId: V1,
      qualityCheckId: CHECK_ID,
      suggestions: [
        {
          id: 'trim_whitespace',
          operation: { type: 'trim_whitespace', columns: ['thanh_pho'], collapseInner: false },
          source: 'RULE',
          rationale: { code: 'TRIM_WHITESPACE', message: 'x', params: { columns: 'thanh_pho' } },
          estimatedRows: 1,
        },
        {
          id: `drop_rows:${RULE_ID}`,
          operation: { type: 'drop_rows', ruleId: RULE_ID },
          source: 'RULE',
          rationale: {
            code: 'DROP_FAILING_ROWS',
            message: 'x',
            params: { rule: rule.name, count: 1 },
          },
          estimatedRows: 1,
        },
      ],
    };
    const preview: CleaningPreview = {
      sourceVersionId: V1,
      rowCountBefore: 10,
      rowCountAfter: 9,
      operations: [
        { index: 0, type: 'trim_whitespace', affectedRows: 1, removedRows: 0 },
        { index: 1, type: 'drop_rows', affectedRows: null, removedRows: 1 },
      ],
      columns: [
        {
          name: 'thanh_pho',
          dataType: 'TEXT',
          previousName: null,
          previousType: null,
          status: 'modified',
        },
        {
          name: 'so_luong',
          dataType: 'INTEGER',
          previousName: null,
          previousType: null,
          status: 'unchanged',
        },
      ],
      sample: {
        columns: ['thanh_pho'],
        rows: [
          { rowId: 2, removed: false, before: [' Hà Nội '], after: ['Hà Nội'] },
          { rowId: 7, removed: true, before: ['Huế'], after: null },
        ],
      },
    };
    const job: CleaningJob = {
      id: '0190f5a0-0000-7000-8000-0000000000b1',
      datasetId: DATASET_ID,
      sourceVersionId: V1,
      sourceVersionNo: 1,
      targetVersionId: null,
      status: 'PENDING',
      operations: [],
      error: null,
      requestedById: null,
      createdAt: CREATED,
      startedAt: null,
      finishedAt: null,
    };
    const cleaningRoutes = {
      ...datasetRoutes(),
      [`GET /api/v1/datasets/${DATASET_ID}/rows`]: json(columnsPage),
      [`GET /api/v1/datasets/${DATASET_ID}/cleaning/suggestions`]: json(suggestions),
      [`GET /api/v1/datasets/${DATASET_ID}/cleaning-jobs`]: json([]),
      [`POST /api/v1/datasets/${DATASET_ID}/cleaning/preview`]: json(preview),
      [`POST /api/v1/datasets/${DATASET_ID}/cleaning-jobs`]: json(job, 202),
    };

    it('builds steps from suggestions, previews them and applies them', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { calls } = mockApi({ ...signedInRoutes('analyst'), ...cleaningRoutes });
      renderAt(`/datasets/${DATASET_ID}?tab=cleaning`);

      expect(
        await screen.findByText('Có khoảng trắng thừa ở đầu/cuối giá trị trong thanh_pho.'),
      ).toBeInTheDocument();
      for (const button of await screen.findAllByRole('button', { name: 'Thêm vào các bước' })) {
        fireEvent.click(button);
      }
      expect(screen.getAllByText('Xóa dòng vi phạm "Số lượng không âm"').length).toBeGreaterThan(1);

      // Applying requires a preview of the current steps.
      expect(screen.getByRole('button', { name: 'Áp dụng' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
      expect(await screen.findByText('đổi 1 dòng')).toBeInTheDocument();
      expect(screen.getByText('xóa 1 dòng')).toBeInTheDocument();
      expect(screen.getByText('bị xóa')).toBeInTheDocument();
      expect(bodyOf(calls, `POST /api/v1/datasets/${DATASET_ID}/cleaning/preview`)).toEqual({
        sourceVersionId: V1,
        operations: [
          { type: 'trim_whitespace', columns: ['thanh_pho'], collapseInner: false },
          { type: 'drop_rows', ruleId: RULE_ID },
        ],
      });

      fireEvent.click(screen.getByRole('button', { name: 'Áp dụng' }));
      expect(await screen.findByText('Đang tạo phiên bản mới…')).toBeInTheDocument();
      expect(
        calls.filter((c) => c.key === `POST /api/v1/datasets/${DATASET_ID}/cleaning-jobs`),
      ).toHaveLength(1);
    });

    it('lets viewers see suggestions but not build or apply steps', async () => {
      mockApi({ ...signedInRoutes('viewer'), ...cleaningRoutes });
      renderAt(`/datasets/${DATASET_ID}?tab=cleaning`);
      expect(
        await screen.findByText('Có khoảng trắng thừa ở đầu/cuối giá trị trong thanh_pho.'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Thêm vào các bước' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Thêm thao tác' })).not.toBeInTheDocument();
    });
  });

  describe('versions tab', () => {
    const comparison: VersionComparison = {
      base: {
        id: V1,
        versionNo: 1,
        origin: 'IMPORT',
        rowCount: 10,
        qualityStatus: 'FAILED',
        qualityScore: 90,
      },
      target: {
        id: V2,
        versionNo: 2,
        origin: 'CLEANING',
        rowCount: 8,
        qualityStatus: 'PASSED',
        qualityScore: 100,
      },
      rows: { removed: 2, added: 0, changed: 3 },
      columns: [
        {
          name: 'thanh_pho',
          baseType: 'TEXT',
          targetType: 'TEXT',
          status: 'unchanged',
          changedRows: 2,
        },
        {
          name: 'so_luong',
          baseType: 'INTEGER',
          targetType: 'INTEGER',
          status: 'unchanged',
          changedRows: 0,
        },
      ],
      rules: [
        {
          ruleId: RULE_ID,
          ruleName: rule.name,
          baseFailed: 1,
          targetFailed: 0,
          basePassRate: 0.9,
          targetPassRate: 1,
        },
      ],
    };

    it('compares the cleaned version with its source and activates it', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { calls } = mockApi({
        ...signedInRoutes('analyst'),
        ...datasetRoutes([v1, v2]),
        [`GET /api/v1/datasets/${DATASET_ID}/versions/compare`]: json(comparison),
        [`POST /api/v1/datasets/${DATASET_ID}/versions/${V2}/activate`]: json(detail([v1, v2])),
      });
      renderAt(`/datasets/${DATASET_ID}?tab=versions&focus=${V2}`);

      expect(
        await screen.findByText('làm sạch từ phiên bản 1', { exact: false }),
      ).toBeInTheDocument();
      expect(await screen.findByText('−2')).toBeInTheDocument();
      const compare = calls.find((c) => c.key.endsWith('/versions/compare'));
      expect(compare).toBeDefined();
      expect(screen.getByRole('combobox', { name: 'Phiên bản gốc' })).toHaveValue(V1);
      expect(screen.getByRole('combobox', { name: 'Phiên bản so sánh' })).toHaveValue(V2);
      expect(screen.getByText(rule.name)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Kích hoạt' }));
      await waitFor(() =>
        expect(
          calls.some(
            (c) => c.key === `POST /api/v1/datasets/${DATASET_ID}/versions/${V2}/activate`,
          ),
        ).toBe(true),
      );
    });

    it('offers a rollback to older versions, but not to viewers', async () => {
      const active = { ...detail([v1, v2]), activeVersion: v2 };
      const routes = {
        [`GET /api/v1/datasets/${DATASET_ID}`]: json(active),
        [`GET /api/v1/datasets/${DATASET_ID}/versions/compare`]: json(comparison),
      };
      mockApi({ ...signedInRoutes('analyst'), ...routes });
      const { unmount } = renderAtWithUnmount(`/datasets/${DATASET_ID}?tab=versions`);
      expect(
        await screen.findByRole('button', { name: 'Quay lại phiên bản này' }),
      ).toBeInTheDocument();
      unmount();

      resetSessionForTests();
      mockApi({ ...signedInRoutes('viewer'), ...routes });
      renderAt(`/datasets/${DATASET_ID}?tab=versions`);
      expect(await screen.findByText('So sánh phiên bản')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Quay lại phiên bản này' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Kích hoạt' })).not.toBeInTheDocument();
    });
  });
});
