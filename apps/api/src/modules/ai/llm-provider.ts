/**
 * Provider abstraction (docs/SEMANTIC_LAYER_DESIGN.md §9.4). The pipeline only depends on this
 * interface; tests inject a scripted provider. The LLM never receives credentials or SQL access:
 * it only sees the catalog, tool results and the question.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as produced by the model (validated by the caller). */
  arguments: string;
}

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  /** Ask for a JSON object as the reply (no tools). */
  json?: boolean;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  chat(request: LlmRequest): Promise<LlmResponse>;
}

/** Nest token; resolves to null when no provider is configured. */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}
