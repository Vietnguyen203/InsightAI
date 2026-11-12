import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmError, llmErrorCode } from './llm-provider';
import { OpenAiProvider } from './openai-provider';

const toolUseFailed = () =>
  new Response(
    JSON.stringify({
      error: {
        message: 'Tool choice is required',
        code: 'tool_use_failed',
        failed_generation: 'Hi!',
      },
    }),
    { status: 400 },
  );
const toolCall = () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
    { status: 200 },
  );

const provider = new OpenAiProvider('key', 'model', 'https://llm.example/v1');
const request = {
  messages: [{ role: 'user' as const, content: 'xin chào' }],
  tools: [{ name: 'f', description: 'f', parameters: { type: 'object' } }],
};

describe('OpenAiProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks once more when the provider rejects a turn without the required tool call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(toolUseFailed())
      .mockResolvedValueOnce(toolCall());
    vi.stubGlobal('fetch', fetchMock);

    const response = await provider.chat(request);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.toolCalls).toEqual([{ id: 'c1', name: 'f', arguments: '{}' }]);
  });

  it('gives up after the second tool_use_failed and names the code, not the generated text', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(toolUseFailed()));
    vi.stubGlobal('fetch', fetchMock);

    const error = await provider.chat(request).catch((e: unknown) => e);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).message).toBe(
      'The AI provider answered with HTTP 400 (tool_use_failed)',
    );
  });

  it('does not retry other HTTP errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await provider.chat(request).catch((e: unknown) => e);
    expect((error as LlmError).message).toBe(
      'The AI provider answered with HTTP 429 (rate_limit_exceeded)',
    );
    expect((error as LlmError).status).toBe(429);
    expect(llmErrorCode(error as LlmError)).toBe('AI_PROVIDER_ERROR');
    expect(llmErrorCode(new LlmError('too large', 413))).toBe('AI_REQUEST_TOO_LARGE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
