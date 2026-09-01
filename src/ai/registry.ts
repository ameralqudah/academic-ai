import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';
import { getSetting } from '@/server/repositories/app-settings.repository';

import type { AIProvider } from './provider';
import { AnthropicProvider } from './providers/anthropic';
import { GoogleProvider } from './providers/google';
import { OpenAIProvider } from './providers/openai';
import type { ProviderName } from './types';

export const AI_SETTINGS_KEY = 'ai';

export interface AISettings {
  provider: ProviderName;
  models?: Partial<Record<ProviderName, string>>;
}

/**
 * Admin overrides are read from the database but cached briefly — an AI request
 * should not pay for an extra round trip, and a provider switch tolerating a
 * minute of delay is fine.
 */
const CACHE_TTL_MS = 60_000;
let cached: { settings: AISettings | null; at: number } | null = null;

async function loadSettings(): Promise<AISettings | null> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.settings;

  let settings: AISettings | null = null;
  try {
    settings = await getSetting<AISettings>(AI_SETTINGS_KEY);
  } catch (error) {
    logger.warn('ai.settings.unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  cached = { settings, at: now };
  return settings;
}

export function invalidateProviderCache(): void {
  cached = null;
}

function build(name: ProviderName, modelOverride?: string): AIProvider {
  const env = getEnv();

  switch (name) {
    case 'openai':
      return new OpenAIProvider(env.OPENAI_API_KEY ?? '', modelOverride ?? env.OPENAI_MODEL);
    case 'google':
      return new GoogleProvider(env.GOOGLE_AI_API_KEY ?? '', modelOverride ?? env.GOOGLE_MODEL);
    case 'anthropic':
    default:
      return new AnthropicProvider(
        env.ANTHROPIC_API_KEY ?? '',
        modelOverride ?? env.ANTHROPIC_MODEL,
      );
  }
}

/**
 * Resolution order: the caller's choice → admin setting → environment → anthropic.
 *
 * The caller's choice comes first because it is the user's, and it has already
 * been checked against their plan by `resolveRequestedModel` — this function
 * does not re-check, and must never be passed a choice that has not been.
 *
 * If the chosen provider has no key, fall back to any provider that does, so a
 * misconfigured override degrades instead of taking the product down.
 */
export async function resolveProvider(
  /**
   * A provider and model the user selected.
   *
   * The selection was being validated in the API route and then discarded —
   * `await resolveRequestedModel(...)` with no assignment. A user could pick a
   * model, be told they were entitled to it, and receive an answer from a
   * different one. Threading it through is what makes the selector mean
   * something.
   */
  chosen?: { provider: ProviderName; model: string } | null,
): Promise<AIProvider> {
  const env = getEnv();
  const settings = await loadSettings();

  if (chosen) {
    const selected = build(chosen.provider, chosen.model);

    /*
     * Falls through to the default when the chosen provider has no key. That
     * combination should not occur — the model list is built from configured
     * keys — but a key removed between the list being served and the request
     * arriving would otherwise fail the request rather than answering it.
     */
    if (selected.isConfigured()) return selected;

    logger.warn('ai.provider.chosenUnavailable', {
      provider: chosen.provider,
      model: chosen.model,
    });
  }

  const preferred = settings?.provider ?? env.AI_PROVIDER;
  const primary = build(preferred, settings?.models?.[preferred]);
  if (primary.isConfigured()) return primary;

  const alternatives: ProviderName[] = (['anthropic', 'openai', 'google'] as const).filter(
    (name) => name !== preferred,
  );

  for (const name of alternatives) {
    const candidate = build(name, settings?.models?.[name]);
    if (candidate.isConfigured()) {
      logger.warn('ai.provider.fallback', { requested: preferred, using: name });
      return candidate;
    }
  }

  // Return the primary anyway — the service layer turns "not configured" into a
  // clear AI_UNAVAILABLE error rather than a confusing 401 from the vendor.
  return primary;
}

export function listProviderNames(): ProviderName[] {
  return ['anthropic', 'openai', 'google'];
}
