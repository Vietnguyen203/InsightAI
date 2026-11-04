import type {
  CleaningJob,
  CleaningOperationInput,
  CleaningPreview,
  CleaningSuggestions,
  CreateRuleRequest,
  DatasetSummary,
  Page,
  QualityCheckDetail,
  QualityCheckSummary,
  QualityIssue,
  QualityRule,
  UpdateRuleRequest,
  ValidateExpressionResponse,
  VersionComparison,
} from '@insightai/contracts';
import { apiFetch } from '@/lib/api-client';

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const qualityApi = {
  rules: (datasetId: string) =>
    apiFetch<QualityRule[]>(`/api/v1/datasets/${datasetId}/quality-rules`),
  createRule: (datasetId: string, body: CreateRuleRequest) =>
    apiFetch<QualityRule>(`/api/v1/datasets/${datasetId}/quality-rules`, { method: 'POST', body }),
  updateRule: (ruleId: string, body: UpdateRuleRequest) =>
    apiFetch<QualityRule>(`/api/v1/quality-rules/${ruleId}`, { method: 'PATCH', body }),
  deleteRule: (ruleId: string) =>
    apiFetch<void>(`/api/v1/quality-rules/${ruleId}`, { method: 'DELETE' }),
  validateExpression: (datasetId: string, expr: string) =>
    apiFetch<ValidateExpressionResponse>(`/api/v1/datasets/${datasetId}/expressions/validate`, {
      method: 'POST',
      body: { expr },
    }),
  checks: (datasetId: string) =>
    apiFetch<QualityCheckSummary[]>(`/api/v1/datasets/${datasetId}/quality-checks`),
  runCheck: (datasetId: string, versionId?: string) =>
    apiFetch<QualityCheckSummary>(
      `/api/v1/datasets/${datasetId}/quality-checks${query({ versionId })}`,
      { method: 'POST' },
    ),
  check: (checkId: string) => apiFetch<QualityCheckDetail>(`/api/v1/quality-checks/${checkId}`),
  issues: (checkId: string, resultId: string, after = 0) =>
    apiFetch<Page<QualityIssue>>(
      `/api/v1/quality-checks/${checkId}/results/${resultId}/issues${query({ after, limit: 50 })}`,
    ),

  suggestions: (datasetId: string, versionId?: string) =>
    apiFetch<CleaningSuggestions>(
      `/api/v1/datasets/${datasetId}/cleaning/suggestions${query({ versionId })}`,
    ),
  preview: (datasetId: string, body: CleaningBody) =>
    apiFetch<CleaningPreview>(`/api/v1/datasets/${datasetId}/cleaning/preview`, {
      method: 'POST',
      body,
    }),
  apply: (datasetId: string, body: CleaningBody) =>
    apiFetch<CleaningJob>(`/api/v1/datasets/${datasetId}/cleaning-jobs`, { method: 'POST', body }),
  cleaningJobs: (datasetId: string) =>
    apiFetch<CleaningJob[]>(`/api/v1/datasets/${datasetId}/cleaning-jobs`),

  activateVersion: (datasetId: string, versionId: string) =>
    apiFetch<DatasetSummary>(`/api/v1/datasets/${datasetId}/versions/${versionId}/activate`, {
      method: 'POST',
    }),
  compareVersions: (datasetId: string, base: string, target: string) =>
    apiFetch<VersionComparison>(
      `/api/v1/datasets/${datasetId}/versions/compare${query({ base, target })}`,
    ),
};

export interface CleaningBody {
  sourceVersionId?: string;
  operations: CleaningOperationInput[];
}

/** Checks and cleaning jobs are still running in these states. */
export const isRunning = (status: string | undefined) =>
  status === 'PENDING' || status === 'RUNNING';
