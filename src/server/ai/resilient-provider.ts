import type { AIProvider } from '@/ai/provider';
import type { AIChunk, AIRequest, AIResult, TokenUsage } from '@/ai/types';
import { logger } from '@/lib/logger';

import { shouldFailOver } from './model-requirements';

/**
 * A provider that survives the failures that are not the request's fault.
 *
 * The router picked a model and handed back the bare provider, and most callers
 * then called `provider.complete()` directly. `runCompletion` had failover, but
 * the intent classifier, the planner and the task handlers never went through
 * it — so one 503 from a busy model reached the user as "something went wrong"
 * with nothing attempted. Wrapping the provider where it is selected covers
 * every caller at once, including the ones written later.
 *
 * Two steps, in this order:
 *
 *  1. **Retry the same provider once, after a short pause.** "High demand" and
 *     rate spikes clear in seconds, and with a single configured provider this
 *     is the only recovery there is.
 *  2. **Move to the alternative**, when one is usable.
 *
 * Only provider-side failures qualify (`shouldFailOver`). A malformed request
 * or a refusal would fail identically on a second attempt, and retrying it
 * spends a call to receive the same answer.
 */
const RETRY_DELAY_MS = 1200;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function resilient(
  primary: AIProvider,
  alternative: () => Promise<AIProvider | null>,
  options: { retryDelayMs?: number } = {},
): AIProvider {
  const delay = options.retryDelayMs ?? RETRY_DELAY_MS;

  async function complete(request: AIRequest): Promise<AIResult> {
    try {
      return await primary.complete(request);
    } catch (first) {
      if (!shouldFailOver(first)) throw first;

      logger.warn('ai.retry', {
        provider: primary.name,
        model: primary.model,
        reason: String(first).slice(0, 200),
      });

      await sleep(delay);

      try {
        return await primary.complete(request);
      } catch (second) {
        if (!shouldFailOver(second)) throw second;

        const fallback = await alternative();
        if (!fallback) throw second;

        logger.warn('ai.failover', {
          from: primary.name,
          to: fallback.name,
          reason: String(second).slice(0, 200),
        });

        return fallback.complete(request);
      }
    }
  }

  /*
   * A stream can only be restarted while nothing has been shown. Once the first
   * chunk has gone out, a second attempt would repeat text the reader already
   * has, so from that point a failure is passed through as it is.
   */
  async function* stream(request: AIRequest): AsyncGenerator<AIChunk> {
    const attempts: (() => Promise<AIProvider | null>)[] = [
      async () => primary,
      async () => {
        await sleep(delay);
        return primary;
      },
      alternative,
    ];

    let lastError: unknown;

    for (const next of attempts) {
      const provider = await next();
      if (!provider) break;

      let started = false;

      try {
        for await (const chunk of provider.stream(request)) {
          started = true;
          yield chunk;
        }
        return;
      } catch (error) {
        if (started || !shouldFailOver(error)) throw error;

        lastError = error;
        logger.warn('ai.stream.retry', {
          provider: provider.name,
          reason: String(error).slice(0, 200),
        });
      }
    }

    throw lastError;
  }

  return {
    name: primary.name,
    model: primary.model,
    isConfigured: () => primary.isConfigured(),
    complete,
    stream,
    countTokens: (text: string) => primary.countTokens(text),
    estimateCostMicroUsd: (usage: TokenUsage) => primary.estimateCostMicroUsd(usage),
  };
}
