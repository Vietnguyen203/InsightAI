import type {
  AccessPolicy,
  Catalog,
  CompiledQuery,
  CreateAccessPolicyRequest,
  CreateDimensionRequest,
  CreateEntityRequest,
  CreateMeasureRequest,
  CreateMetricRequest,
  CreateMetricVersionRequest,
  CreateRelationshipRequest,
  CreateSemanticModelRequest,
  CreateSynonymRequest,
  Metric,
  MetricDetail,
  SemanticModelDetail,
  SemanticModelSummary,
  SemanticQuery,
  SemanticQueryResult,
  Synonym,
  UpdateAccessPolicyRequest,
  UpdateMetricVersionRequest,
  UpdateRelationshipRequest,
} from '@insightai/contracts';
import { apiFetch } from '@/lib/api-client';

const post = <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'POST', body });
const patch = <T>(path: string, body: unknown) => apiFetch<T>(path, { method: 'PATCH', body });
const del = <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' });

export const semanticApi = {
  models: () => apiFetch<SemanticModelSummary[]>('/api/v1/semantic-models'),
  createModel: (body: CreateSemanticModelRequest) =>
    post<SemanticModelDetail>('/api/v1/semantic-models', body),
  model: (id: string) => apiFetch<SemanticModelDetail>(`/api/v1/semantic-models/${id}`),
  updateModel: (id: string, body: { name?: string; description?: string | null }) =>
    patch<SemanticModelDetail>(`/api/v1/semantic-models/${id}`, body),
  validate: (id: string) => post<SemanticModelDetail>(`/api/v1/semantic-models/${id}/validate`),
  publish: (id: string) => post<SemanticModelDetail>(`/api/v1/semantic-models/${id}/publish`),

  createEntity: (modelId: string, body: CreateEntityRequest) =>
    post<SemanticModelDetail>(`/api/v1/semantic-models/${modelId}/entities`, body),
  deleteEntity: (id: string) => del<SemanticModelDetail>(`/api/v1/semantic-entities/${id}`),
  createDimension: (entityId: string, body: CreateDimensionRequest) =>
    post<SemanticModelDetail>(`/api/v1/semantic-entities/${entityId}/dimensions`, body),
  deleteDimension: (id: string) => del<SemanticModelDetail>(`/api/v1/semantic-dimensions/${id}`),
  createMeasure: (entityId: string, body: CreateMeasureRequest) =>
    post<SemanticModelDetail>(`/api/v1/semantic-entities/${entityId}/measures`, body),
  deleteMeasure: (id: string) => del<SemanticModelDetail>(`/api/v1/semantic-measures/${id}`),
  createRelationship: (modelId: string, body: CreateRelationshipRequest) =>
    post<SemanticModelDetail>(`/api/v1/semantic-models/${modelId}/relationships`, body),
  updateRelationship: (id: string, body: UpdateRelationshipRequest) =>
    patch<SemanticModelDetail>(`/api/v1/semantic-relationships/${id}`, body),
  deleteRelationship: (id: string) =>
    del<SemanticModelDetail>(`/api/v1/semantic-relationships/${id}`),

  metrics: (modelId: string) => apiFetch<Metric[]>(`/api/v1/semantic-models/${modelId}/metrics`),
  metric: (id: string) => apiFetch<MetricDetail>(`/api/v1/metrics/${id}`),
  createMetric: (modelId: string, body: CreateMetricRequest) =>
    post<MetricDetail>(`/api/v1/semantic-models/${modelId}/metrics`, body),
  createVersion: (metricId: string, body: CreateMetricVersionRequest) =>
    post<MetricDetail>(`/api/v1/metrics/${metricId}/versions`, body),
  updateVersion: (versionId: string, body: UpdateMetricVersionRequest) =>
    patch<MetricDetail>(`/api/v1/metric-versions/${versionId}`, body),
  deleteDraft: (versionId: string) =>
    del<MetricDetail | null>(`/api/v1/metric-versions/${versionId}`),
  publishVersion: (versionId: string) =>
    post<MetricDetail>(`/api/v1/metric-versions/${versionId}/publish`),
  setMetricStatus: (metricId: string, status: 'deprecate' | 'restore') =>
    post<MetricDetail>(`/api/v1/metrics/${metricId}/${status}`),

  synonyms: (modelId: string) => apiFetch<Synonym[]>(`/api/v1/semantic-models/${modelId}/synonyms`),
  addSynonym: (modelId: string, body: CreateSynonymRequest) =>
    post<Synonym>(`/api/v1/semantic-models/${modelId}/synonyms`, body),
  removeSynonym: (id: string) => del<void>(`/api/v1/semantic-synonyms/${id}`),

  policies: (modelId: string) =>
    apiFetch<AccessPolicy[]>(`/api/v1/semantic-models/${modelId}/access-policies`),
  createPolicy: (modelId: string, body: CreateAccessPolicyRequest) =>
    post<AccessPolicy>(`/api/v1/semantic-models/${modelId}/access-policies`, body),
  updatePolicy: (id: string, body: UpdateAccessPolicyRequest) =>
    patch<AccessPolicy>(`/api/v1/semantic-access-policies/${id}`, body),
  deletePolicy: (id: string) => del<void>(`/api/v1/semantic-access-policies/${id}`),

  catalog: (modelKey: string) =>
    apiFetch<Catalog>(`/api/v1/catalog?model=${encodeURIComponent(modelKey)}`),
  query: (body: SemanticQuery) => post<SemanticQueryResult>('/api/v1/semantic-query', body),
  compile: (body: SemanticQuery) => post<CompiledQuery>('/api/v1/semantic-query/compile', body),
};

/** The machine reason of a 422 QUERY_REJECTED (`errors[0].path = "reason.<CODE>"`). */
export function rejectionReason(error: unknown): string | null {
  const path = (error as { problem?: { errors?: { path: string }[] } }).problem?.errors?.[0]?.path;
  return path?.startsWith('reason.') ? path.slice('reason.'.length) : null;
}
