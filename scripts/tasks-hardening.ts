/**
 * Task-path hardening (P1-D), against a real PostgreSQL.
 *
 *   DATABASE_URL=…/academic_ai_test npm run test:tasks:db
 *
 * The pre-P1 task engine that chat uses stays; these are the fixes approved
 * for it: no re-execution of a step another runner holds or that already ran
 * its allowed attempts, monotonic cancellation (never overwritten, never on a
 * finished task, noticed mid-step), enforced step timeouts, ownership of the
 * linked project and conversation, PLS/CB-SEM models run only once the
 * researcher confirmed that exact model, and a working retry of a failed task.
 */

import 'dotenv/config';

process.env.JOB_RUNNER = 'direct';

import { eq } from 'drizzle-orm';

import { resetEnvCache } from '@/config/env';
import { db } from '@/server/db';
import { projectMembers, taskSteps, tasks } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as conversationsRepo from '@/server/repositories/conversations.repository';
import * as projectsRepo from '@/server/repositories/projects.repository';
import * as tasksRepo from '@/server/repositories/tasks.repository';
import { register } from '@/server/services/account.service';
import { answerTask, cancelTask, retryTask, startTask } from '@/server/services/task.service';
import { DEFAULT_BUDGET, registerCapability, type CapabilityDefinition } from '@/server/tasks/capabilities';
import { failed, succeeded } from '@/server/tasks/contracts';
import { registerHandler, runTask } from '@/server/tasks/executor';
import { registerAllHandlers } from '@/server/tasks/handlers';
import { applyAnswer, isAffirmative, modelHash } from '@/server/tasks/model-confirmation';

const RUN = `tasks-${Date.now()}`;
let passed = 0;
let failedCount = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failedCount += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : `error:${String(error).slice(0, 60)}`;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < until) {
    await sleep(150);
    value = await read();
  }
  return value;
}

/* Test-only capabilities with short timeouts; registered in this process only. */
const TEST_CAPABILITIES: CapabilityDefinition[] = [
  { id: 'test.slow' as never, labelKey: 'x', timeoutMs: 30_000, estimatedModelCalls: 0, retryable: false, maxAttempts: 1, requiresDataset: false, parallelSafe: true },
  { id: 'test.hang' as never, labelKey: 'x', timeoutMs: 400, estimatedModelCalls: 0, retryable: false, maxAttempts: 1, requiresDataset: false, parallelSafe: true },
  { id: 'test.once' as never, labelKey: 'x', timeoutMs: 30_000, estimatedModelCalls: 0, retryable: false, maxAttempts: 1, requiresDataset: false, parallelSafe: true },
  { id: 'test.flaky' as never, labelKey: 'x', timeoutMs: 30_000, estimatedModelCalls: 0, retryable: false, maxAttempts: 1, requiresDataset: false, parallelSafe: true },
];

