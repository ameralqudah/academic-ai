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
import type { AIRequest, ProviderName } from '@/ai/types';
import { isUsableApiKey } from '@/ai/key';
import type { PlanTier } from '@/agents/modes';
import {
  PREMIUM,
  candidateOverride,
  candidatesFor,
  requirementsFor,
  shouldFailOver,
  siblingModel,
  type ModelRequirements,
} from './model-requirements';
import { currentUserId, currentPreferredModel } from './request-scope';
import { resilient } from './resilient-provider';

export { candidateOverride, candidatesFor, requirementsFor, shouldFailOver, type ModelRequirements };

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
 * Providers whose key could actually be sent.
 *
 * "Has a value" was the test, and a placeholder passes it: a key field holding
 * descriptive text counted as a configured provider, so the router reported
 * two candidates, chose between them, and the chosen one then failed its own
 * `isConfigured()` and was silently swapped out. `isUsableApiKey` is the same
 * check the providers apply to themselves, so the router and the provider now
 * agree on what "configured" means.
 */
function usableProviders(): ProviderName[] {
  const env = getEnv();

  return ([
    ['anthropic', env.ANTHROPIC_API_KEY],
    ['openai', env.OPENAI_API_KEY],
    ['google', env.GOOGLE_AI_API_KEY],
  ] as const)
    .filter(([, key]) => isUsableApiKey(key))
    .map(([name]) => name);
}

/**
 * The plan of whoever this work is for, when that is known.
 *
 * Cached briefly: the router runs several times per message (classify, plan,
 * answer) and the plan does not change between those calls. Thirty seconds is
 * short enough that an upgrade is felt on the next message.
 */
const TIER_TTL_MS = 30_000;
const tierCache = new Map<string, { tier: PlanTier; at: number }>();

async function currentTier(): Promise<PlanTier | undefined> {
  const userId = currentUserId();
  if (!userId) return undefined;

  const cached = tierCache.get(userId);
  if (cached && Date.now() - cached.at < TIER_TTL_MS) return cached.tier;

  try {
    /* Imported here: the service reaches the database, and the router is
       loaded by modules that must stay importable without one. */
    const { tierFor } = await import('@/server/services/model-access.service');
    const tier = await tierFor(userId);
    tierCache.set(userId, { tier, at: Date.now() });
    if (tierCache.size > 500) tierCache.delete(tierCache.keys().next().value as string);
    return tier;
  } catch (error) {
    /* Routing must not fail because a plan lookup did. */
    logger.warn('model.tierLookupFailed', { error: String(error).slice(0, 200) });
    return undefined;
  }
}

/**
 * Passes the step's need for reasoning on to the provider.
 *
 * The router has always known which steps need a model to deliberate, and the
 * provider was never told — so a greeting was reasoned about for four seconds
 * before a word of it appeared. A caller that sets `reasoning` itself keeps its
 * choice.
 */
function tuned(provider: AIProvider, needsReasoning: boolean): AIProvider {
  const tune = (request: AIRequest): AIRequest =>
    request.reasoning === undefined ? { ...request, reasoning: needsReasoning } : request;

  return {
    name: provider.name,
    model: provider.model,
    isConfigured: () => provider.isConfigured(),
    complete: (request) => provider.complete(tune(request)),
    stream: (request) => provider.stream(tune(request)),
    countTokens: (text) => provider.countTokens(text),
    estimateCostMicroUsd: (usage) => provider.estimateCostMicroUsd(usage),
  };
}

/** Wraps a selection so a busy model is substituted, or failing that retried. */
function guarded(
  provider: AIProvider,
  needsReasoning: boolean,
  allowed?: ProviderName[],
): AIProvider {
  return resilient(tuned(provider, needsReasoning), async () => {
    const alternative = await alternativeProvider(provider.name, allowed, provider.model);
    return alternative ? tuned(alternative, needsReasoning) : null;
  });
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
  /*
   * A user's explicit choice wins. They were shown a model and told they could
   * use it; answering with a different one would leave them unable to say
   * which produced their result.
   */
  const preferred = options.preferred ?? currentPreferredModel();
  if (preferred) {
    const provider = await resolveProvider(preferred);

    return {
      provider: guarded(provider, requirements.needsReasoning),
      reason: `user selected ${preferred.provider}`,
      driver: 'only-option',
    };
  }

  /*
   * Which providers actually have keys. A model with no key is not a
   * candidate: routing to it would produce a decision that fails at the call,
   * which is worse than not having routed at all.
   */
  const tier = await currentTier();
  const { candidates: configured, premiumFirst } = candidatesFor(tier, usableProviders());

  if (configured.length <= 1) {
    /*
     * One candidate no longer means one configured provider: the plan filter
     * above narrows a free account to the economical model, and `resolveProvider`
     * asked for nothing in particular answers with the deployment's default —
     * which is the premium one. That combination routed every free account
     * straight back to the model this filtering exists to keep them off.
     *
     * So the default is only accepted when it is the candidate. When the two
     * disagree the candidate is named explicitly. Resolving the default first
     * rather than always naming the candidate keeps the admin's model override
     * for the ordinary one-provider deployment, where the two always agree.
     */
    const byDefault = await resolveProvider(null);
    const override = candidateOverride(configured, byDefault.name);

    const provider = override
      ? await resolveProvider({ provider: override, model: modelFor(override) })
      : byDefault;

    logger.info('model.selected', {
      capability: requirements.capability,
      provider: provider.name,
      model: provider.model,
      driver: 'only-option',
      tier: tier ?? 'unknown',
      needsReasoning: requirements.needsReasoning,
      contextTokens: requirements.contextTokens,
    });

    return {
      provider: guarded(provider, requirements.needsReasoning, configured),
      reason: 'the only provider this plan is routed to',
      driver: 'only-option',
    };
  }

  /*
   * More than one. The preference order below is a starting point, not a
   * benchmark: it says which provider to try first for a kind of work, and the
   * registry's own fallback handles a provider that turns out to be down.
   */
  const ranked = preferenceOrder(requirements, configured);
  const order = premiumFirst ? sortBy(ranked, [PREMIUM, ...ranked.filter((n) => n !== PREMIUM)]) : ranked;
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
    tier: tier ?? 'unknown',
    needsReasoning: requirements.needsReasoning,
    contextTokens: requirements.contextTokens,
    expectedOutputTokens: requirements.expectedOutputTokens,
  });

  return { provider: guarded(provider, requirements.needsReasoning, configured), reason: `${driver} for ${requirements.capability}`, driver };
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
export async function alternativeProvider(
  exclude: string,
  /** Restricts the substitute to what the caller's plan allows. */
  allowed?: ProviderName[],
  /** The model that failed, so its sibling can stand in when no other provider can. */
  failedModel?: string,
): Promise<AIProvider | null> {
  const alternatives = (allowed ?? usableProviders()).filter((name) => name !== exclude);

  const chosen = alternatives[0];
  if (chosen) return resolveProvider({ provider: chosen, model: modelFor(chosen) });

  /*
   * No other provider — the usual case, with one key configured. A second model
   * from the same provider is still a different pool of capacity, and "this
   * model is experiencing high demand" is about the model, not the account.
   */
  const sibling = siblingModel(exclude, failedModel, getEnv().GOOGLE_FALLBACK_MODEL);
  return sibling ? resolveProvider({ provider: exclude as ProviderName, model: sibling }) : null;
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

    const alternatives = usableProviders().filter((name) => name !== selection.provider.name);

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

