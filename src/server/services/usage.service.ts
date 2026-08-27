/**
 * Usage accounting.
 *
 * The contract used everywhere: **check before, record after**. The pre-check is
 * an estimate (nobody knows how many words a generation will produce); the record
 * is the truth. Both go through this service so limits can never drift between
 * call sites.
 */

import type { ToolKey } from '@/config/research';
import { AppError } from '@/server/http/errors';
import * as projectsRepo from '@/server/repositories/projects.repository';
import * as usageRepo from '@/server/repositories/usage.repository';
import type { UsageMetric } from '@/server/repositories/usage.repository';

import { isUnlimited, resolvePlanForUser } from './subscription.service';

export interface UsageSummary {
  periodKey: string;
  resetsAt: Date;
  plan: {
    code: string;
    nameEn: string;
    nameAr: string;
    priceCents: number;
    isPro: boolean;
  };
  aiRequests: { used: number; limit: number; remaining: number };
  generatedWords: { used: number; limit: number; remaining: number };
  projects: { used: number; limit: number; remaining: number };
  toolAccess: Record<string, boolean>;
}

/** `-1` means unlimited, matching the limit fields. `Infinity` is not JSON-safe. */
function remainingOf(used: number, limit: number): number {
  if (isUnlimited(limit)) return UNLIMITED_REMAINING;
  return Math.max(0, limit - used);
}

export const UNLIMITED_REMAINING = -1;

export async function getSummary(userId: string): Promise<UsageSummary> {
  const periodKey = usageRepo.periodKeyFor();
  const [{ plan, isPro }, totals, projectCount] = await Promise.all([
    resolvePlanForUser(userId),
    usageRepo.totalsForPeriod(userId, periodKey),
    projectsRepo.countByUser(userId),
  ]);

  return {
    periodKey,
    resetsAt: usageRepo.nextPeriodStart(),
    plan: {
      code: plan.code,
      nameEn: plan.nameEn,
      nameAr: plan.nameAr,
      priceCents: plan.priceCents,
      isPro,
    },
    aiRequests: {
      used: totals.AI_REQUEST,
      limit: plan.maxAiRequests,
      remaining: remainingOf(totals.AI_REQUEST, plan.maxAiRequests),
    },
    generatedWords: {
      used: totals.GENERATED_WORD,
      limit: plan.maxGeneratedWords,
      remaining: remainingOf(totals.GENERATED_WORD, plan.maxGeneratedWords),
    },
    projects: {
      used: projectCount,
      limit: plan.maxProjects,
      remaining: remainingOf(projectCount, plan.maxProjects),
    },
    toolAccess: plan.toolAccess ?? {},
  };
}

/** Throws `PLAN_LIMIT` when the user cannot create another project. */
export async function assertCanCreateProject(userId: string): Promise<void> {
  const { plan } = await resolvePlanForUser(userId);
  if (isUnlimited(plan.maxProjects)) return;

  const used = await projectsRepo.countByUser(userId);
  if (used >= plan.maxProjects) {
    throw AppError.planLimit('projects', used, plan.maxProjects);
  }
}

/** Throws `PLAN_LIMIT` before an AI call is made. */
export async function assertCanUseAI(userId: string, estimatedWords = 0): Promise<void> {
  const periodKey = usageRepo.periodKeyFor();
  const [{ plan }, totals] = await Promise.all([
    resolvePlanForUser(userId),
    usageRepo.totalsForPeriod(userId, periodKey),
  ]);

  if (!isUnlimited(plan.maxAiRequests) && totals.AI_REQUEST >= plan.maxAiRequests) {
    throw AppError.planLimit('aiRequests', totals.AI_REQUEST, plan.maxAiRequests);
  }

  if (
    !isUnlimited(plan.maxGeneratedWords) &&
    totals.GENERATED_WORD + estimatedWords > plan.maxGeneratedWords
  ) {
    throw AppError.planLimit('generatedWords', totals.GENERATED_WORD, plan.maxGeneratedWords);
  }
}

export async function assertToolAllowed(userId: string, toolKey: ToolKey | string): Promise<void> {
  const { plan } = await resolvePlanForUser(userId);
  const access = plan.toolAccess ?? {};
  if (access[toolKey] !== true) {
    throw AppError.planLimit(`tool:${toolKey}`, 0, 0);
  }
}

export interface RecordAIUsageInput {
  userId: string;
  projectId?: string;
  toolKey?: ToolKey | null;
  generatedWords: number;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  provider: string;
  model: string;
}

export async function recordAIUsage(input: RecordAIUsageInput): Promise<void> {
  const periodKey = usageRepo.periodKeyFor();
  const base = {
    userId: input.userId,
    projectId: input.projectId ?? null,
    periodKey,
    toolKey: input.toolKey ?? null,
    provider: input.provider,
    model: input.model,
  };

  await usageRepo.record({
    ...base,
    metric: 'AI_REQUEST',
    amount: 1,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    costMicroUsd: input.costMicroUsd,
  });

  if (input.generatedWords > 0) {
    await usageRepo.record({ ...base, metric: 'GENERATED_WORD', amount: input.generatedWords });
  }

  if (input.toolKey) {
    await usageRepo.record({ ...base, metric: 'TOOL_RUN', amount: 1 });
  }
}

export async function recordSimple(
  userId: string,
  metric: UsageMetric,
  amount = 1,
  projectId?: string,
): Promise<void> {
  await usageRepo.record({
    userId,
    projectId: projectId ?? null,
    periodKey: usageRepo.periodKeyFor(),
    metric,
    amount,
  });
}
