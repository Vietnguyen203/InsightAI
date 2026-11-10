import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '../../src/modules/ai/llm-provider';

/**
 * Real-model eval helpers (AI_EVAL=true). Free tiers (e.g. Gemini through its OpenAI-compatible
 * endpoint) limit requests per minute and per day, so the eval can pace and retry its calls and
 * run a deterministic sample of the set. Test code only: production keeps its own behaviour.
 *
 *   AI_EVAL_MIN_INTERVAL_MS  minimum gap between two model calls (default 0)
 *   AI_EVAL_RETRIES          retries on HTTP 429/5xx or network errors (default 4)
 *   AI_EVAL_RETRY_MS         first backoff, doubled each retry (default 15000)
 *   AI_EVAL_SAMPLE           run about this many cases, spread over every group (default: all)
 */
export class PacedLlm implements LlmProvider {
  calls = 0;
  retries = 0;
  failures = 0;
  promptTokens = 0;
  completionTokens = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(
    private readonly inner: LlmProvider,
    private readonly minIntervalMs = Number(process.env.AI_EVAL_MIN_INTERVAL_MS ?? 0),
    private readonly maxRetries = Number(process.env.AI_EVAL_RETRIES ?? 4),
    private readonly retryMs = Number(process.env.AI_EVAL_RETRY_MS ?? 15_000),
  ) {}

  get name() {
    return this.inner.name;
  }

  get model() {
    return this.inner.model;
  }

  /** Calls run one at a time, so the interval holds even when the worker runs steps in parallel. */
  chat(request: LlmRequest): Promise<LlmResponse> {
    const run = this.queue.then(() => this.attempt(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  stats() {
    return {
      model: this.model,
      calls: this.calls,
      retries: this.retries,
      failures: this.failures,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
    };
  }

  private async attempt(request: LlmRequest): Promise<LlmResponse> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.calls++;
      try {
        const response = await this.inner.chat(request);
        this.promptTokens += response.usage.promptTokens;
        this.completionTokens += response.usage.completionTokens;
        return response;
      } catch (error) {
        if (!retryable(error) || attempt >= this.maxRetries) {
          this.failures++;
          throw error;
        }
        this.retries++;
        console.warn(`[eval llm] retry ${attempt + 1}: ${(error as Error).message}`);
        await sleep(this.retryMs * 2 ** attempt);
      }
    }
  }
}

function retryable(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false;
  return /HTTP (429|5\d\d)|could not be reached/.test(error.message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * About `size` items spread evenly over each group (at least one per group), in the original
 * order; all items when `size` is not set or not smaller than the set.
 */
export function sample<T>(
  items: readonly T[],
  groupOf: (item: T) => string,
  size = Number(process.env.AI_EVAL_SAMPLE ?? 0),
): T[] {
  if (!size || size >= items.length) return [...items];
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(groupOf(item), [...(groups.get(groupOf(item)) ?? []), item]);
  const picked = new Set<T>();
  for (const members of groups.values()) {
    const n = Math.max(1, Math.round((members.length * size) / items.length));
    for (let i = 0; i < n; i++) picked.add(members[Math.floor((i * members.length) / n)]!);
  }
  return items.filter((item) => picked.has(item));
}
