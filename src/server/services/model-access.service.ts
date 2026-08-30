/**
 * Which models a user may use.
 *
 * A thin service, and the reason it exists is that the answer must be computed
 * somewhere the caller cannot reach. The composer shows a list; the request that
 * follows is a POST body, and a POST body says whatever it is told to say. So
 * the same question is asked again here, against the plan on record, before the
 * model is ever selected.
 *
 * The tier comes from `resolvePlanForUser`, which already handles the owner
 * override and the missing-subscription case. Deriving it here rather than
 * passing a tier in means no caller can claim to be paid.
 */

import {
  canUseModel,
  modelsFor,
  parseModelId,
  shouldOfferModelChoice,
  type ModelOption,
  type PlanTier,
} from '@/agents/modes';
import { logger } from '@/lib/logger';
import { AppError } from '@/server/http/errors';
import { resolvePlanForUser } from '@/server/services/subscription.service';

export async function tierFor(userId: string): Promise<PlanTier> {
  const resolved = await resolvePlanForUser(userId);

  /*
   * The owner runs the product rather than subscribing to it, so they are not
   * billed and not restricted. Checked first because an owner may also hold an
   * ordinary plan row and the override should win.
   */
  if (resolved.isOwner) return 'admin';
  return resolved.isPro ? 'paid' : 'free';
}

export interface ModelAccess {
  models: ModelOption[];
  /** False when there is only one option — a dropdown of one is not a choice. */
  showSelector: boolean;
  defaultModelId: string | null;
  tier: PlanTier;
}

/** What to show this user, and what to fall back to. */
export async function modelAccessFor(userId: string): Promise<ModelAccess> {
  const tier = await tierFor(userId);
  const models = modelsFor(tier);
  const fallback = models.find((option) => option.isDefault) ?? models[0];

  return {
    models,
    showSelector: shouldOfferModelChoice(tier),
    defaultModelId: fallback?.id ?? null,
    tier,
  };
}

/**
 * Resolves the model a request may actually run on.
 *
 * Returns null when the caller named nothing, which means "use whatever the
 * system would have used" and is the normal case.
 *
 * A model the caller may not use is refused rather than quietly downgraded. A
 * silent substitution would answer with a different model than the one shown in
 * the interface, and the user would have no way to know which produced their
 * result — which matters when the result is going into a thesis.
 */
export async function resolveRequestedModel(
  userId: string,
  requestedModelId: string | undefined,
): Promise<{ provider: ModelOption['provider']; model: string } | null> {
  if (!requestedModelId) return null;

  const parsed = parseModelId(requestedModelId);
  if (!parsed) {
    throw new AppError('VALIDATION', 'Unknown model.', 'نموذج غير معروف.');
  }

  const tier = await tierFor(userId);

  if (!canUseModel(tier, requestedModelId)) {
    /*
     * Logged, because a request naming a model outside the caller's plan did not
     * come from the interface — it offers only what is permitted. Either
     * something is out of step or someone is probing, and both are worth seeing.
     */
    logger.warn('model.accessDenied', { userId, requestedModelId, tier });

    throw new AppError(
      'FORBIDDEN',
      'That model is not included in your plan.',
      'هذا النموذج غير متاح في خطتك.',
    );
  }

  return parsed;
}
