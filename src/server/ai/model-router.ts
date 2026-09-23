/**
 * Choosing which model runs a step.
 *
 * The planner decides *what* capability is needed. This turns the step's
 * requirements into routing hints for the Model Gateway (P1-B), which makes
 * the actual decision — inside the user's plan entitlement, looked up from the
 * user id on every call — and owns timeouts, retries, failover and metering.
 *
 * **This does not choose capabilities**, and since P1-B it does not choose
 * providers either: two routers would disagree. What it returns is an
 * `AIProvider` whose every call goes through the gateway.
 *
 * **Nothing here invents a provider.** Which models exist is read from the
 * environment by the gateway (`gateway/index.ts`), filtered by the same
 * `isUsableApiKey` rule the adapters apply to themselves.
 */

import type { AIProvider } from '@/ai/provider';
import type { ProviderName } from '@/ai/types';
import { logger } from '@/lib/logger';

import { gatewayProvider } from './gateway/compat';
import { gateway, predictRoute } from './gateway';
import { requirementsFor, type ModelRequirements } from './model-requirements';
import { currentPreferredModel } from './request-scope';

export { requirementsFor, type ModelRequirements };

export interface ModelSelection {
  provider: AIProvider;
  /**
   * Why this was chosen, for the log. A routing decision that cannot be
   * explained cannot be debugged. Never contains a key or any part of one.
   */
  reason: string;
  /** Which requirement drove the choice, where one did. */
  driver: 'only-option' | 'reasoning' | 'context-size' | 'latency' | 'default';
}

/**
 * A gateway-backed provider for a step.
 *
 * A user's explicit choice (already checked against their plan by
 * `resolveRequestedModel`) is passed to the gateway, which checks it against
 * the entitlement again and never swaps it for another provider.
 */
export async function selectModel(
  requirements: ModelRequirements,
  options: { preferred?: { provider: ProviderName; model: string } | null } = {},
): Promise<ModelSelection> {
  const preferred = options.preferred ?? currentPreferredModel();
  const predicted = await predictRoute({
    needsReasoning: requirements.needsReasoning,
    latencySensitive: requirements.latencySensitive,
    contextTokens: requirements.contextTokens,
    requested: preferred,
  });

  const driver: ModelSelection['driver'] = preferred
    ? 'only-option'
    : requirements.contextTokens > 100_000
      ? 'context-size'
      : requirements.needsReasoning
        ? 'reasoning'
        : requirements.latencySensitive
          ? 'latency'
          : 'default';

  logger.info('model.selected', {
    capability: requirements.capability,
    provider: predicted.provider,
    model: predicted.model,
    driver,
    needsReasoning: requirements.needsReasoning,
    contextTokens: requirements.contextTokens,
  });

  return {
    provider: gatewayProvider(gateway, {
      needsReasoning: requirements.needsReasoning,
      latencySensitive: requirements.latencySensitive,
      requested: preferred,
      predicted,
      configured: predicted.configured,
    }),
    reason: preferred ? `user selected ${preferred.provider}` : `${driver} for ${requirements.capability}`,
    driver,
  };
}
