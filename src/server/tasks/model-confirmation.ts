/**
 * Confirming a structural model before a task runs it (P1-D).
 *
 * A PLS or CB-SEM model is the researcher's theory. The planner may propose one
 * from the request, but a model it wrote into a step's input used to run at
 * once — the `confirmed` gate applied only to a proposal that nothing produced.
 * Now any model that did not come from a confirmed proposal is shown to the
 * researcher first, and runs only after they confirm that exact model: the
 * confirmation is bound to a hash of the model, so a different model (a replan,
 * an edited input) asks again.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '@/analysis/engine/types';

/** Larger than this is not a model a researcher typed or confirmed. */
export const MAX_MODEL_BYTES = 20_000;

export function modelHash(model: unknown): string {
  return createHash('sha256').update(canonicalJson(model)).digest('hex');
}

export function modelTooLarge(model: unknown): boolean {
  return Buffer.byteLength(canonicalJson(model), 'utf8') > MAX_MODEL_BYTES;
}

/** An explicit yes, in English or Arabic. Anything else is not a confirmation. */
const AFFIRMATIVE = /^\s*(yes|y|confirm(ed)?|i confirm|ok(ay)?|run it|go ahead|نعم|أؤكد|اؤكد|أؤكّد|موافق|تأكيد|شغّله|شغله)(?=[\s.!،,؟?]|$)/i;

export function isAffirmative(answer: string): boolean {
  return AFFIRMATIVE.test(answer);
}

/** A readable summary of the model for the question: constructs and paths, bounded. */
export function describeModel(model: unknown, locale: 'ar' | 'en'): string {
  const shape = model as {
    constructs?: { name?: string; indicators?: string[] }[];
    paths?: { from?: string; to?: string }[];
  } | null;
  const constructs = (shape?.constructs ?? [])
    .slice(0, 12)
    .map((construct) => `${construct.name ?? '?'} (${(construct.indicators ?? []).slice(0, 8).join(', ')})`)
    .join('; ');
  const paths = (shape?.paths ?? [])
    .slice(0, 20)
    .map((path) => `${path.from ?? '?'} → ${path.to ?? '?'}`)
    .join(', ');
  return locale === 'ar'
    ? `البنى: ${constructs || '—'}. المسارات: ${paths || '—'}.`
    : `Constructs: ${constructs || '—'}. Paths: ${paths || '—'}.`;
}

export interface ConfirmationState {
  /** Hashes of models the researcher confirmed. */
  confirmedModels?: string[];
  /** The model hash the open question asks about. */
  pendingModelConfirmation?: string | null;
}

/**
 * The context patch after an answer: the pending model becomes confirmed only
 * on an explicit yes to that pending question.
 */
export function applyAnswer(state: ConfirmationState, answer: string): ConfirmationState | null {
  const pending = state.pendingModelConfirmation;
  if (!pending) return null;
  if (!isAffirmative(answer)) return { pendingModelConfirmation: null };
  return {
    confirmedModels: [...new Set([...(state.confirmedModels ?? []), pending])].slice(-20),
    pendingModelConfirmation: null,
  };
}
