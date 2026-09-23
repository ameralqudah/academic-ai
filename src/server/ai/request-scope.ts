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

/**
 * Ids the Model Gateway records against every call made inside this scope
 * (P1-B). Metadata only: authorisation never reads them from here without
 * checking (`projectId` is re-checked against the user's project role).
 */
export interface CallIds {
  projectId?: string | null;
  taskId?: string | null;
  jobId?: string | null;
  runId?: string | null;
}

interface Scope extends CallIds {
  userId: string;
  preferredModel?: PreferredModel | null;
}

const scope = new AsyncLocalStorage<Scope>();

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

/**
 * Adds ids to the current scope for the work inside `run` (a task step, a
 * job). Outside any user scope it does nothing: ids never create a user.
 */
export function withCallIds<T>(ids: CallIds, run: () => T): T {
  const current = scope.getStore();
  return current ? scope.run({ ...current, ...ids }, run) : run();
}

/** The user and ids the Model Gateway meters against; null outside a user scope. */
export function currentCallScope(): (CallIds & { userId: string }) | null {
  const current = scope.getStore();
  if (!current) return null;
  const { preferredModel: _ignored, ...ids } = current;
  return ids;
}

export function currentUserId(): string | undefined {
  return scope.getStore()?.userId;
}

/** The model the user chose for this work, if any. */
export function currentPreferredModel(): PreferredModel | null {
  return scope.getStore()?.preferredModel ?? null;
}
