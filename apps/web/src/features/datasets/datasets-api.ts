import type {
  CreateDatasetRequest,
  DatasetDetail,
  DatasetProfile,
  DatasetSummary,
  ImportJob,
  ImportOptions,
  RowsPage,
} from '@insightai/contracts';
import type { TFunction } from 'i18next';
import { apiFetch } from '@/lib/api-client';
import { type UploadProgress, uploadForm } from '@/lib/upload';

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const datasetsApi = {
  list: () => apiFetch<DatasetSummary[]>('/api/v1/datasets'),
  create: (body: CreateDatasetRequest) =>
    apiFetch<DatasetSummary>('/api/v1/datasets', { method: 'POST', body }),
  get: (id: string) => apiFetch<DatasetDetail>(`/api/v1/datasets/${id}`),
  archive: (id: string) => apiFetch<void>(`/api/v1/datasets/${id}/archive`, { method: 'POST' }),
  rows: (id: string, params: { versionId?: string; after?: number; limit?: number }) =>
    apiFetch<RowsPage>(`/api/v1/datasets/${id}/rows${query(params)}`),
  profile: (id: string, versionId?: string) =>
    apiFetch<DatasetProfile>(`/api/v1/datasets/${id}/profile${query({ versionId })}`),
  reprofile: (id: string, versionId?: string) =>
    apiFetch<void>(`/api/v1/datasets/${id}/profile${query({ versionId })}`, { method: 'POST' }),
  imports: (id: string) => apiFetch<ImportJob[]>(`/api/v1/datasets/${id}/imports`),
  importJob: (importId: string) => apiFetch<ImportJob>(`/api/v1/imports/${importId}`),
  upload: (
    id: string,
    file: File,
    options: ImportOptions,
    onProgress?: (progress: UploadProgress) => void,
  ) => {
    const form = new FormData();
    form.append('file', file);
    form.append('options', JSON.stringify(options));
    return uploadForm<ImportJob>(`/api/v1/datasets/${id}/imports`, form, onProgress);
  },
};

/** Import and profiling jobs are still running in these states (poll until they leave them). */
export const isInProgress = (status: string | undefined) =>
  status === 'PENDING' || status === 'RUNNING';

/** Localized text for an import failure; falls back to the server message for unknown codes. */
export function importErrorText(
  t: TFunction,
  error: { code: string; message: string } | null,
): string {
  if (!error) return '';
  return t(`datasets.importErrors.${error.code}`, { defaultValue: error.message });
}
