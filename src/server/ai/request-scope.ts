import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who the current work is being done for.
 *
 * The model router is called from a dozen places — the intent classifier, the
 * planner, the task handlers — and none of them carry a user id to it. Plan-
 * aware routing needs one. Threading a parameter through every signature would
 * touch each of those call sites and every one written later; an async scope
 * set once at the two entrances (an API request, a background task) reaches
 * all of them without any of them knowing.
 *
 * Absent a scope, callers get `undefined` and the router behaves exactly as it
 * did before — so a path that is never wrapped is unchanged, not broken.
 */
export interface PreferredModel {
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
}

const scope = new AsyncLocalStorage<{ userId: string; preferredModel?: PreferredModel | null }>();

/**
 * Runs `run` on behalf of a user, optionally with the model they chose.
 *
 * The choice travels in the scope for the same reason the user does: every
 * model call beneath — classifier, planner, each task step — reaches the
 * router without carrying it. It must already have been checked against the
 * user's plan (`resolveRequestedModel`).
 */
export function runForUser<T>(
  userId: string | null | undefined,
  run: () => T,
  preferredModel?: PreferredModel | null,
): T {
  return userId ? scope.run({ userId, preferredModel: preferredModel ?? null }, run) : run();
}

export function currentUserId(): string | undefined {
  return scope.getStore()?.userId;
}

/** The model the user chose for this work, if any. */
export function currentPreferredModel(): PreferredModel | null {
  return scope.getStore()?.preferredModel ?? null;
}
