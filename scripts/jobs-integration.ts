/**
 * Durable background jobs (P0.10), against a real PostgreSQL.
 *
 *   DATABASE_URL=postgresql://…/academic_ai_test npm run db:migrate
 *   DATABASE_URL=postgresql://…/academic_ai_test npm run test:jobs
 *
 * Covers: exclusive leases, queued execution by a worker, no duplicate run when
 * two workers race, recovery of work whose worker died, failing an analysis
 * job orphaned twice, and the direct (rollback) path.
 */

import 'dotenv/config';

process.env.JOB_RUNNER = 'inline';

import { eq, like, sql } from 'drizzle-orm';

import { resetEnvCache } from '@/config/env';
import { db } from '@/server/db';
import { analysisJobs, tasks, users } from '@/server/db/schema';
import { claimLease, releaseLease, renewLease } from '@/server/jobs/leases';
import { dispatchTask } from '@/server/jobs/dispatch';
import { stopQueue } from '@/server/jobs/queue';
import { MAX_ANALYSIS_ATTEMPTS, reap } from '@/server/jobs/reaper';
import { runTaskJob } from '@/server/jobs/runners';
import { startJobWorkers } from '@/server/jobs/worker';
import * as jobsRepo from '@/server/repositories/analysis-jobs.repository';
import * as tasksRepo from '@/server/repositories/tasks.repository';
import { register } from '@/server/services/account.service';
import { DEFAULT_BUDGET } from '@/server/tasks/capabilities';
import { registerHandler } from '@/server/tasks/executor';

const RUN = `jobs-${Date.now()}`;
let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    value = await read();
  }
  return value;
}

