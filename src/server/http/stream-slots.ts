/**
 * Concurrent long-lived connections per user (WS4).
 *
 * An event stream holds a connection and re-reads the database every tick for
 * up to ten minutes. Rate limits count openings, not what is held open, so one
 * user could keep any number of streams alive at once. This caps what one user
 * holds open at a time.
 *
 * Per process, like the memory rate-limit store: on several instances the cap
 * is per instance. That bounds the cost one user can put on any one process,
 * which is the point; it is not a global count.
 */

const held = new Map<string, number>();

/** Streams one user may hold open at once, per process. */
export const MAX_STREAMS_PER_USER = 5;

/**
 * Takes a slot for `userId`, or returns null when they already hold `max`.
 * The returned release frees the slot, and is safe to call more than once.
 */
export function acquireStreamSlot(userId: string, max = MAX_STREAMS_PER_USER): (() => void) | null {
  const current = held.get(userId) ?? 0;
  if (current >= max) return null;
  held.set(userId, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const now = (held.get(userId) ?? 1) - 1;
    if (now <= 0) held.delete(userId);
    else held.set(userId, now);
  };
}

/** Slots `userId` holds now (for tests and diagnostics). */
export function streamSlotsHeld(userId: string): number {
  return held.get(userId) ?? 0;
}
