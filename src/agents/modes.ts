/**
 * Modes and models.
 *
 * One configuration layer for both, so that adding a mode is an entry in a table
 * rather than a branch in the orchestrator, a case in the API route, and a
 * condition in the composer. The requirement was explicit — do not duplicate the
 * backend logic for each mode — and a shared table is how that holds as the list
 * grows.
 *
 * **Model access is decided here and enforced on the server.** The composer may
 * only offer what `modelsFor` returns, but a request naming a model outside the
 * caller's plan is rejected in the API regardless of what the interface showed.
 * A restriction that lives only in the client is not a restriction: the request
 * is a POST body, and anyone can change one.
 */

import { getEnv } from '@/config/env';

import type { IntentKey } from './registry';

/* -------------------------------------------------------------------------- */
/*                                   Modes                                    */
/* -------------------------------------------------------------------------- */

export type ModeKey = 'chat' | 'academic' | 'webSearch' | 'deepResearch' | 'dataAnalysis';

export interface ModeConfig {
  key: ModeKey;
  /** Built and callable, or recognised and coming. */
  available: boolean;
  /** Needs a file in the conversation before it can do anything. */
  requiresDataset: boolean;
  /**
   * Intents this mode is allowed to reach.
   *
   * A hint rather than a hard filter: the classifier still decides what the
   * user asked for, and a person in Academic mode who asks to clean their data
   * should have their data cleaned rather than be told they are in the wrong
   * tab. The mode narrows what the composer suggests and how the request is
   * framed, not what the agent may do.
   */
  intents: IntentKey[];
  /** Message key for the "why not yet" note on an unavailable mode. */
  unavailableReason?: string;
}

/**
 * Whether a web search key is configured.
 *
 * Reads the environment directly rather than asking the web search service.
 * That import looked tidier and pulled the service — and through it the
 * database — into this module, which the agent catalogue and the smoke tests
 * load without a database. The result was a test suite that could not start.
 *
 * A configuration table should depend on configuration, not on the services it
 * describes.
 */
function hasWebSearchKey(): boolean {
  try {
    return Boolean(getEnv().SERPER_API_KEY);
  } catch {
    return false;
  }
}

export const MODES: Record<ModeKey, ModeConfig> = {
  chat: {
    key: 'chat',
    available: true,
    requiresDataset: false,
    intents: ['general.question', 'research.plan', 'research.section'],
  },
  academic: {
    key: 'academic',
    available: true,
    requiresDataset: false,
    intents: ['research.literature', 'research.results'],
  },
  dataAnalysis: {
    key: 'dataAnalysis',
    available: true,
    requiresDataset: true,
    intents: [
      'data.inspect',
      'data.clean',
      'data.describe',
      'stats.recommend',
      'stats.reliability',
      'stats.compare',
      'stats.relate',
      'stats.predict',
      'stats.categorical',
    ],
  },
  /**
   * Built, and available when a search provider is configured.
   *
   * `available` is computed rather than declared, because whether this works
   * depends on a key that may or may not be set on a given deployment. Hard-
   * coding `true` would offer a mode that fails on first use; hard-coding
   * `false` would keep it hidden after someone configured it.
   */
  webSearch: {
    key: 'webSearch',
    available: hasWebSearchKey(),
    requiresDataset: false,
    intents: ['research.web'],
    unavailableReason: 'mode.unavailable.webSearchKey',
  },
  /**
   * Deep research needs both web and academic search, so it follows the same
   * configuration. Academic search works without a key; web search does not,
   * and a deep review that cannot reach the web is a literature search under
   * another name.
   */
  deepResearch: {
    key: 'deepResearch',
    available: hasWebSearchKey(),
    requiresDataset: false,
    intents: ['research.deep'],
    unavailableReason: 'mode.unavailable.webSearchKey',
  },
};

export const MODE_KEYS = Object.keys(MODES) as ModeKey[];

export function availableModes(): ModeConfig[] {
  return MODE_KEYS.map((key) => MODES[key]).filter((mode) => mode.available);
}

export function isKnownMode(value: string): value is ModeKey {
  return value in MODES;
}

