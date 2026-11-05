import type {
  CreateDashboardRequest,
  CreateWidgetRequest,
  DashboardDetail,
  DashboardSummary,
  SemanticQueryResult,
  UpdateDashboardRequest,
  UpdateLayoutRequest,
  UpdateWidgetRequest,
} from '@insightai/contracts';
import { apiFetch } from '@/lib/api-client';

const send = <T>(method: string, path: string, body?: unknown) =>
  apiFetch<T>(path, { method, body });

export const dashboardApi = {
  list: () => apiFetch<DashboardSummary[]>('/api/v1/dashboards'),
  get: (id: string) => apiFetch<DashboardDetail>(`/api/v1/dashboards/${id}`),
  create: (body: CreateDashboardRequest) =>
    send<DashboardDetail>('POST', '/api/v1/dashboards', body),
  update: (id: string, body: UpdateDashboardRequest) =>
    send<DashboardDetail>('PATCH', `/api/v1/dashboards/${id}`, body),
  remove: (id: string) => send<void>('DELETE', `/api/v1/dashboards/${id}`),
  addWidget: (id: string, body: CreateWidgetRequest) =>
    send<DashboardDetail>('POST', `/api/v1/dashboards/${id}/widgets`, body),
  layout: (id: string, body: UpdateLayoutRequest) =>
    send<DashboardDetail>('PUT', `/api/v1/dashboards/${id}/layout`, body),
  updateWidget: (widgetId: string, body: UpdateWidgetRequest) =>
    send<DashboardDetail>('PATCH', `/api/v1/dashboard-widgets/${widgetId}`, body),
  removeWidget: (widgetId: string) =>
    send<DashboardDetail>('DELETE', `/api/v1/dashboard-widgets/${widgetId}`),
  run: (widgetId: string) =>
    send<SemanticQueryResult>('POST', `/api/v1/dashboard-widgets/${widgetId}/run`),
};
