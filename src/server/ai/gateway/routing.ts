/**
 * Model routing (P1-B §2.3). Pure: given the plan tier, what is configured and
 * what the call needs, it returns one observable decision — the model to use
 * and the substitutes that are allowed if it fails.
 *
 * Invariants (each tested):
 * - Nothing outside the entitlement is ever chosen or used as a substitute.
 * - A substitute is never of a higher class than the model first chosen.
 * - A model the user explicitly chose is never swapped for another provider;
 *   only retried.
 * - An unknown tier is routed as `free`.
 */

import type { ModelClass, Provider, RoutingDecision } from './contract';
import { GatewayError } from './errors';

export type Tier = 'free' | 'paid' | 'admin';

const CLASS_RANK: Record<ModelClass, number> = { economy: 1, standard: 2, premium: 3 };

/** What each tier may use. The premium class is what the paid plan pays for. */
export const ENTITLEMENT: Record<Tier, ModelClass> = { free: 'standard', paid: 'premium', admin: 'premium' };

/** The class of a model. One table, so changing a model's class is a one-line change. */
export function modelClass(provider: Provider, model: string): ModelClass {
  /* Every Anthropic model is premium, matching the plan's model list (`modesFor`), so the picker and the router agree. */
  if (provider === 'anthropic') return 'premium';
  if (provider === 'google') return /flash|lite/i.test(model) ? 'economy' : 'standard';
  return /mini|nano/i.test(model) ? 'economy' : 'standard';
}

export interface ConfiguredModel {
  provider: Provider;
  model: string;
}

export interface RoutingInput {
  tier: Tier | undefined;
  configured: ConfiguredModel[];
  /** The deployment's default provider (admin setting, then AI_PROVIDER). */
  defaultProvider: Provider;
  requested?: ConfiguredModel | null;
  needsReasoning: boolean;
  latencySensitive: boolean;
  contextTokens: number;
  /** A second model of the same provider that may stand in for an overloaded one (Google). */
  siblingModels?: Partial<Record<Provider, string>>;
}

const within = (candidate: ModelClass, ceiling: ModelClass) => CLASS_RANK[candidate] <= CLASS_RANK[ceiling];

function order(input: RoutingInput, pool: ConfiguredModel[], premiumFirst: boolean): ConfiguredModel[] {
  const rank = (preference: Provider[]) =>
    [...pool].sort((a, b) => preference.indexOf(a.provider) - preference.indexOf(b.provider));
  let ranked: ConfiguredModel[];
  if (input.contextTokens > 100_000) ranked = rank(['google', 'anthropic', 'openai']);
  else if (input.needsReasoning) ranked = rank(['anthropic', 'openai', 'google']);
  else if (input.latencySensitive) ranked = rank(['google', 'openai', 'anthropic']);
  else {
    /* The deployment's default first, then the rest in their configured order. */
    ranked = [...pool].sort((a, b) => Number(b.provider === input.defaultProvider) - Number(a.provider === input.defaultProvider));
  }
  if (premiumFirst) {
    ranked = [...ranked].sort((a, b) => Number(modelClass(b.provider, b.model) === 'premium') - Number(modelClass(a.provider, a.model) === 'premium'));
  }
  return ranked;
}

/** `GatewayError.detail` when no configured model is inside the plan (as opposed to a requested model outside it). */
export const NO_ELIGIBLE_MODEL = 'no_eligible_model';

export function route(input: RoutingInput): RoutingDecision {
  const tier: Tier = input.tier ?? 'free';
  const ceiling = ENTITLEMENT[tier];
  const withClass = (m: ConfiguredModel) => ({ ...m, modelClass: modelClass(m.provider, m.model) });

  if (input.configured.length === 0) {
    throw new GatewayError('not_configured', 'No AI provider is configured.');
  }

  const pool = input.configured.filter((m) => within(modelClass(m.provider, m.model), ceiling));
  const reason = 'entitled';
  if (pool.length === 0) {
    /*
     * No configured model is inside this plan (a deployment whose only model is
     * premium, seen by a free user). Refused, never served with a model the
     * plan does not include: a premium model is never a fallback.
     */
    throw new GatewayError('entitlement', 'No eligible model for this plan.', { detail: NO_ELIGIBLE_MODEL });
  }

  if (input.requested) {
    const requested = input.requested;
    const allowed = pool.find((m) => m.provider === requested.provider && m.model === requested.model);
    if (!allowed) {
      throw new GatewayError('entitlement', 'The requested model is not available on this plan.');
    }
    return { tier, requested, chosen: withClass(allowed), fallbacks: [], reason: 'user_selected' };
  }

  const ranked = order(input, pool, tier !== 'free');
  const chosen = withClass(ranked[0]!);
  const fallbacks = ranked
    .slice(1)
    .map(withClass)
    .filter((m) => within(m.modelClass, chosen.modelClass));
  const sibling = input.siblingModels?.[chosen.provider];
  if (sibling && sibling !== chosen.model) {
    const candidate = withClass({ provider: chosen.provider, model: sibling });
    if (within(candidate.modelClass, chosen.modelClass) && within(candidate.modelClass, ceiling)) fallbacks.push(candidate);
  }

  const driver =
    input.contextTokens > 100_000 ? 'context_size' : input.needsReasoning ? 'reasoning' : input.latencySensitive ? 'latency' : 'default';
  return { tier, requested: null, chosen, fallbacks, reason: `${reason}:${driver}` };
}
