/**
 * Keeping a research run's lease (P1-D WS1).
 *
 * A runner renews its lease on a heartbeat. If a renewal says the lease is
 * gone (another runner holds it), or renewing fails `maxErrors` times in a
 * row, the lease is treated as LOST: the keeper's signal aborts, and the
 * runner must stop — no further step, no further state change. The store
 * additionally fences every run/step write of a runner on the lease it holds
 * (see `store.asLeaseHolder`), so a stale runner that has not noticed yet
 * cannot overwrite the work of the runner that took over.
 *
 * No database access here: the renewal is injected, so the policy is testable.
 */

export interface LeaseKeeper {
  /** Aborted when the lease is lost. */
  readonly signal: AbortSignal;
  readonly lost: boolean;
  /** Why the lease was lost, once it is. */
  readonly reason: 'taken' | 'renew_failed' | null;
  /** One heartbeat: renews, and marks the lease lost on the rules above. */
  tick(): Promise<void>;
}

/** Consecutive renewal errors after which the lease is treated as lost. */
export const LEASE_RENEW_MAX_ERRORS = 2;

export function createLeaseKeeper(renew: () => Promise<boolean>, options: { maxErrors?: number; onLost?: (reason: 'taken' | 'renew_failed') => void } = {}): LeaseKeeper {
  const maxErrors = options.maxErrors ?? LEASE_RENEW_MAX_ERRORS;
  const controller = new AbortController();
  let errors = 0;
  let reason: 'taken' | 'renew_failed' | null = null;
  const lose = (why: 'taken' | 'renew_failed') => {
    if (reason) return;
    reason = why;
    controller.abort();
    options.onLost?.(why);
  };
  return {
    signal: controller.signal,
    get lost() {
      return reason !== null;
    },
    get reason() {
      return reason;
    },
    async tick() {
      if (reason) return;
      try {
        if (await renew()) errors = 0;
        else lose('taken');
      } catch {
        errors += 1;
        if (errors >= maxErrors) lose('renew_failed');
      }
    },
  };
}
