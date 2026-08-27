import type { AIChunk, AIRequest, AIResult, ProviderName, TokenUsage } from './types';

/**
 * The one contract the application knows about.
 *
 * Everything above this line (services, routes, UI) speaks only `AIRequest` /
 * `AIResult`. Everything below it is vendor-specific and lives in `providers/`.
 * Swapping vendors is a change to `AI_PROVIDER` — never to application code.
 */
export interface AIProvider {
  readonly name: ProviderName;
  readonly model: string;

  /** True when an API key is configured; used to fail fast with a clear message. */
  isConfigured(): boolean;

  complete(request: AIRequest): Promise<AIResult>;
  stream(request: AIRequest): AsyncIterable<AIChunk>;

  /**
   * Rough token estimate used for pre-flight quota checks only.
   * Billing always uses the counts the vendor returns.
   */
  countTokens(text: string): number;

  estimateCostMicroUsd(usage: TokenUsage): number;
}

/**
 * Arabic averages fewer tokens per character than English on modern tokenizers,
 * but both are far from the naive `length / 4`. This estimate is deliberately
 * conservative — it is only used to decide whether to allow a request.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const arabicChars = (text.match(/[؀-ۿ]/g) ?? []).length;
  const otherChars = text.length - arabicChars;
  return Math.ceil(arabicChars / 2.2 + otherChars / 3.6);
}

/** Shared SSE line reader — every vendor streams `data: …` lines. */
export async function* readSSE(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload && payload !== '[DONE]') yield payload;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
