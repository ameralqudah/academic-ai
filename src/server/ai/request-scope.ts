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
const scope = new AsyncLocalStorage<{ userId: string }>();

export function runForUser<T>(userId: string | null | undefined, run: () => T): T {
  return userId ? scope.run({ userId }, run) : run();
}

export function currentUserId(): string | undefined {
  return scope.getStore()?.userId;
}
