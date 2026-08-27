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
 * Resolution order: admin setting → environment variable → anthropic.
 * If the chosen provider has no key, fall back to any provider that does, so a
 * misconfigured override degrades instead of taking the product down.
 */
export async function resolveProvider(): Promise<AIProvider> {
  const env = getEnv();
  const settings = await loadSettings();
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
