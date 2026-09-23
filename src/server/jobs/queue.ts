/**
 * The durable job queue: pg-boss on the application's own PostgreSQL.
 *
 * Nothing long-running happens in a request any more. A request enqueues —
 * in the same database, so the job survives any restart — and a worker picks
 * it up. The queue is one of two guarantees; the other is the lease on the
 * row itself (`leases.ts`), which is what makes execution exclusive.
 */

import { PgBoss } from 'pg-boss';

import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';

export const QUEUES = {
  /** { taskId } — plan and run an agent task. */
  task: 'task-run',
  /** { jobId } — a row of analysis_jobs: PLS bootstrap or deep research. */
  analysis: 'analysis-job-run',
  /** Every minute: re-queue work whose worker disappeared. */
  reaper: 'jobs-reaper',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

let boss: PgBoss | null = null;
let starting: Promise<PgBoss | null> | null = null;
let unavailableUntil = 0;

/**
 * The started queue, or null when it cannot be reached.
 *
 * Null is not an error the caller must handle: `dispatch` falls back to
 * running the work directly, so a queue outage degrades durability, never
 * functionality. A failure is retried after a minute rather than on every call.
 */
export async function getBoss(): Promise<PgBoss | null> {
  if (boss) return boss;
  if (Date.now() < unavailableUntil) return null;
  if (starting) return starting;

  starting = (async () => {
    try {
      const instance = new PgBoss({
        connectionString: getEnv().DATABASE_URL,
        schema: 'pgboss',
        application_name: 'academic-ai-jobs',
        max: 4,
      });
      instance.on('error', (error: unknown) => {
        logger.error('jobs.queue.error', { error: error instanceof Error ? error.message : String(error) });
      });
      await instance.start();

      /* stately: at most one queued and one active job per entity id. */
      await instance.createQueue(QUEUES.task, {
        policy: 'stately',
        expireInSeconds: 3 * 60 * 60,
        retryLimit: 3,
        retryDelay: 5,
        retryBackoff: true,
      });
      await instance.createQueue(QUEUES.analysis, {
        policy: 'stately',
        expireInSeconds: 60 * 60,
        retryLimit: 2,
        retryDelay: 5,
        retryBackoff: true,
      });
      await instance.createQueue(QUEUES.reaper, { policy: 'singleton', expireInSeconds: 120, retryLimit: 0 });

      boss = instance;
      logger.info('jobs.queue.started');
      return instance;
    } catch (error) {
      unavailableUntil = Date.now() + 60_000;
      logger.error('jobs.queue.unavailable', {
        error: error instanceof Error ? error.message : String(error),
        note: 'background work falls back to direct execution',
      });
      return null;
    } finally {
      starting = null;
    }
  })();

  return starting;
}

/** Queues one job per entity. Returns false when the queue is unavailable. */
export async function enqueue(queue: QueueName, data: Record<string, string>, key: string): Promise<boolean> {
  const instance = await getBoss();
  if (!instance) return false;

  try {
    await instance.send(queue, data, { singletonKey: key });
    return true;
  } catch (error) {
    logger.error('jobs.enqueue.failed', { queue, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export async function stopQueue(): Promise<void> {
  if (!boss) return;
  const instance = boss;
  boss = null;
  await instance.stop({ graceful: true, timeout: 20_000 }).catch(() => undefined);
}
