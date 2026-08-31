/**
 * Work left behind by a restart.
 *
 * Background analyses run inside the web process on this hosting, so a redeploy
 * kills whatever was in flight. The rows survive; the work does not. Without
 * this, a user comes back to a progress bar sitting at 43% that will never
 * move again, with nothing to click and no explanation.
 *
 * Called once per process, from whichever request arrives first. That is not
 * elegant — a startup hook would be — but Next has no reliable "the server has
 * booted" moment on this platform, and a lazy first-request check is both
 * dependable and free after the first call.
 *
 * The real fix is a separate worker process that owns its own jobs and can
 * resume them. This is what makes the current arrangement honest until then.
 */

import { logger } from '@/lib/logger';
import * as jobsRepo from '@/server/repositories/analysis-jobs.repository';

let done = false;
let running: Promise<void> | null = null;

export async function ensureStaleJobsFailed(): Promise<void> {
  if (done) return;

  /*
   * Concurrent first requests share one run rather than racing. Two instances
   * both clearing the same rows is harmless — the update is idempotent — but
   * two queries where one would do is waste on every cold start.
   */
  if (running) return running;

  running = (async () => {
    try {
      const cleared = await jobsRepo.failStale();
      if (cleared > 0) {
        logger.warn('jobs.staleCleared', {
          count: cleared,
          note: 'jobs orphaned by a restart',
        });
      }
      done = true;
    } catch (error) {
      /*
       * A failure here must not take down the request that happened to trigger
       * it. `done` stays false so the next request tries again — a database
       * that was briefly unreachable should not leave stale rows forever.
       */
      logger.error('jobs.staleCleanupFailed', { error: String(error) });
    } finally {
      running = null;
    }
  })();

  return running;
}
