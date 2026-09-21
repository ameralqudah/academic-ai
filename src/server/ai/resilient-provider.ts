import type { AIProvider } from '@/ai/provider';
import type { AIChunk, AIRequest, AIResult, TokenUsage } from '@/ai/types';
import { logger } from '@/lib/logger';

import { shouldFailOver } from './model-requirements';
import { notify } from './notices';

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
 *  1. **Move to the alternative**, when one is usable — another provider, or a
 *     second model from the same one.
 *  2. **Retry the first once, after a short pause.** With nothing to move to,
 *     this is the only recovery there is; with something to move to, it is the
 *     last resort.
 *
 * The order was the other way round, and a live failure showed why it should
 * not be: a model under "high demand" took eight seconds to say so, was asked
 * again, took eight more, and only then was anything else considered. Waiting
 * on the model that has just reported it is overloaded is the slow path.
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

      const fallback = await alternative();

      if (fallback) {
        notify({ kind: 'failover' });
        logger.warn('ai.failover', {
          from: `${primary.name}:${primary.model}`,
          to: `${fallback.name}:${fallback.model}`,
          reason: String(first).slice(0, 200),
        });

        try {
          return await fallback.complete(request);
        } catch (second) {
          if (!shouldFailOver(second)) throw second;
          /* Both are struggling. One more try at the first, below. */
        }
      }

      notify({ kind: 'retry' });
      logger.warn('ai.retry', {
        provider: primary.name,
        model: primary.model,
        reason: String(first).slice(0, 200),
      });

      await sleep(delay);
      return primary.complete(request);
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
      alternative,
      async () => {
        await sleep(delay);
        return primary;
      },
    ];

    let lastError: unknown;

    for (const next of attempts) {
      const provider = await next();
      /* No alternative configured: skip that step, the delayed retry still follows. */
      if (!provider) continue;

      let started = false;

      try {
        for await (const chunk of provider.stream(request)) {
          started = true;
          /* Named on the way out, so usage is recorded against the model that did the work. */
          yield provider === primary ? chunk : { ...chunk, model: provider.model };
        }
        return;
      } catch (error) {
        if (started || !shouldFailOver(error)) throw error;

        lastError = error;
        notify({ kind: 'retry' });
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
