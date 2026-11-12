import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './llm-provider';

const TIMEOUT_MS = 45_000;
const TOOL_USE_ATTEMPTS = 2;

/** The provider's machine-readable error code (OpenAI-style `error.code`), never its message. */
async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const data = (await response.json()) as { error?: { code?: unknown } };
    const code = data.error?.code;
    return typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

interface ChatCompletion {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * OpenAI Chat Completions with function calling (D-08), over plain HTTPS (no SDK dependency).
 * The API key stays on the server; errors never include request content.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl: string,
  ) {}

  async chat(request: LlmRequest): Promise<LlmResponse> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const body = {
      model: this.model,
      messages: request.messages.map((m) => {
        if (m.role === 'tool')
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
        if (m.role === 'assistant') {
          return {
            role: 'assistant',
            content: m.content,
            ...(m.toolCalls?.length
              ? {
                  tool_calls: m.toolCalls.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: c.arguments },
                  })),
                }
              : {}),
          };
        }
        return m;
      }),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({ type: 'function', function: t })),
            tool_choice: 'required',
          }
        : {}),
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      ...(request.maxOutputTokens ? { max_completion_tokens: request.maxOutputTokens } : {}),
    };

    let response: Response;
    for (let attempt = 1; ; attempt++) {
      try {
        response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      } catch {
        throw new LlmError('The AI provider could not be reached');
      }
      if (response.ok) break;
      const code = await errorCode(response);
      // Some OpenAI-compatible providers (Groq) reject a turn where the model wrote plain text
      // although a tool call was required, instead of forcing the call. The next sample usually
      // calls the tool, so ask once more; the plain text is never used (D-03).
      if (code === 'tool_use_failed' && attempt < TOOL_USE_ATTEMPTS) continue;
      throw new LlmError(
        `The AI provider answered with HTTP ${response.status}${code ? ` (${code})` : ''}`,
        response.status,
      );
    }
    const data = (await response.json()) as ChatCompletion;
    const message = data.choices?.[0]?.message;
    return {
      content: message?.content ?? null,
      toolCalls: (message?.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      })),
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}
