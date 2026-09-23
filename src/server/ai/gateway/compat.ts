/**
 * The strangler: the application's existing `AIProvider` interface, served by
 * the Model Gateway (P1-B step B4).
 *
 * Call sites keep calling `provider.complete()` / `provider.stream()`; every
 * such call now goes through the gateway — entitlement routing, quota
 * reservation, timeouts, bounded retries, failover and durable metering. No
 * `AIProvider` implementation talks to a vendor any more; the adapters behind
 * the gateway are the only code that does.
 *
 * `name` and `model` describe the routing decision the gateway would make now
 * (for logs and labels); the model that actually served a call is on each
 * result (`AIResult.model`, `AIChunk.model`).
 */

import { estimateTokens, type AIProvider } from '@/ai/provider';
import type { AIChunk, AIRequest, AIResult, ProviderName } from '@/ai/types';

import type { GatewayRequestInput } from './contract';
import { GatewayError, toAppError } from './errors';
import type { ModelGateway } from './gateway';
import { attemptCost } from './metering';

export interface RoutingHints {
  needsReasoning: boolean;
  latencySensitive: boolean;
  requested?: { provider: ProviderName; model: string } | null;
  /** What the gateway would choose now, for `name` / `model`. */
  predicted: { provider: ProviderName; model: string };
  configured: boolean;
}

function toGatewayRequest(request: AIRequest, hints: RoutingHints): GatewayRequestInput {
  return {
    purpose: request.task,
    system: request.system,
    messages: request.messages,
    maxOutputTokens: request.maxTokens ?? 4096,
    temperature: request.temperature ?? 0.7,
    /* The step's need for deliberation, unless the caller set it (the legacy `tuned()` rule). */
    reasoning: request.reasoning ?? hints.needsReasoning,
    cacheSystem: request.cacheSystem ?? true,
    jsonMode: request.json ?? false,
    requested: hints.requested ?? null,
    needsReasoning: hints.needsReasoning,
    latencySensitive: hints.latencySensitive,
    countsAsRequest: request.countsAsRequest ?? true,
    continuation: request.continuation ?? false,
    ...(request.estimatedWords === undefined ? {} : { estimatedWords: request.estimatedWords }),
    ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
  };
}

/** Gateway errors reach the application as sanitised `AppError`s — never a provider body. */
function rethrow(error: unknown): never {
  if (error instanceof GatewayError) throw toAppError(error);
  throw error;
}

export function gatewayProvider(gateway: () => ModelGateway, hints: RoutingHints): AIProvider {
  return {
    name: hints.predicted.provider,
    model: hints.predicted.model,
    isConfigured: () => hints.configured,
    countTokens: (text) => estimateTokens(text),
    estimateCostMicroUsd: (usage) =>
      attemptCost(hints.predicted.model, {
        inputTokens: usage.tokensIn,
        outputTokens: usage.tokensOut,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        estimated: false,
      }),

    async complete(request: AIRequest): Promise<AIResult> {
      try {
        const response = await gateway().generate(toGatewayRequest(request, hints), {
          signal: request.signal,
          ids: { projectId: request.projectId ?? null },
          ...(request.longForm ? { timeoutKind: 'longForm' as const } : {}),
        });
        return {
          text: response.text,
          usage: {
            tokensIn: response.usage.inputTokens,
            tokensOut: response.usage.outputTokens,
            cacheReadTokens: response.usage.cacheReadTokens,
            cacheWriteTokens: response.usage.cacheWriteTokens,
          },
          provider: response.provider,
          model: response.model,
          stopReason: response.finishReason,
        };
      } catch (error) {
        rethrow(error);
      }
    },

    async *stream(request: AIRequest): AsyncIterable<AIChunk> {
      try {
        for await (const event of gateway().stream(toGatewayRequest(request, hints), { signal: request.signal, ids: { projectId: request.projectId ?? null } })) {
          if (event.type === 'text_delta') yield { delta: event.text, done: false };
          else if (event.type === 'done') {
            yield {
              delta: '',
              done: true,
              model: event.response.model,
              usage: {
                tokensIn: event.response.usage.inputTokens,
                tokensOut: event.response.usage.outputTokens,
                cacheReadTokens: event.response.usage.cacheReadTokens,
                cacheWriteTokens: event.response.usage.cacheWriteTokens,
              },
            };
          }
        }
      } catch (error) {
        rethrow(error);
      }
    },
  };
}