/* -------------------------------------------------------------------------- */
/*                                   Models                                   */
/* -------------------------------------------------------------------------- */

export interface ModelOption {
  /** `google:gemini-2.5-pro` — provider and model, so the id is unambiguous. */
  id: string;
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
  /** The one used when the caller names none. */
  isDefault: boolean;
}

export type PlanTier = 'free' | 'paid' | 'admin';

/**
 * Models that are actually usable, discovered from the configured keys.
 *
 * Discovered rather than listed, because a hard-coded catalogue would offer a
 * model whose provider has no key and fail at the moment of use. What is
 * configured is what exists.
 */
export function configuredModels(): ModelOption[] {
  /*
   * Read defensively. `getEnv()` validates the whole environment at once and
   * throws when the database URL or auth secret is missing — and which AI models
   * are configured has nothing to do with either. The same coupling broke the
   * knowledge providers and the production build before it was caught there;
   * this is the third place it would have.
   *
   * No environment means no configured models, which is a correct answer rather
   * than a crash.
   */
  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch {
    return [];
  }

  const options: ModelOption[] = [];

  if (env.ANTHROPIC_API_KEY) {
    options.push({
      id: `anthropic:${env.ANTHROPIC_MODEL}`,
      provider: 'anthropic',
      model: env.ANTHROPIC_MODEL,
      isDefault: false,
    });
  }
  if (env.OPENAI_API_KEY) {
    options.push({
      id: `openai:${env.OPENAI_MODEL}`,
      provider: 'openai',
      model: env.OPENAI_MODEL,
      isDefault: false,
    });
  }
  if (env.GOOGLE_AI_API_KEY) {
    options.push({
      id: `google:${env.GOOGLE_MODEL}`,
      provider: 'google',
      model: env.GOOGLE_MODEL,
      isDefault: false,
    });
  }

  /*
   * The default is the provider the admin selected, or the first configured one.
   * Marking it matters because a free user gets exactly this and nothing else,
   * so which model it is decides what most people experience.
   */
  const preferred = env.AI_PROVIDER;
  const defaultIndex = options.findIndex((option) => option.provider === preferred);
  const chosen = defaultIndex >= 0 ? defaultIndex : 0;
  if (options[chosen]) options[chosen] = { ...(options[chosen] as ModelOption), isDefault: true };

  return options;
}

/**
 * What a given tier may use.
 *
 * Free gets the default and nothing else — a free account choosing the most
 * expensive model available is a bill the product pays and the user does not.
 * Paid gets everything configured. Admin the same, explicitly, so the intent is
 * stated rather than inherited.
 */
export function modelsFor(tier: PlanTier): ModelOption[] {
  const all = configuredModels();

  if (tier === 'free') {
    const fallback = all[0];
    const preferred = all.find((option) => option.isDefault) ?? fallback;
    return preferred ? [preferred] : [];
  }

  return all;
}

/**
 * Whether a request may use the model it named.
 *
 * The server's answer, and the only one that counts. The composer offers what
 * `modelsFor` returns, but the request is a POST body and a POST body can say
 * anything — so the same question is asked again here, where the caller cannot
 * reach.
 */
export function canUseModel(tier: PlanTier, modelId: string): boolean {
  return modelsFor(tier).some((option) => option.id === modelId);
}

/** Splits `google:gemini-2.5-pro` back into its parts. Null when malformed. */
export function parseModelId(
  modelId: string,
): { provider: ModelOption['provider']; model: string } | null {
  const separator = modelId.indexOf(':');
  if (separator <= 0) return null;

  const provider = modelId.slice(0, separator);
  const model = modelId.slice(separator + 1);

  if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'google') return null;
  if (model.length === 0) return null;

  return { provider, model };
}

/**
 * Whether the model selector is worth showing.
 *
 * One option is not a choice, and a dropdown containing it is furniture that
 * implies a decision the user does not have. The selector appears on its own the
 * day a second provider key is configured, with no code change — which is why
 * this is computed rather than set.
 */
export function shouldOfferModelChoice(tier: PlanTier): boolean {
  return modelsFor(tier).length > 1;
}
