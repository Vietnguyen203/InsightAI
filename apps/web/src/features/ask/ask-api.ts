import {
  type AiStatus,
  type AskEvent,
  askEventSchema,
  type AskRequest,
  type ConversationDetail,
  type ConversationSummary,
} from '@insightai/contracts';
import { apiFetch } from '@/lib/api-client';
import { postEventStream } from '@/lib/event-stream';

export const askApi = {
  status: () => apiFetch<AiStatus>('/api/v1/ai/status'),
  conversations: () => apiFetch<ConversationSummary[]>('/api/v1/ai/conversations'),
  conversation: (id: string) => apiFetch<ConversationDetail>(`/api/v1/ai/conversations/${id}`),
  removeConversation: (id: string) =>
    apiFetch<void>(`/api/v1/ai/conversations/${id}`, { method: 'DELETE' }),
  /** Streams the answer; unknown or malformed events are ignored. */
  ask: (body: AskRequest, onEvent: (event: AskEvent) => void, signal?: AbortSignal) =>
    postEventStream(
      '/api/v1/ai/ask',
      body,
      (data) => {
        const parsed = askEventSchema.safeParse(data);
        if (parsed.success) onEvent(parsed.data);
      },
      signal,
    ),
};
