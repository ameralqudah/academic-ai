/**
 * Picks up work whose worker disappeared.
 *
 * Replaces "resume every running task on every cold start", which re-ran
 * tasks another live instance was still executing. The reaper looks at leases
 * instead: only work whose lease has lapsed — or that was queued and never
 * claimed — is re-queued, and the queue's per-entity singleton plus the lease
 * on the row make a spurious re-queue harmless.
 */

import { and, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import { logger } from '@/lib/logger';
import { db } from '@/server/db';
import { analysisJobs, tasks } from '@/server/db/schema';

import { enqueue, QUEUES } from './queue';

/** Queued but never claimed for this long: the enqueue was lost. */
const UNCLAIMED_AFTER = sql`now() - interval '2 minutes'`;
/** Rows left RUNNING by the pre-lease code path have no lease to expire. */
const LEGACY_RUNNING_AFTER = sql`now() - interval '10 minutes'`;
/** An analysis job orphaned this many times is failed, not retried again. */
export const MAX_ANALYSIS_ATTEMPTS = 2;

const ACTIVE_TASK_STATES = ['QUEUED', 'PLANNING', 'RUNNING', 'REPLANNING'];

export interface ReapResult {
  tasksRequeued: number;
  jobsRequeued: number;
  jobsFailed: number;
}

export async function reap(): Promise<ReapResult> {
  const lapsedTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ACTIVE_TASK_STATES),
        or(
          and(isNotNull(tasks.leaseExpiresAt), lt(tasks.leaseExpiresAt, sql`now()`)),
          and(isNull(tasks.leaseExpiresAt), lt(tasks.updatedAt, UNCLAIMED_AFTER)),
        ),
      ),
    )
    .limit(50);

  let tasksRequeued = 0;
  for (const task of lapsedTasks) {
    if (await enqueue(QUEUES.task, { taskId: task.id }, task.id)) tasksRequeued += 1;
  }

  /* Analysis jobs whose worker vanished mid-run. */
  const orphaned = await db
    .select({ id: analysisJobs.id, attempts: analysisJobs.attempts })
    .from(analysisJobs)
    .where(
      and(
        inArray(analysisJobs.status, ['RUNNING']),
        or(
          and(isNotNull(analysisJobs.leaseExpiresAt), lt(analysisJobs.leaseExpiresAt, sql`now()`)),
          and(isNull(analysisJobs.leaseExpiresAt), lt(analysisJobs.startedAt, LEGACY_RUNNING_AFTER)),
        ),
      ),
    )
    .limit(50);

  let jobsRequeued = 0;
  let jobsFailed = 0;

  for (const job of orphaned) {
    if (job.attempts >= MAX_ANALYSIS_ATTEMPTS) {
      await db
        .update(analysisJobs)
        .set({
          status: 'FAILED',
          errorReasonKey: 'analysis.job.error.interrupted',
          leaseOwner: null,
          leaseExpiresAt: null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(sql`${analysisJobs.id} = ${job.id} and ${analysisJobs.status} = 'RUNNING'`);
      jobsFailed += 1;
      continue;
    }

    await db
      .update(analysisJobs)
      .set({ status: 'QUEUED', leaseOwner: null, leaseExpiresAt: null, progress: 0, stage: null, updatedAt: new Date() })
      .where(sql`${analysisJobs.id} = ${job.id} and ${analysisJobs.status} = 'RUNNING'`);
    if (await enqueue(QUEUES.analysis, { jobId: job.id }, job.id)) jobsRequeued += 1;
  }

  /* Queued jobs nobody claimed. */
  const unclaimed = await db
    .select({ id: analysisJobs.id })
    .from(analysisJobs)
    .where(
      and(
        inArray(analysisJobs.status, ['QUEUED']),
        isNull(analysisJobs.leaseExpiresAt),
        lt(analysisJobs.createdAt, UNCLAIMED_AFTER),
      ),
    )
    .limit(50);

  for (const job of unclaimed) {
    if (await enqueue(QUEUES.analysis, { jobId: job.id }, job.id)) jobsRequeued += 1;
  }

  const result = { tasksRequeued, jobsRequeued, jobsFailed };
  if (tasksRequeued + jobsRequeued + jobsFailed > 0) logger.info('jobs.reaped', { ...result });
  return result;
}