async function main() {
  resetEnvCache();

  const owner = (
    await register({ name: 'Jobs', email: `${RUN}@example.test`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123', locale: 'en' })
  ).id;

  /** A task with one planned step, so no model is called. */
  async function makeTask(status = 'QUEUED', input: Record<string, unknown> = {}) {
    const task = await tasksRepo.create({
      userId: owner,
      request: 'job test',
      locale: 'en',
      status,
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });
    await tasksRepo.addSteps([
      { taskId: task.id, ordinal: 0, capability: 'general.answer', label: 'answer', status: 'PENDING', dependsOn: [], input, dynamic: false },
    ]);
    return task.id;
  }

  /* ------------------------------------------------------------ leases */
  console.log('\nleases');
  {
    const id = await makeTask('WAITING_FOR_INPUT');
    check('the first worker claims the lease', await claimLease('tasks', id, 'worker-a'), true);
    check('a second worker cannot', await claimLease('tasks', id, 'worker-b'), false);
    check('the holder renews it', await renewLease('tasks', id, 'worker-a'), true);
    check('another cannot renew it', await renewLease('tasks', id, 'worker-b'), false);
    await releaseLease('tasks', id, 'worker-a');
    check('once released, another worker can claim it', await claimLease('tasks', id, 'worker-b'), true);
    await db.update(tasks).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(tasks.id, id));
    check('an expired lease can be taken over', await claimLease('tasks', id, 'worker-c'), true);
  }

  /* Workers in this process, with a stub handler registered after the real ones. */
  const started = await startJobWorkers({ taskConcurrency: 4 });
  check('the queue and workers start', started, true);

  const executions = new Map<string, number>();
  registerHandler('general.answer', async ({ taskId, input }) => {
    executions.set(taskId, (executions.get(taskId) ?? 0) + 1);
    if (typeof input.sleepMs === 'number') await new Promise((resolve) => setTimeout(resolve, input.sleepMs as number));
    return { output: { answered: true } };
  });

  /* ------------------------------------------------- queued execution */
  console.log('\nqueued execution');
  {
    const id = await makeTask();
    await dispatchTask(id);
    const done = await waitFor(() => tasksRepo.findAny(id), (task) => task?.status === 'COMPLETED');
    check('a dispatched task is run by a worker to completion', done?.status, 'COMPLETED');
    check('exactly once', executions.get(id), 1);
    check('and the lease is released afterwards', done?.leaseOwner ?? null, null);
  }

  /* ------------------------------------------------- no duplicate run */
  console.log('\nno duplicate execution');
  {
    const id = await makeTask('QUEUED', { sleepMs: 1500 });
    const outcomes = await Promise.all([runTaskJob(id), runTaskJob(id), runTaskJob(id)]);
    check('three racing workers: one runs, two find it busy', outcomes.filter((o) => o === 'ran').length, 1);
    check('the step executed once', executions.get(id), 1);
    check('the task completed', (await tasksRepo.findAny(id))?.status, 'COMPLETED');
  }

  /* ------------------------------------------ recovery after a crash */
  console.log('\nrecovery of work whose worker died');
  {
    const id = await makeTask('RUNNING');
    /* A worker claimed it and vanished: its lease is in the past, and the step is stranded. */
    await db
      .update(tasks)
      .set({ leaseOwner: 'dead-worker', leaseExpiresAt: sql`now() - interval '5 seconds'` })
      .where(eq(tasks.id, id));
    const steps = await tasksRepo.stepsOf(id);
    await tasksRepo.claimStep(steps[0]?.id as string);

    const result = await reap();
    check('the reaper re-queues the task', result.tasksRequeued >= 1, true);
    const done = await waitFor(() => tasksRepo.findAny(id), (task) => task?.status === 'COMPLETED');
    check('and a live worker completes it', done?.status, 'COMPLETED');
    check('with the stranded step run once', executions.get(id), 1);

    const live = await makeTask('RUNNING');
    await db.update(tasks).set({ leaseOwner: 'live-worker', leaseExpiresAt: sql`now() + interval '100 seconds'` }).where(eq(tasks.id, live));
    await reap();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    check('a task with a live lease elsewhere is left alone', executions.get(live) ?? 0, 0);
    await db.update(tasks).set({ status: 'CANCELLED' }).where(eq(tasks.id, live));
  }

  /* ------------------------------------------- orphaned analysis jobs */
  console.log('\norphaned analysis jobs');
  {
    const make = async () =>
      (
        await jobsRepo.create({
          userId: owner,
          kind: 'pls.bootstrap',
          status: 'RUNNING',
          spec: { model: {}, resamples: 10, confidenceLevel: 0.95, seed: 1 },
        })
      ).id;

    const twice = await make();
    await db
      .update(analysisJobs)
      .set({ attempts: MAX_ANALYSIS_ATTEMPTS, leaseOwner: 'dead', leaseExpiresAt: sql`now() - interval '1 second'`, startedAt: new Date() })
      .where(eq(analysisJobs.id, twice));
    const once = await make();
    await db
      .update(analysisJobs)
      .set({ attempts: 1, leaseOwner: 'dead', leaseExpiresAt: sql`now() - interval '1 second'`, startedAt: new Date() })
      .where(eq(analysisJobs.id, once));

    const result = await reap();
    check('a job orphaned twice is failed, not retried again', (await jobsRepo.findOwnedAny(twice))?.status, 'FAILED');
    check('with a reason the interface can show', (await jobsRepo.findOwnedAny(twice))?.errorReasonKey, 'analysis.job.error.interrupted');
    check('a job orphaned once is re-queued', result.jobsRequeued >= 1, true);
    const retried = await waitFor(() => jobsRepo.findOwnedAny(once), (job) => job?.status !== 'QUEUED' && job?.status !== 'RUNNING', 20_000);
    check('and a worker picks it up again (it then fails on its missing dataset)', retried?.status, 'FAILED');
  }

  /* --------------------------------------------- direct (rollback) path */
  console.log('\ndirect execution, the rollback path');
  {
    process.env.JOB_RUNNER = 'direct';
    resetEnvCache();
    const id = await makeTask();
    await dispatchTask(id);
    const done = await waitFor(() => tasksRepo.findAny(id), (task) => task?.status === 'COMPLETED');
    check('JOB_RUNNER=direct still runs the task in-process', done?.status, 'COMPLETED');
    process.env.JOB_RUNNER = 'inline';
    resetEnvCache();
  }

  await stopQueue();
  await db.delete(users).where(like(users.email, `${RUN}%`));
  console.log(failed === 0 ? `\n✓ ${passed} job assertions passed\n` : `\n✗ ${failed} failing, ${passed} passing\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\njobs run crashed:', error);
  await stopQueue().catch(() => undefined);
  await db.delete(users).where(like(users.email, `${RUN}%`)).catch(() => undefined);
  process.exit(1);
});
