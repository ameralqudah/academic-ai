/**
 * The Model Gateway, wired to production dependencies. Import `gateway` from
 * here; `createGateway` (./gateway) exists for tests with injected fakes.
 *
 * Server-only: nothing in `src/components` or `src/app/**\/page.tsx` may import
 * this module (checked by the smoke suite), and provider keys are read only by
 * the adapters it constructs.
 */

import type { Tier } from './routing';
import { getEnv } from '@/config/env';
import { adminAISettings } from '@/ai/registry';
import { currentCallScope } from '@/server/ai/request-scope';
import { notify } from '@/server/ai/notices';

import { AnthropicAdapter } from './adapters/anthropic';
import { GoogleAdapter } from './adapters/google';
import { OpenAIAdapter } from './adapters/openai';
import type { ProviderAdapter } from './adapters/types';
import type { Provider } from './contract';
import { createGateway, type GatewayDeps, type ModelGateway, type PlanInfo } from './gateway';
import { databaseMeter } from './metering';
import { systemClock } from './policy';
import * as quota from './quota';
import { route, type ConfiguredModel } from './routing';

export { GatewayError, toAppError } from './errors';
export { defineTool, capabilityTool } from './tools';
export { recordToolExecution } from './metering';
export type { GatewayResponse, StreamEvent, GatewayRequestInput } from './contract';

let adapterCache: { key: string; adapters: Partial<Record<Provider, ProviderAdapter>> } | null = null;

function adapters(): Partial<Record<Provider, ProviderAdapter>> {
  const env = getEnv();
  const key = [env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.GOOGLE_AI_API_KEY].map((k) => (k ?? '').length).join(':');
  if (adapterCache?.key === key) return adapterCache.adapters;
  const built = {
    anthropic: new AnthropicAdapter(env.ANTHROPIC_API_KEY ?? ''),
    openai: new OpenAIAdapter(env.OPENAI_API_KEY ?? ''),
    google: new GoogleAdapter(env.GOOGLE_AI_API_KEY ?? ''),
  };
  adapterCache = { key, adapters: built };
  return built;
}

async function models() {
  const env = getEnv();
  const settings = await adminAISettings();
  const modelOf = (provider: Provider) =>
    settings?.models?.[provider] ??
    (provider === 'anthropic' ? env.ANTHROPIC_MODEL : provider === 'openai' ? env.OPENAI_MODEL : env.GOOGLE_MODEL);
  const configured: ConfiguredModel[] = (['anthropic', 'openai', 'google'] as const).map((provider) => ({ provider, model: modelOf(provider) }));
  const sibling = env.GOOGLE_FALLBACK_MODEL.trim();
  return {
    configured,
    defaultProvider: settings?.provider ?? env.AI_PROVIDER,
    siblings: sibling ? { google: sibling } : {},
  };
}

const PLAN_TTL_MS = 30_000;
const planCache = new Map<string, { plan: PlanInfo; at: number }>();

async function plan(userId: string): Promise<PlanInfo> {
  const cached = planCache.get(userId);
  if (cached && Date.now() - cached.at < PLAN_TTL_MS) return cached.plan;
  const { resolvePlanForUser, isUnlimited } = await import('@/server/services/subscription.service');
  const resolved = await resolvePlanForUser(userId);
  const info: PlanInfo = {
    tier: resolved.isOwner ? 'admin' : resolved.isPro ? 'paid' : 'free',
    limits: { maxAiRequests: resolved.plan.maxAiRequests, maxGeneratedWords: resolved.plan.maxGeneratedWords },
    unlimited: isUnlimited,
  };
  planCache.set(userId, { plan: info, at: Date.now() });
  if (planCache.size > 1000) planCache.delete(planCache.keys().next().value as string);
  return info;
}

/** The user's plan tier, derived exactly as the gateway routes it (P1-D: run limits and entitlements). */
export async function planTier(userId: string): Promise<Tier> {
  return (await plan(userId)).tier;
}

/** Forgets a user's cached plan (after an upgrade, in tests). */
export function forgetPlan(userId?: string): void {
  if (userId) planCache.delete(userId);
  else planCache.clear();
}

async function checkProject(projectId: string, userId: string): Promise<void> {
  const { requireProjectRole } = await import('@/server/graph/service');
  await requireProjectRole(projectId, userId, 'VIEWER');
}

export const productionDeps: GatewayDeps = {
  adapters,
  models,
  plan,
  checkProject,
  quota: { reserve: quota.reserve, commit: quota.commit, release: quota.release },
  meter: databaseMeter,
  clock: systemClock,
  scope: currentCallScope,
  notify: (notice) => notify({ kind: notice }),
};

/**
 * What the gateway would route to now, for the current user (free when there
 * is none). Used to label a provider before it is called; the model that
 * actually serves each call is on its result.
 */
export async function predictRoute(input: {
  needsReasoning: boolean;
  latencySensitive: boolean;
  contextTokens?: number;
  requested?: { provider: Provider; model: string } | null;
}): Promise<{ provider: Provider; model: string; configured: boolean }> {
  const scope = currentCallScope();
  const [{ configured, defaultProvider, siblings }, tier] = await Promise.all([
    models(),
    scope ? plan(scope.userId).then((p) => p.tier).catch(() => 'free' as const) : Promise.resolve('free' as const),
  ]);
  const available = adapters();
  const usable = configured.filter((m) => available[m.provider]?.configured());
  if (usable.length === 0) {
    const fallback = configured.find((m) => m.provider === defaultProvider) ?? configured[0]!;
    return { ...fallback, configured: false };
  }
  try {
    const decision = route({
      tier,
      configured: usable,
      defaultProvider,
      requested: input.requested ?? null,
      needsReasoning: input.needsReasoning,
      latencySensitive: input.latencySensitive,
      contextTokens: input.contextTokens ?? 2000,
      siblingModels: siblings,
    });
    return { provider: decision.chosen.provider, model: decision.chosen.model, configured: true };
  } catch {
    /* An entitlement refusal surfaces at call time, with its proper error. */
    return { ...(input.requested ?? usable[0]!), configured: true };
  }
}

let instance: ModelGateway | null = null;
let override: ModelGateway | null = null;

/** The gateway. Every production model call goes through this object. */
export function gateway(): ModelGateway {
  if (override) return override;
  instance ??= createGateway(productionDeps);
  return instance;
}

/** Replaces the gateway for a test run (integration and e2e fakes). Never called by production code. */
export function setGatewayForTests(replacement: ModelGateway | null): void {
  override = replacement;
}
