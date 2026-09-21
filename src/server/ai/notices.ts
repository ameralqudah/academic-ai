import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A way for the provider layer to tell the person waiting what is happening.
 *
 * When a model is overloaded the router moves to another, or waits and tries
 * again, and that can take ten seconds or more. The layer that knows this is
 * four calls below the one holding the connection to the browser, and threading
 * a callback through every signature between them would touch a dozen call
 * sites for one line of text. An async scope, set where the stream is opened,
 * reaches it from anywhere beneath — the same reasoning as `request-scope`.
 *
 * With no listener in scope a notice goes nowhere, so every caller that never
 * opted in behaves exactly as before.
 */
export type Notice = { kind: 'failover' | 'retry' };

const scope = new AsyncLocalStorage<(notice: Notice) => void>();

export function withNotices<T>(listener: (notice: Notice) => void, run: () => T): T {
  return scope.run(listener, run);
}

export function notify(notice: Notice): void {
  try {
    scope.getStore()?.(notice);
  } catch {
    /* A listener that throws must not turn a recoverable model error into a failed answer. */
  }
}
