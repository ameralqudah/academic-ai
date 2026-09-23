/**
 * The one way services start background work.
 *
 * Queued when the queue is available (JOB_RUNNER inline or worker); run
 * in-process otherwise. In the fallback the work still runs under the row's
 * lease, so a queue outage costs durability for that one job — not
 * functionality, and never a duplicate run.
 */

import { logger } from '@/lib/logger';

import { withLease } from './leases';
import { jobRunner } from './mode';
import { enqueue, QUEUES } from './queue';

export async function dispatchTask(taskId: string): Promise<void> {
  if (jobRunner() !== 'direct' && (await enqueue(QUEUES.task, { taskId }, taskId))) return;

  const { executeTask } = await import('@/server/services/task.service');
  const run = jobRunner() === 'direct' ? executeTask(taskId) : withLease('tasks', taskId, () => executeTask(taskId));

  void Promise.resolve(run).catch((error: unknown) => {
    logger.error('task.crashed', { taskId, error: String(error) });
  });
}

export async function dispatchAnalysisJob(jobId: string, kind: 'pls.bootstrap' | 'research.deep' | 'stats.run'): Promise<void> {
  if (jobRunner() !== 'direct' && (await enqueue(QUEUES.analysis, { jobId }, jobId))) return;

  const start = async () => {
    if (kind === 'pls.bootstrap') {
      const { runBootstrapJob } = await import('@/server/services/pls.service');
      await runBootstrapJob(jobId);
    } else if (kind === 'stats.run') {
      const { runStatsJob } = await import('@/server/stats/runs');
      await runStatsJob(jobId);
    } else {
      const { runResearchJob } = await import('@/server/services/deep-research.service');
      await runResearchJob(jobId);
    }
  };

  const run = jobRunner() === 'direct' ? start() : withLease('analysis_jobs', jobId, start);
  void Promise.resolve(run).catch((error: unknown) => {
    logger.error('analysisJob.crashed', { jobId, kind, error: String(error) });
  });
}
