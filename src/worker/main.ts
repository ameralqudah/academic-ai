/**
 * The background worker service: `npm run worker`.
 *
 * Deploy it alongside the web service with `JOB_RUNNER=worker` on both, and
 * the web process only enqueues while this executes agent tasks, deep
 * research and PLS bootstraps. Several can run at once; leases keep each job
 * on exactly one of them.
 */

import 'dotenv/config';

import { logger } from '@/lib/logger';
import { stopQueue } from '@/server/jobs/queue';
import { startJobWorkers } from '@/server/jobs/worker';

async function main(): Promise<void> {
  const started = await startJobWorkers({
    taskConcurrency: Number(process.env.WORKER_TASK_CONCURRENCY ?? 4),
    analysisConcurrency: Number(process.env.WORKER_ANALYSIS_CONCURRENCY ?? 2),
  });

  if (!started) {
    logger.error('worker.queueUnavailable');
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    logger.info('worker.stopping', { signal });
    /* Graceful: running jobs finish (or their leases lapse and the reaper re-queues them). */
    await stopQueue();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
