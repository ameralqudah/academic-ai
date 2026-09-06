/**
 * Choosing which model runs a step.
 *
 * The planner decides *what* capability is needed. This decides *which* model
 * executes it — a separate question with different inputs, and one that was
 * previously answered by a single environment variable for every call in the
 * product.
 *
 * That worked while one provider was configured and stopped being adequate the
 * moment a task mixed a one-line classification with a chapter of prose: the
 * two have different context sizes, different latency tolerances and different
 * costs, and sending both to the same model means overpaying for one or
 * underserving the other.
 *
 * **This does not choose capabilities.** It is given a step that has already
 * been planned and says which model should run it. Letting it decide what to
 * run would make it a second planner, disagreeing with the first.
 *
 * **Nothing here invents a provider.** The candidates come from the registry,
 * which reads configured keys — a model with no key is not a candidate, and
 * pretending otherwise would produce a routing decision that fails at the call.
 */

import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';
import type { AIProvider } from '@/ai/provider';
import { resolveProvider } from '@/ai/registry';
import type { ProviderName } from '@/ai/types';
import { requirementsFor, shouldFailOver, type ModelRequirements } from './model-requirements';

export { requirementsFor, shouldFailOver, type ModelRequirements };

export interface ModelSelection {
  provider: AIProvider;
  /**
   * Why this was chosen, for the log.
   *
   * A routing decision that cannot be explained cannot be debugged, and the
   * failure mode — an answer that is worse than it should be — leaves no trace
   * of its own. Never contains a key or any part of one.
   */
  reason: string;
  /** Which requirement drove the choice, where one did. */
  driver: 'only-option' | 'reasoning' | 'context-size' | 'latency' | 'default';
}

/**
 * Picks a model for a step.
 *
 * Today this resolves to the configured provider in nearly every case, because
 * a deployment typically has one key. That is the honest state of it: the
 * abstraction is real and the routing inputs are real, and when a second
 * provider is configured the preferences below start to select between them
 * rather than being inert.
 */
export async function selectModel(
  requirements: ModelRequirements,
  options: { preferred?: { provider: ProviderName; model: string } | null } = {},
): Promise<ModelSelection> {
  const env = getEnv();

  /*
   * A user's explicit choice wins. They were shown a model and told they could
   * use it; answering with a different one would leave them unable to say
   * which produced their result.
   */
  if (options.preferred) {
    const provider = await resolveProvider(options.preferred);

    return {
      provider,
      reason: `user selected ${options.preferred.provider}`,
      driver: 'only-option',
    };
  }

  /*
   * Which providers actually have keys. A model with no key is not a
   * candidate: routing to it would produce a decision that fails at the call,
   * which is worse than not having routed at all.
   */
  const configured = ([
    ['anthropic', env.ANTHROPIC_API_KEY],
    ['openai', env.OPENAI_API_KEY],
    ['google', env.GOOGLE_AI_API_KEY],
  ] as const)
    .filter(([, key]) => typeof key === 'string' && key.trim().length > 0)
    .map(([name]) => name);

  /*
   * One provider, which is the usual case. The requirements are still computed
   * and logged — they are what makes the next provider useful the day it is
   * added, and a router that stopped computing them would have to be rebuilt.
   */
  if (configured.length <= 1) {
    const provider = await resolveProvider(null);

    logger.info('model.selected', {
      capability: requirements.capability,
      provider: provider.name,
      model: provider.model,
      driver: 'only-option',
      needsReasoning: requirements.needsReasoning,
      contextTokens: requirements.contextTokens,
    });

    return {
      provider,
      reason: 'the only configured provider',
      driver: 'only-option',
    };
  }

  /*
   * More than one. The preference order below is a starting point, not a
   * benchmark: it says which provider to try first for a kind of work, and the
   * registry's own fallback handles a provider that turns out to be down.
   */
  const order = preferenceOrder(requirements, configured);
  const chosen = order[0] ?? configured[0];

  const provider = await resolveProvider(
    chosen ? { provider: chosen, model: modelFor(chosen) } : null,
  );

  const driver = requirements.needsReasoning
    ? 'reasoning'
    : requirements.contextTokens > 50_000
      ? 'context-size'
      : requirements.latencySensitive
        ? 'latency'
        : 'default';

  logger.info('model.selected', {
    capability: requirements.capability,
    provider: provider.name,
    model: provider.model,
    driver,
    candidates: configured.length,
    needsReasoning: requirements.needsReasoning,
    contextTokens: requirements.contextTokens,
    expectedOutputTokens: requirements.expectedOutputTokens,
  });

  return { provider, reason: `${driver} for ${requirements.capability}`, driver };
}

