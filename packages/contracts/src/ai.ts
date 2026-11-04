import { z } from 'zod';
import { semanticQueryResultSchema, semanticQuerySchema } from './semantic-query.js';
import { semanticKeySchema } from './semantic.js';

/**
 * AI analytics (docs/ARCHITECTURE.md §4.3): a question becomes Semantic Query IR through tool
 * calling, the engine computes the numbers, and the narrative only references them through
 * placeholders. The LLM never writes SQL (D-03) and never produces numbers.
 */

export const askRequestSchema = z
  .object({
    /** Continue a conversation (follow-up questions reuse its last query as context). */
    conversationId: z.uuid().optional(),
    /** Semantic model to ask about; required to start a conversation. */
    model: semanticKeySchema.optional(),
    question: z.string().trim().min(1).max(1000),
  })
  .refine((v) => v.conversationId !== undefined || v.model !== undefined, {
    message: 'model is required to start a conversation',
    path: ['model'],
  });
export type AskRequest = z.input<typeof askRequestSchema>;

/** Chart chosen by rules from the shape of the result (the LLM does not pick it). */
export const chartSpecSchema = z.object({
  type: z.enum(['kpi', 'line', 'bar', 'table']),
  /** Column key on the x axis (time or category). */
  x: z.string().nullable(),
  /** Column keys of the plotted values. */
  series: z.array(z.string()),
});
export type ChartSpec = z.infer<typeof chartSpecSchema>;

export const provenanceSchema = z.object({
  /** Human-readable reading of the query ("Doanh thu · theo tháng · 01/10–31/10/2026"). */
  interpretedAs: z.string(),
  queryHistoryId: z.uuid().nullable(),
  modelRevision: z.number().int(),
  metrics: z.array(z.object({ key: z.string(), version: z.number().int(), label: z.string() })),
  datasets: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      versionNo: z.number().int(),
      qualityScore: z.number().nullable(),
    }),
  ),
  policiesApplied: z.array(z.string()),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const answerStatusSchema = z.enum(['ANSWERED', 'CLARIFICATION', 'CANNOT_ANSWER', 'ERROR']);
export type AnswerStatus = z.infer<typeof answerStatusSchema>;

export const answerSchema = z.object({
  status: answerStatusSchema,
  /** Rendered narrative (numbers filled in by the server). */
  narrative: z.string().nullable(),
  query: semanticQuerySchema.nullable(),
  result: semanticQueryResultSchema.nullable(),
  chart: chartSpecSchema.nullable(),
  clarification: z.object({ question: z.string(), options: z.array(z.string()) }).nullable(),
  provenance: provenanceSchema.nullable(),
});
export type Answer = z.infer<typeof answerSchema>;

export const messageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['USER', 'ASSISTANT']),
  content: z.string(),
  answer: answerSchema.nullable(),
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof messageSchema>;

export const conversationSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  model: z.string(),
  lastMessageAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationDetailSchema = conversationSummarySchema.extend({
  messages: z.array(messageSchema),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

/** Server-sent events of POST /ai/ask (one JSON object per `data:` line). */
export const askEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation'), conversationId: z.uuid() }),
  z.object({
    type: z.literal('stage'),
    stage: z.enum(['understanding', 'planning', 'executing', 'explaining']),
  }),
  z.object({ type: z.literal('result'), answer: answerSchema }),
  z.object({ type: z.literal('done'), messageId: z.uuid() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type AskEvent = z.infer<typeof askEventSchema>;

export const aiStatusSchema = z.object({
  enabled: z.boolean(),
  /** Questions left today for the organization. */
  remainingToday: z.number().int(),
  dailyLimit: z.number().int(),
});
export type AiStatus = z.infer<typeof aiStatusSchema>;
