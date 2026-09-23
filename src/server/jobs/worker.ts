/**
 * Starts consuming the queues in this process.
 *
 * Called by `src/worker/main.ts` for a dedicated worker service, or by
 * `src/instrumentation.ts` when the web process runs jobs inline.
 */

import { logger } from '@/lib/logger';

import { WORKER_ID } from './leases';
import { getBoss, QUEUES } from './queue';
import { reap } from './reaper';
import { runAnalysisJob, runTaskJob } from './runners';

let started = false;

export async function startJobWorkers(options: { taskConcurrency?: number; analysisConcurrency?: number } = {}): Promise<boolean> {
  if (started) return true;

  const boss = await getBoss();
  if (!boss) return false;
  started = true;

  /* Handlers first: a task picked up before registration fails every step. */
  const { registerAllHandlers } = await import('@/server/tasks/handlers');
  registerAllHandlers();

  await boss.work<{ taskId: string }>(
    QUEUES.task,
    { localConcurrency: options.taskConcurrency ?? 4, pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) return;
      const outcome = await runTaskJob(job.data.taskId);
      logger.info('jobs.task.done', { taskId: job.data.taskId, outcome, worker: WORKER_ID });
    },
  );

  await boss.work<{ jobId: string }>(
    QUEUES.analysis,
    { localConcurrency: options.analysisConcurrency ?? 2, pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) return;
      const outcome = await runAnalysisJob(job.data.jobId);
      logger.info('jobs.analysis.done', { jobId: job.data.jobId, outcome, worker: WORKER_ID });
    },
  );

  await boss.schedule(QUEUES.reaper, '* * * * *');
  await boss.work(QUEUES.reaper, async () => {
    await reap();
  });

  logger.info('jobs.workers.started', { worker: WORKER_ID });
  return true;
}