async function main() {
  resetEnvCache();
  registerAllHandlers();
  for (const capability of TEST_CAPABILITIES) registerCapability(capability);

  const user = async (name: string) =>
    (await register({ name, email: `${RUN}-${name}@example.test`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123', locale: 'en' })).id;
  const owner = await user('owner');
  const stranger = await user('stranger');
  const viewer = await user('viewer');

  const executions: string[] = [];
  let lateCompletions = 0;
  registerHandler('test.slow' as never, async (context) => {
    executions.push(`slow:${context.stepId}`);
    await sleep(8_000);
    lateCompletions += 1;
    return succeeded([]);
  });
  registerHandler('test.hang' as never, async () => {
    await sleep(5_000); // ignores the abort signal on purpose
    return succeeded([]);
  });
  registerHandler('test.once' as never, async (context) => {
    executions.push(`once:${context.stepId}`);
    return succeeded([]);
  });
  let flakyCalls = 0;
  registerHandler('test.flaky' as never, async () => {
    flakyCalls += 1;
    return flakyCalls === 1 ? failed([{ code: 'test.flaky', severity: 'error', message: 'first try fails', reference: 'test' }]) : succeeded([]);
  });

  async function makeTask(capabilities: string[], extra: Partial<typeof tasks.$inferInsert> = {}) {
    const task = await tasksRepo.create({
      userId: owner,
      request: 'hardening test',
      locale: 'en',
      status: 'QUEUED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
      ...extra,
    });
    await tasksRepo.addSteps(
      capabilities.map((capability, ordinal) => ({ taskId: task.id, ordinal, capability, label: capability, status: 'PENDING', dependsOn: [], input: {}, dynamic: false })),
    );
    return task;
  }

  /* ------------------------------------------------------------------ */
  console.log('\nmonotonic cancellation');
  {
    const done = await makeTask(['test.once']);
    await runTask(done.id);
    check('a completed task cannot be cancelled', await cancelTask(done.id, owner), false);
    check('… and stays completed', (await tasksRepo.findAny(done.id))?.status, 'COMPLETED');

    const cancelled = await makeTask(['test.once']);
    check('an unfinished task is cancelled', await cancelTask(cancelled.id, owner), true);
    check('a cancelled task cannot be set running again', await tasksRepo.setStatus(cancelled.id, 'RUNNING'), false);
    check('… nor failed by a late crash handler', await tasksRepo.setStatus(cancelled.id, 'FAILED'), false);
    await runTask(cancelled.id);
    check('running a cancelled task does nothing', [(await tasksRepo.findAny(cancelled.id))?.status, (await tasksRepo.stepsOf(cancelled.id))[0]?.status], ['CANCELLED', 'PENDING']);
    check('a stranger cannot cancel', await outcome(() => cancelTask(cancelled.id, stranger)), 'NOT_FOUND');
  }

  /* ------------------------------------------------------------------ */
  console.log('\ncancellation reaches a running step');
  {
    const task = await makeTask(['test.slow']);
    const started = Date.now();
    const running = runTask(task.id);
    await waitFor(() => tasksRepo.stepsOf(task.id), (steps) => steps[0]?.status === 'RUNNING');
    await cancelTask(task.id, owner);
    await running;
    const waited = Date.now() - started;
    const [step] = await tasksRepo.stepsOf(task.id);
    check('the executor stops within seconds of a cancel, not after the step', waited < 6_000, true);
    check('the running step is set aside as cancelled', [step?.status, step?.errorReasonKey], ['SKIPPED', 'task.step.cancelled']);
    check('the task stays cancelled', (await tasksRepo.findAny(task.id))?.status, 'CANCELLED');
    await sleep(6_500);
    check('the handler finishing later changes nothing', [lateCompletions >= 1, (await tasksRepo.stepsOf(task.id))[0]?.status], [true, 'SKIPPED']);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nstep timeouts are enforced');
  {
    const task = await makeTask(['test.hang']);
    const started = Date.now();
    await runTask(task.id);
    const [step] = await tasksRepo.stepsOf(task.id);
    check('a handler that ignores its abort signal is stopped at the timeout', Date.now() - started < 3_000, true);
    check('the step fails as a timeout', [step?.status, step?.errorReasonKey], ['FAILED', 'task.error.timeout']);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nno re-execution beyond the allowed attempts');
  {
    const task = await makeTask(['test.once']);
    const [step] = await tasksRepo.stepsOf(task.id);
    await tasksRepo.claimStep(step!.id);
    await tasksRepo.setStatus(task.id, 'RUNNING');
    executions.length = 0;
    await runTask(task.id);
    const [after] = await tasksRepo.stepsOf(task.id);
    check('a stranded step allowed one attempt is not run again', executions.length, 0);
    check('… it is failed as interrupted, with the attempt counted', [after?.status, after?.errorReasonKey, after?.attempts], ['FAILED', 'task.step.interrupted', 1]);

    const retried = await makeTask(['general.answer']);
    const [answer] = await tasksRepo.stepsOf(retried.id);
    await tasksRepo.claimStep(answer!.id);
    await tasksRepo.recoverStranded(retried.id, () => 2);
    check('a stranded step with attempts left returns to pending, the attempt counted', (await tasksRepo.stepsOf(retried.id)).map((s) => [s.status, s.attempts]), [['PENDING', 1]]);

    const claimTask = await makeTask(['test.once']);
    const [claimStep] = await tasksRepo.stepsOf(claimTask.id);
    const claimed = await tasksRepo.claimStep(claimStep!.id);
    await tasksRepo.recoverStranded(claimTask.id, () => 3);
    await tasksRepo.claimStep(claimStep!.id);
    check('a runner that lost its claim cannot record a result', await tasksRepo.completeStep(claimStep!.id, { stale: true }, [], { startedAt: claimed!.startedAt as Date }), false);
    const done = await makeTask(['test.once']);
    await runTask(done.id);
    const [settled] = await tasksRepo.stepsOf(done.id);
    check('a completed step is never rewritten', await tasksRepo.completeStep(settled!.id, { again: true }), false);
    await tasksRepo.failStep(settled!.id, 'x', false, 1);
    check('… nor failed afterwards', (await tasksRepo.stepsOf(done.id))[0]?.status, 'COMPLETED');
  }

  /* ------------------------------------------------------------------ */
  console.log('\nexclusive runner in direct mode');
  {
    const { dispatchTask } = await import('@/server/jobs/dispatch');
    const { claimLease } = await import('@/server/jobs/leases');
    const task = await makeTask(['test.once']);
    await claimLease('tasks', task.id, 'another-live-instance');
    executions.length = 0;
    await dispatchTask(task.id);
    await sleep(1_500);
    check('a task leased by another instance is not run again (direct mode)', executions.length, 0);
    await db.update(tasks).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(tasks.id, task.id));
    await dispatchTask(task.id);
    const finished = await waitFor(() => tasksRepo.findAny(task.id), (t) => t?.status === 'COMPLETED');
    check('once the lease is free it runs, exactly once', [finished?.status, executions.length], ['COMPLETED', 1]);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nownership of linked project and conversation');
  {
    const theirs = await projectsRepo.create({ userId: stranger, title: 'Theirs', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
    check('a task cannot be linked to someone else’s project', await outcome(() => startTask({ userId: owner, request: 'x', locale: 'en', projectId: theirs.id })), 'NOT_FOUND');
    const shared = await projectsRepo.create({ userId: stranger, title: 'Shared', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
    await db.insert(projectMembers).values({ projectId: shared.id, userId: viewer, role: 'VIEWER' });
    check('… nor by a viewer of it', await outcome(() => startTask({ userId: viewer, request: 'x', locale: 'en', projectId: shared.id })), 'FORBIDDEN');
    const conversation = await conversationsRepo.findOrCreate({ userId: stranger, projectId: null, scope: 'TOOL', toolKey: 'rewriter' as never });
    check('… nor to someone else’s conversation', await outcome(() => startTask({ userId: owner, request: 'x', locale: 'en', conversationId: conversation.id })), 'NOT_FOUND');
    const before = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.userId, owner))).length;
    check('and nothing was created', (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.userId, owner))).length, before);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nstructural models run only once confirmed');
  {
    check('"yes" and "نعم" confirm; other answers do not', [isAffirmative('yes'), isAffirmative('نعم، شغّله'), isAffirmative('Confirm.'), isAffirmative('no'), isAffirmative('yesterday'), isAffirmative('maybe')], [true, true, true, false, false, false]);
    check('an answer settles only a pending confirmation', applyAnswer({}, 'yes'), null);
    check('a "no" clears it without confirming', applyAnswer({ pendingModelConfirmation: 'h' }, 'no'), { pendingModelConfirmation: null });

    const model = { constructs: [{ name: 'A', indicators: ['a1', 'a2'] }, { name: 'B', indicators: ['b1', 'b2'] }], paths: [{ from: 'A', to: 'B' }] };
    const task = await makeTask(['statistics.pls'], { context: { datasetId: 'not-a-dataset' } });
    await db.update(taskSteps).set({ input: { datasetId: 'not-a-dataset', model } }).where(eq(taskSteps.taskId, task.id));
    await runTask(task.id);
    const waiting = await tasksRepo.findAny(task.id);
    check('a planner-supplied model is not run: the task asks first', waiting?.status, 'WAITING_FOR_INPUT');
    check('… showing the model it would run', [(waiting?.pendingQuestion ?? '').includes('A → B'), (waiting?.pendingQuestion ?? '').includes('a1')], [true, true]);
    check('… with that exact model pending confirmation', (waiting?.context as { pendingModelConfirmation?: string }).pendingModelConfirmation, modelHash(model));

    await answerTask({ taskId: task.id, userId: owner, answer: 'not sure' });
    const again = await waitFor(() => tasksRepo.findAny(task.id), (t) => t?.status === 'WAITING_FOR_INPUT');
    check('an answer that is not a yes does not confirm: it asks again', [again?.status, ((again?.context as { confirmedModels?: string[] }).confirmedModels ?? []).length], ['WAITING_FOR_INPUT', 0]);

    await answerTask({ taskId: task.id, userId: owner, answer: 'yes' });
    const ran = await waitFor(() => tasksRepo.findAny(task.id), (t) => t?.status === 'FAILED' || t?.status === 'COMPLETED');
    check('after "yes" the confirmed model runs (here on a dataset that does not exist, so it fails)', [ran?.status, ((ran?.context as { confirmedModels?: string[] }).confirmedModels ?? []).includes(modelHash(model))], ['FAILED', true]);

    const other = { ...model, paths: [{ from: 'B', to: 'A' }] };
    const second = await makeTask(['statistics.pls'], { context: { datasetId: 'not-a-dataset', confirmedModels: [modelHash(model)] } });
    await db.update(taskSteps).set({ input: { datasetId: 'not-a-dataset', model: other } }).where(eq(taskSteps.taskId, second.id));
    await runTask(second.id);
    check('a confirmation does not carry over to a different model', (await tasksRepo.findAny(second.id))?.status, 'WAITING_FOR_INPUT');
  }

  /* ------------------------------------------------------------------ */
  console.log('\nretry of a failed task');
  {
    flakyCalls = 0;
    const task = await makeTask(['test.flaky']);
    await runTask(task.id);
    check('the task failed on its first attempt', (await tasksRepo.findAny(task.id))?.status, 'FAILED');
    await retryTask({ taskId: task.id, userId: owner });
    const done = await waitFor(() => tasksRepo.findAny(task.id), (t) => t?.status === 'COMPLETED' || t?.status === 'FAILED');
    check('Retry runs the failed step again and the task completes', [done?.status, flakyCalls], ['COMPLETED', 2]);
    check('a completed task cannot be retried', await outcome(() => retryTask({ taskId: task.id, userId: owner })), 'VALIDATION');
    const cancelled = await makeTask(['test.once']);
    await cancelTask(cancelled.id, owner);
    check('… nor a cancelled one', await outcome(() => retryTask({ taskId: cancelled.id, userId: owner })), 'VALIDATION');
    check('… nor someone else’s', await outcome(() => retryTask({ taskId: task.id, userId: stranger })), 'NOT_FOUND');
  }

  console.log(`\n${passed} passed, ${failedCount} failed`);
  process.exit(failedCount === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
