import {
  type CreateInvestigationRequest,
  type Evidence,
  type InvestigationDetail,
  type InvestigationEvent,
  investigationEventSchema,
  type InvestigationReport,
  type InvestigationStatus,
  type InvestigationSummary,
  TERMINAL_INVESTIGATION_STATUSES,
} from '@insightai/contracts';
import { apiFetch } from '@/lib/api-client';
import { getEventStream } from '@/lib/event-stream';

const path = (id: string, rest = '') => `/api/v1/investigations/${id}${rest}`;

export const investigationsApi = {
  list: () => apiFetch<InvestigationSummary[]>('/api/v1/investigations'),
  get: (id: string) => apiFetch<InvestigationDetail>(path(id)),
  create: (body: CreateInvestigationRequest) =>
    apiFetch<InvestigationDetail>('/api/v1/investigations', { method: 'POST', body }),
  approve: (id: string) => apiFetch<InvestigationDetail>(path(id, '/approve'), { method: 'POST' }),
  cancel: (id: string) => apiFetch<InvestigationDetail>(path(id, '/cancel'), { method: 'POST' }),
  remove: (id: string) => apiFetch<void>(path(id), { method: 'DELETE' }),
  evidence: (id: string) => apiFetch<Evidence[]>(path(id, '/evidence')),
  report: (id: string) => apiFetch<InvestigationReport>(path(id, '/report')),
  /** Progress events until the run ends; unknown or malformed events are ignored. */
  events: (
    id: string,
    onEvent: (event: InvestigationEvent, id: string | null) => void,
    options: { signal?: AbortSignal; lastEventId?: string | null } = {},
  ) =>
    getEventStream(
      path(id, '/events'),
      (data, eventId) => {
        const parsed = investigationEventSchema.safeParse(data);
        if (parsed.success) onEvent(parsed.data, eventId);
      },
      options,
    ),
};

export const isTerminal = (status: InvestigationStatus) =>
  TERMINAL_INVESTIGATION_STATUSES.includes(status);

/** Runs that end with a report. */
export const hasReport = (status: InvestigationStatus) =>
  status === 'COMPLETED' || status === 'PARTIAL';
