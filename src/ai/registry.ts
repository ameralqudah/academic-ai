import { logger } from '@/lib/logger';
import { getSetting } from '@/server/repositories/app-settings.repository';

import type { AIProvider } from './provider';
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

/** The admin's provider and model overrides (cached), for the Model Gateway's routing. */
export async function adminAISettings(): Promise<AISettings | null> {
  return loadSettings();
}

export function invalidateProviderCache(): void {
  cached = null;
}

/**
 * A provider for "no particular step": the configuration check in
 * `ai.service.prepare` and the health report. Served by the Model Gateway like
 * every other model call (P1-B) — there is no vendor code in this module any
 * more, and no silent substitution: a chosen provider that is not configured
 * reports itself as such instead of being swapped for another.
 *
 * `chosen` must already have been checked against the user's plan
 * (`resolveRequestedModel`); the gateway checks it again at call time.
 */
export async function resolveProvider(chosen?: { provider: ProviderName; model: string } | null): Promise<AIProvider> {
  /* Imported here: the gateway reads admin settings from this module. */
  const [{ gateway, predictRoute }, { gatewayProvider }] = await Promise.all([
    import('@/server/ai/gateway'),
    import('@/server/ai/gateway/compat'),
  ]);
  const predicted = await predictRoute({ needsReasoning: true, latencySensitive: false, requested: chosen ?? null });
  if (chosen && (predicted.provider !== chosen.provider || !predicted.configured)) {
    logger.warn('ai.provider.chosenUnavailable', { provider: chosen.provider, model: chosen.model });
  }
  return gatewayProvider(gateway, {
    needsReasoning: true,
    latencySensitive: false,
    requested: chosen ?? null,
    predicted,
    configured: predicted.configured,
  });
}

export function listProviderNames(): ProviderName[] {
  return ['anthropic', 'openai', 'google'];
}