/**
 * Which provider to try first, given what the step needs.
 *
 * Deliberately coarse. A finer ranking would need measurements this deployment
 * does not have, and inventing one would encode a guess as though it were
 * knowledge.
 */
function preferenceOrder(
  requirements: ModelRequirements,
  configured: ProviderName[],
): ProviderName[] {
  /*
   * A very large context narrows the field to models that can hold it. Sending
   * eighty thousand tokens to a model that truncates at thirty is not a slower
   * answer, it is a wrong one built from part of the evidence.
   */
  if (requirements.contextTokens > 100_000) {
    return sortBy(configured, ['google', 'anthropic', 'openai']);
  }

  if (requirements.needsReasoning) {
    return sortBy(configured, ['anthropic', 'openai', 'google']);
  }

  /* Short, fast work where the researcher is waiting. */
  if (requirements.latencySensitive) {
    return sortBy(configured, ['google', 'openai', 'anthropic']);
  }

  return configured;
}

function sortBy(available: ProviderName[], preference: ProviderName[]): ProviderName[] {
  return [...available].sort((a, b) => preference.indexOf(a) - preference.indexOf(b));
}

/** The configured model for a provider. Names live in the environment, not here. */
function modelFor(provider: ProviderName): string {
  const env = getEnv();

  return provider === 'anthropic'
    ? env.ANTHROPIC_MODEL
    : provider === 'openai'
      ? env.OPENAI_MODEL
      : env.GOOGLE_MODEL;
}

/**
 * Another configured provider, if there is one.
 *
 * Exported so the AI service can fail over at the single point every model
 * call passes through, rather than each caller doing it — the choice of which
 * provider belongs here, and the sequencing belongs there.
 */
export async function alternativeProvider(exclude: string): Promise<AIProvider | null> {
  const env = getEnv();

  const alternatives = ([
    ['anthropic', env.ANTHROPIC_API_KEY],
    ['openai', env.OPENAI_API_KEY],
    ['google', env.GOOGLE_AI_API_KEY],
  ] as const)
    .filter(
      ([name, key]) =>
        name !== exclude && typeof key === 'string' && key.trim().length > 0,
    )
    .map(([name]) => name);

  const chosen = alternatives[0];
  if (!chosen) return null;

  return resolveProvider({ provider: chosen, model: modelFor(chosen) });
}

/**
 * Runs a call, moving to another provider when the first one fails for its own
 * reasons.
 *
 * Only one alternative is tried. A chain of fallbacks turns a provider outage
 * into a long wait followed by a failure, and the researcher would rather be
 * told quickly.
 */
export async function withFailover<T>(
  requirements: ModelRequirements,
  run: (provider: AIProvider) => Promise<T>,
  options: { preferred?: { provider: ProviderName; model: string } | null } = {},
): Promise<T> {
  const selection = await selectModel(requirements, options);

  try {
    return await run(selection.provider);
  } catch (error) {
    if (!shouldFailOver(error)) throw error;

    const env = getEnv();

    const alternatives = ([
      ['anthropic', env.ANTHROPIC_API_KEY],
      ['openai', env.OPENAI_API_KEY],
      ['google', env.GOOGLE_AI_API_KEY],
    ] as const)
      .filter(([name, key]) => name !== selection.provider.name && typeof key === 'string' && key.trim().length > 0)
      .map(([name]) => name);

    const alternative = alternatives[0];

    /*
     * Nothing to fall over to. The original error is thrown rather than a
     * wrapper: the service layer already turns a provider failure into a
     * message that names the cause, and re-wrapping would hide it.
     */
    if (!alternative) throw error;

    logger.warn('model.failover', {
      capability: requirements.capability,
      from: selection.provider.name,
      to: alternative,
      reason: String(error).slice(0, 200),
    });

    const fallback = await resolveProvider({
      provider: alternative,
      model: modelFor(alternative),
    });

    return run(fallback);
  }
}

