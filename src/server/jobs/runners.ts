/**
 * What a worker does with each job: claim the row's lease, then run the same
 * service function the web process used to call as a floating promise.
 */

import { logger } from '@/lib/logger';
import * as jobsRepo from '@/server/repositories/analysis-jobs.repository';
import * as tasksRepo from '@/server/repositories/tasks.repository';

import { withLease } from './leases';

const FINISHED = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_FOR_INPUT', 'PAUSED']);

export async function runTaskJob(taskId: string): Promise<'ran' | 'busy' | 'skipped'> {
  const task = await tasksRepo.findAny(taskId);
  if (!task || FINISHED.has(task.status)) return 'skipped';

  const { executeTask } = await import('@/server/services/task.service');
  return withLease('tasks', taskId, () => executeTask(taskId));
}

export async function runAnalysisJob(jobId: string): Promise<'ran' | 'busy' | 'skipped'> {
  const job = await jobsRepo.findOwnedAny(jobId);
  if (!job || job.status !== 'QUEUED') return 'skipped';

  return withLease('analysis_jobs', jobId, async () => {
    switch (job.kind) {
      case 'pls.bootstrap': {
        const { runBootstrapJob } = await import('@/server/services/pls.service');
        await runBootstrapJob(jobId);
        return;
      }
      case 'stats.run': {
        const { runStatsJob } = await import('@/server/stats/runs');
        await runStatsJob(jobId);
        return;
      }
      case 'research.deep': {
        const { runResearchJob } = await import('@/server/services/deep-research.service');
        await runResearchJob(jobId);
        return;
      }
      default:
        logger.error('jobs.analysis.unknownKind', { jobId, kind: job.kind });
        await jobsRepo.fail(jobId, 'analysis.job.error.interrupted');
    }
  });
}
