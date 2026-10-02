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

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JOB_RUNNER = 'direct';
/* WS4: the artifact and dataset checks store files; a private local directory, as `integration.ts` does. */
process.env.STORAGE_PROVIDER = 'local';
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), 'tasks-hardening-'));

import { count, eq } from 'drizzle-orm';

import { resetEnvCache } from '@/config/env';
import { db } from '@/server/db';
import { agentTasks, aiConversations, aiUsageEvents, analysisJobs, analysisRuns, artifacts, projectMembers, taskSteps, tasks } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as conversationsRepo from '@/server/repositories/conversations.repository';
import * as projectsRepo from '@/server/repositories/projects.repository';
import * as tasksRepo from '@/server/repositories/tasks.repository';
import { register } from '@/server/services/account.service';
import { answerTask, cancelTask, executeTask, retryTask, startTask } from '@/server/services/task.service';
import { runAgent } from '@/agents/orchestrator';
import { gateway, productionDeps, setGatewayForTests } from '@/server/ai/gateway';
import { FakeAdapter } from '@/server/ai/gateway/adapters/fake';
import { createGateway } from '@/server/ai/gateway/gateway';
import { runForUser, withCallIds } from '@/server/ai/request-scope';
import { storeArtifact } from '@/server/services/artifact.service';
import { startConversation } from '@/server/services/chat.service';
import { analyseDataRequest } from '@/server/services/data-analysis.service';
import { saveUpload } from '@/server/services/dataset.service';
import { startDeepResearch } from '@/server/services/deep-research.service';
import { runBootstrapJob, runPls, startBootstrap } from '@/server/services/pls.service';
import { runResearchJob } from '@/server/services/deep-research.service';
import { generateLongForm, LongFormCancelled } from '@/server/ai/long-form';
import type { AIProvider } from '@/ai/provider';
import { LeaseLost, setLeaseHeartbeatForTests, withLease } from '@/server/jobs/leases';
import * as jobsRepo from '@/server/repositories/analysis-jobs.repository';
import { attachRun, runAnalysis } from '@/server/services/statistics.service';
import { searchWeb } from '@/server/services/web-search.service';
import { DEFAULT_BUDGET, registerCapability, type CapabilityDefinition } from '@/server/tasks/capabilities';
import { failed, needsInput, succeeded } from '@/server/tasks/contracts';
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
  { id: 'test.model' as never, labelKey: 'x', timeoutMs: 30_000, estimatedModelCalls: 1, retryable: false, maxAttempts: 1, requiresDataset: false, parallelSafe: false },
  { id: 'test.leased' as never, labelKey: 'x', timeoutMs: 30_000, estimatedModelCalls: 0, retryable: false, maxAttempts: 2, requiresDataset: false, parallelSafe: false },
  { id: 'test.ask' as never, labelKey: 'x', timeoutMs: 30_000, estimatedModelCalls: 0, retryable: false, maxAttempts: 1, requiresDataset: false, parallelSafe: true },
  { id: 'test.writer' as never, labelKey: 'x', timeoutMs: 30_000, estimatedModelCalls: 6, retryable: false, maxAttempts: 1, requiresDataset: false, parallelSafe: false },
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
  registerHandler('test.model' as never, async (context) => {
    await gateway().generate({ purpose: 'chat', messages: [{ role: 'user', content: `step ${context.stepId}` }] });
    return succeeded([]);
  });
  /* WS4 G4: the first run waits until its signal aborts (or 5 s); later runs finish at once. */
  const leased = { runs: 0, sawAbort: false, waitedMs: 0 };
  registerHandler('test.leased' as never, async (context) => {
    leased.runs += 1;
    if (leased.runs > 1) return succeeded([]);
    const started = Date.now();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      context.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    leased.sawAbort = context.signal.aborted;
    leased.waitedMs = Date.now() - started;
    return succeeded([]);
  });
  registerHandler('test.ask' as never, async () => needsInput('Which one?', 'choice'));
  /* WS4 G3: a fake writer whose every round takes 600 ms and always asks for more. */
  const slowRounds: { aborted: boolean }[] = [];
  const slowWriter = (delayMs: number, rounds: { aborted: boolean }[]) =>
    ({
      name: 'anthropic',
      model: 'fake-writer',
      isConfigured: () => true,
      countTokens: () => 1,
      estimateCostMicroUsd: () => 0,
      stream: async function* () {},
      complete: async (request: { signal?: AbortSignal }) => {
        const round = { aborted: false };
        rounds.push(round);
        await new Promise<void>((resolve, reject) => {
          if (request.signal?.aborted) {
            round.aborted = true;
            return reject(new Error('aborted'));
          }
          const timer = setTimeout(resolve, delayMs);
          request.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            round.aborted = true;
            reject(new Error('aborted'));
          }, { once: true });
        });
        return { text: 'more words to come '.repeat(10), stopReason: 'max_tokens', usage: { tokensIn: 1, tokensOut: 1 }, provider: 'anthropic', model: 'fake-writer' };
      },
    }) as unknown as AIProvider;
  let writerOutcome = '';
  registerHandler('test.writer' as never, async (context) => {
    try {
      await generateLongForm({ signal: context.signal, provider: slowWriter(600, slowRounds), system: 's', prompt: 'p', locale: 'en', maxRounds: 6 });
      writerOutcome = 'finished';
    } catch (error) {
      writerOutcome = error instanceof LongFormCancelled ? 'cancelled' : `threw:${String(error)}`;
    }
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
  console.log('\nWS4 G3: long-running work stops when its signal aborts');
  {
    const rounds: { aborted: boolean }[] = [];
    const whole = await generateLongForm({ provider: slowWriter(0, rounds), system: 's', prompt: 'p', locale: 'en', maxRounds: 3 });
    check('without a signal, long-form writing runs its rounds as before', [rounds.length, whole.rounds], [3, 3]);

    const none: { aborted: boolean }[] = [];
    const stopped = new AbortController();
    stopped.abort();
    check('an aborted signal sends no round at all', [await generateLongForm({ signal: stopped.signal, provider: slowWriter(0, none), system: 's', prompt: 'p', locale: 'en' }).then(() => 'finished', (error: unknown) => (error instanceof LongFormCancelled ? 'cancelled' : String(error))), none.length], ['cancelled', 0]);

    const mid: { aborted: boolean }[] = [];
    const midway = new AbortController();
    setTimeout(() => midway.abort(), 100);
    const started = Date.now();
    const midOutcome = await generateLongForm({ signal: midway.signal, provider: slowWriter(2_000, mid), system: 's', prompt: 'p', locale: 'en' }).then(() => 'finished', (error: unknown) => (error instanceof LongFormCancelled ? 'cancelled' : String(error)));
    check('an abort mid-round stops the call in flight, at once, and no round follows', [midOutcome, mid.length, mid[0]?.aborted, Date.now() - started < 1_000], ['cancelled', 1, true, true]);

    /* Through a task: cancelling it stops the step's writing, not just the executor's wait. */
    slowRounds.length = 0;
    writerOutcome = '';
    const writing = await makeTask(['test.writer']);
    const running = runTask(writing.id);
    await sleep(200);
    await cancelTask(writing.id, owner);
    await running;
    await sleep(4_500);
    check('a cancelled task’s writing stops: the round in flight is aborted and no later round is sent', [writerOutcome, slowRounds.length < 6, slowRounds.at(-1)?.aborted], ['cancelled', true, true]);
    check('… and the step is set aside, never a result', (await tasksRepo.stepsOf(writing.id))[0]?.status, 'SKIPPED');
    const handlerSource = readFileSync('src/server/tasks/handlers.ts', 'utf8');
    check('the real writing, literature-review and deep-research handlers pass the step’s signal to their long-running work', [(handlerSource.match(/generateLongForm\(\{\n\s+signal: context\.signal,/g) ?? []).length, /runDeepResearch\(\{[\s\S]{0,300}signal: context\.signal,/.test(handlerSource)], [2, true]);

    /* A research job: a cancel aborts the model call in flight; a lost lease stops it before any call, writing nothing. */
    const research = new FakeAdapter('google');
    setGatewayForTests(
      createGateway({
        ...productionDeps,
        adapters: () => ({ google: research }),
        models: async () => ({ configured: [{ provider: 'google', model: 'gemini-2.5-pro' }], defaultProvider: 'google', siblings: {} }),
      }),
    );
    try {
      research.push({ reply: { text: '["one"]' }, delayMs: 6_000 });
      const job = await jobsRepo.create({ userId: owner, kind: 'research.deep', status: 'QUEUED', spec: { question: 'q', locale: 'en', conversationId: null } });
      const begun = Date.now();
      const researching = runResearchJob(job.id);
      await sleep(300);
      await db.update(analysisJobs).set({ status: 'CANCELLED' }).where(eq(analysisJobs.id, job.id));
      await researching;
      const [after] = await db.select().from(analysisJobs).where(eq(analysisJobs.id, job.id));
      check('a cancelled research job stops its model call in flight (well before the 6 s reply) and writes no failure', [Date.now() - begun < 4_000, research.calls.length, research.calls[0]?.signal.aborted, after?.status], [true, 1, true, 'CANCELLED']);

      const lostJob = await jobsRepo.create({ userId: owner, kind: 'research.deep', status: 'QUEUED', spec: { question: 'q', locale: 'en', conversationId: null } });
      const gone = new AbortController();
      gone.abort();
      const callsBefore = research.calls.length;
      await runResearchJob(lostJob.id, gone.signal);
      const [lostRow] = await db.select().from(analysisJobs).where(eq(analysisJobs.id, lostJob.id));
      check('with its lease lost, a research job sends nothing and writes neither result nor failure', [research.calls.length - callsBefore, lostRow?.status, lostRow?.result ?? null], [0, 'RUNNING', null]);
      /* Settled here as its next owner would, so it does not count as active work in later tests. */
      await db.update(analysisJobs).set({ status: 'CANCELLED' }).where(eq(analysisJobs.id, lostJob.id));
    } finally {
      setGatewayForTests(null);
    }
  }

  /* ------------------------------------------------------------------ */
  console.log('\nWS4 G4: a lost lease stops the work at once, and nothing more is written');
  setLeaseHeartbeatForTests(100);
  try {
    const kept = await makeTask(['test.once']);
    check('a lease that keeps renewing never aborts the work', await withLease('tasks', kept.id, async (lease) => {
      await sleep(450);
      if (lease.aborted) throw new Error('aborted while held');
    }), 'ran');

    const stolen = await makeTask(['test.once']);
    let reason: unknown = null;
    const result = await withLease('tasks', stolen.id, async (lease) => {
      await db.update(tasks).set({ leaseOwner: 'another-worker', leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(tasks.id, stolen.id));
      await waitFor(async () => lease.aborted, (aborted) => aborted, 3_000);
      reason = lease.reason;
    });
    check('a lease taken by another worker aborts the work’s signal, with the reason, and the run reports it lost', [result, reason instanceof LeaseLost], ['lost', true]);

    const task = await makeTask(['test.leased', 'test.once']);
    executions.length = 0;
    const started = Date.now();
    const run = withLease('tasks', task.id, (lease) => executeTask(task.id, { lease }));
    await waitFor(async () => leased.runs, (runs) => runs > 0, 3_000);
    await db.update(tasks).set({ leaseOwner: 'another-worker', leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(tasks.id, task.id));
    const outcome = await run;
    const afterLoss = await tasksRepo.findAny(task.id);
    const stepsAfterLoss = await tasksRepo.stepsOf(task.id);
    check('the running step is told to stop at once (not after its 5 s), and the run is lost', [outcome, leased.sawAbort, leased.waitedMs < 2_000, Date.now() - started < 3_000], ['lost', true, true, true]);
    check('… nothing more is written: the step is left for the next owner, the next step never starts, the task is not failed or finished', [stepsAfterLoss.map((s) => s.status), executions.length, afterLoss?.status], [['RUNNING', 'PENDING'], 0, 'RUNNING']);
    check('… and the execution is left open, for the next owner to count as interrupted (G7)', (afterLoss?.context as { executionOpen?: boolean }).executionOpen, true);

    await db.update(tasks).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(tasks.id, task.id));
    check('the next owner recovers it and finishes it', await withLease('tasks', task.id, (lease) => executeTask(task.id, { lease })), 'ran');
    const resumed = await tasksRepo.findAny(task.id);
    check('… the stranded step re-run once, the task completed, and the lost execution counted', [resumed?.status, (await tasksRepo.stepsOf(task.id)).map((s) => s.status), (resumed?.context as { interruptedExecutions?: number }).interruptedExecutions], ['COMPLETED', ['COMPLETED', 'COMPLETED'], 1]);

    /* A bootstrap job: lease lost → no result is written; held → it completes as before. */
    const lines = ['a1,a2,a3,b1,b2,b3'];
    for (let i = 0; i < 40; i += 1) {
      const a = (i % 5) + 1;
      const b = ((i * 3) % 5) + 1;
      lines.push([a, Math.min(5, a + (i % 2)), Math.max(1, a - (i % 3 === 0 ? 1 : 0)), b, Math.min(5, b + (i % 2)), Math.max(1, b - (i % 4 === 0 ? 1 : 0))].join(','));
    }
    const data = (await saveUpload({ userId: owner, file: { name: 'g4.csv', bytes: new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer } })).dataset;
    const spec = {
      model: { constructs: [{ name: 'A', indicators: ['a1', 'a2', 'a3'], mode: 'reflective' }, { name: 'B', indicators: ['b1', 'b2', 'b3'], mode: 'reflective' }], paths: [{ from: 'A', to: 'B' }] },
      resamples: 100,
      confidenceLevel: 0.95,
      seed: 7,
    };
    const lostBoot = await jobsRepo.create({ userId: owner, kind: 'pls.bootstrap', status: 'QUEUED', datasetId: data.id, spec });
    const gone = new AbortController();
    gone.abort();
    await runBootstrapJob(lostBoot.id, gone.signal);
    const [lostBootRow] = await db.select().from(analysisJobs).where(eq(analysisJobs.id, lostBoot.id));
    const heldBoot = await jobsRepo.create({ userId: owner, kind: 'pls.bootstrap', status: 'QUEUED', datasetId: data.id, spec });
    await runBootstrapJob(heldBoot.id, new AbortController().signal);
    const [heldBootRow] = await db.select().from(analysisJobs).where(eq(analysisJobs.id, heldBoot.id));
    check('a bootstrap whose lease is lost writes no result; one whose lease holds completes', [lostBootRow?.status, lostBootRow?.result ?? null, heldBootRow?.status], ['RUNNING', null, 'COMPLETED']);
    await db.update(analysisJobs).set({ status: 'CANCELLED' }).where(eq(analysisJobs.id, lostBoot.id));
  } finally {
    setLeaseHeartbeatForTests(null);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nWS4 G7: a task is not restarted forever after interruptions');
  {
    const contextOf = async (id: string) => (await tasksRepo.findAny(id))?.context as { executionOpen?: boolean; interruptedExecutions?: number };
    const fresh = await makeTask(['test.once']);
    await executeTask(fresh.id);
    check('a task that runs to its end counts no interruption, and closes its execution', [(await tasksRepo.findAny(fresh.id))?.status, await contextOf(fresh.id)], ['COMPLETED', { executionOpen: false, interruptedExecutions: 0 }]);

    const once = await makeTask(['test.once'], { context: { executionOpen: true, interruptedExecutions: 0 } });
    await executeTask(once.id);
    check('a task whose last execution never ended (a crash) counts one interruption, and still runs under the cap', [(await tasksRepo.findAny(once.id))?.status, await contextOf(once.id)], ['COMPLETED', { executionOpen: false, interruptedExecutions: 1 }]);

    executions.length = 0;
    const looping = await makeTask(['test.once'], { context: { executionOpen: true, interruptedExecutions: 2 } });
    await executeTask(looping.id);
    const looped = await tasksRepo.findAny(looping.id);
    check('at the cap it is failed with that reason instead of being started again, and runs nothing', [looped?.status, looped?.errorReasonKey, executions.length, await contextOf(looping.id)], ['FAILED', 'task.error.interrupted', 0, { executionOpen: false, interruptedExecutions: 3 }]);

    /* Planning: a task with no steps, interrupted at the cap, is failed before any planning call. */
    const planner = new FakeAdapter('google');
    setGatewayForTests(createGateway({ ...productionDeps, adapters: () => ({ google: planner }), models: async () => ({ configured: [{ provider: 'google', model: 'gemini-2.5-pro' }], defaultProvider: 'google', siblings: {} }) }));
    try {
      const unplanned = await tasksRepo.create({ userId: owner, request: 'plan me', locale: 'en', status: 'QUEUED', context: { executionOpen: true, interruptedExecutions: 2 }, budget: DEFAULT_BUDGET as unknown as Record<string, number>, spent: { modelCalls: 0, retries: 0 } });
      await executeTask(unplanned.id);
      check('a planning loop is capped the same way: failed before any planning call', [(await tasksRepo.findAny(unplanned.id))?.status, planner.calls.length, (await tasksRepo.stepsOf(unplanned.id)).length], ['FAILED', 0, 0]);
    } finally {
      setGatewayForTests(null);
    }

    const asking = await makeTask(['test.ask']);
    await executeTask(asking.id);
    await executeTask(asking.id);
    check('a task that stops to ask (an end, not an interruption) counts nothing, however often it resumes', [(await tasksRepo.findAny(asking.id))?.status, await contextOf(asking.id)], ['WAITING_FOR_INPUT', { executionOpen: false, interruptedExecutions: 0 }]);

    const counted = await makeTask(['test.once'], { context: { keep: 'me' } });
    await tasksRepo.openExecution(counted.id);
    await tasksRepo.openExecution(counted.id);
    check('the count lives in the task’s context, beside what is already there (no migration)', await contextOf(counted.id), { keep: 'me', executionOpen: true, interruptedExecutions: 1 });
  }

  /* ------------------------------------------------------------------ */
  console.log('\nWS4 G1: a task step’s model calls are metered against the step');
  {
    setGatewayForTests(
      createGateway({
        ...productionDeps,
        adapters: () => ({ google: new FakeAdapter('google') }),
        models: async () => ({ configured: [{ provider: 'google', model: 'gemini-2.5-pro' }], defaultProvider: 'google', siblings: {} }),
      }),
    );
    try {
      const task = await makeTask(['test.model', 'test.model']);
      await executeTask(task.id);
      const steps = await tasksRepo.stepsOf(task.id);
      const rows = await db.select().from(aiUsageEvents).where(eq(aiUsageEvents.taskId, task.id));
      check('the task ran its two model steps', [(await tasksRepo.findAny(task.id))?.status, rows.length], ['COMPLETED', 2]);
      check('each call names its own step, as well as the task', rows.map((row) => row.stepId).sort(), steps.map((step) => step.id).sort());
      check('… and is a task call, not a research-run call', rows.map((row) => [row.runId, row.userId === owner]), [[null, true], [null, true]]);
      await runForUser(owner, () => withCallIds({ taskId: task.id }, () => gateway().generate({ purpose: 'chat', messages: [{ role: 'user', content: 'between steps' }] })));
      const outside = (await db.select().from(aiUsageEvents).where(eq(aiUsageEvents.taskId, task.id))).find((row) => !steps.some((step) => step.id === row.stepId));
      check('a call in the task but outside any step names no step (the step id does not leak into the task scope)', [Boolean(outside), outside?.stepId ?? null], [true, null]);
      const filed = await projectsRepo.create({ userId: owner, title: 'WS4 G1', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
      const projectTask = await makeTask(['test.model'], { projectId: filed.id });
      await executeTask(projectTask.id);
      const [projectRow] = await db.select().from(aiUsageEvents).where(eq(aiUsageEvents.taskId, projectTask.id));
      const [projectStep] = await tasksRepo.stepsOf(projectTask.id);
      check('… and a step of a project’s task is metered against the project too', [projectRow?.projectId, projectRow?.stepId], [filed.id, projectStep?.id]);
    } finally {
      setGatewayForTests(null);
    }
  }

  /* ------------------------------------------------------------------ */
  console.log('\nWS4 A1: every write path checks the project and conversation it names');
  {
    const theirs = await projectsRepo.create({ userId: stranger, title: 'WS4 theirs', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
    const shared = await projectsRepo.create({ userId: stranger, title: 'WS4 shared', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
    await db.insert(projectMembers).values({ projectId: shared.id, userId: viewer, role: 'VIEWER' });
    const mine = await projectsRepo.create({ userId: owner, title: 'WS4 mine', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
    const theirThread = await conversationsRepo.findOrCreate({ userId: stranger, projectId: null, scope: 'TOOL', toolKey: 'rewriter' as never });
    const myThread = await conversationsRepo.findOrCreate({ userId: owner, projectId: null, scope: 'TOOL', toolKey: 'rewriter' as never });
    const rows = async () => ({
      conversations: (await db.select({ n: count() }).from(aiConversations).where(eq(aiConversations.userId, owner)))[0]!.n,
      viewerConversations: (await db.select({ n: count() }).from(aiConversations).where(eq(aiConversations.userId, viewer)))[0]!.n,
      agentTasks: (await db.select({ n: count() }).from(agentTasks).where(eq(agentTasks.userId, owner)))[0]!.n,
      artifacts: (await db.select({ n: count() }).from(artifacts).where(eq(artifacts.userId, owner)))[0]!.n,
      jobs: (await db.select({ n: count() }).from(analysisJobs).where(eq(analysisJobs.userId, owner)))[0]!.n,
    });

    /* chat: startConversation (the conversations route and the agent's first turn) */
    const beforeChat = await rows();
    check('chat: a conversation cannot be filed under someone else’s project', await outcome(() => startConversation({ userId: owner, projectId: theirs.id })), 'NOT_FOUND');
    check('… nor under a project the caller only views', await outcome(() => startConversation({ userId: viewer, projectId: shared.id })), 'FORBIDDEN');
    check('… and neither refusal created a conversation', [(await rows()).conversations, (await rows()).viewerConversations], [beforeChat.conversations, beforeChat.viewerConversations]);
    const started = await startConversation({ userId: owner, projectId: mine.id });
    check('… while one in the caller’s own project, or in none, is created', [started.projectId, (await startConversation({ userId: owner })).projectId], [mine.id, null]);

    /* orchestrator: runAgent */
    const firstEvent = async (request: Parameters<typeof runAgent>[0]) => {
      const turn = runAgent(request);
      try {
        const next = await turn.next();
        return next.value && typeof next.value === 'object' && 'type' in next.value ? next.value.type : 'none';
      } finally {
        await turn.return(undefined);
      }
    };
    const beforeAgent = await rows();
    check('agent: a turn cannot name someone else’s project', await outcome(() => firstEvent({ userId: owner, message: 'hello', locale: 'en', projectId: theirs.id })), 'NOT_FOUND');
    check('… nor a project the caller only views', await outcome(() => firstEvent({ userId: viewer, message: 'hello', locale: 'en', projectId: shared.id })), 'FORBIDDEN');
    check('… nor someone else’s conversation', await outcome(() => firstEvent({ userId: owner, message: 'hello', locale: 'en', conversationId: theirThread.id })), 'NOT_FOUND');
    const afterAgent = await rows();
    check('… and no refused turn left a conversation or a task behind', [afterAgent.conversations, afterAgent.viewerConversations, afterAgent.agentTasks], [beforeAgent.conversations, beforeAgent.viewerConversations, beforeAgent.agentTasks]);
    check('… while a turn in the caller’s own project and thread starts', [await firstEvent({ userId: owner, message: 'hello', locale: 'en', projectId: mine.id }), await firstEvent({ userId: owner, message: 'hello', locale: 'en', conversationId: myThread.id })], ['conversation', 'conversation']);

    /* artifacts: storeArtifact (the artifacts route and every task handler) */
    const file = { userId: owner, kind: 'md' as const, filename: 'ws4.md', bytes: new TextEncoder().encode('# WS4\n\nA file.\n') };
    const beforeArtifacts = await rows();
    check('artifact: a file cannot be filed under someone else’s project', await outcome(() => storeArtifact({ ...file, projectId: theirs.id })), 'NOT_FOUND');
    check('… nor under a project the caller only views', await outcome(() => storeArtifact({ ...file, userId: viewer, projectId: shared.id })), 'FORBIDDEN');
    check('… nor in someone else’s conversation', await outcome(() => storeArtifact({ ...file, conversationId: theirThread.id })), 'NOT_FOUND');
    check('… and nothing was stored', (await rows()).artifacts, beforeArtifacts.artifacts);
    const stored = await storeArtifact({ ...file, projectId: mine.id, conversationId: myThread.id });
    check('… while the caller’s own project and thread take it', [stored.projectId, stored.conversationId], [mine.id, myThread.id]);

    /* deep research: startDeepResearch (refuses later without a web search provider, which proves the check passed) */
    const beforeResearch = await rows();
    check('deep research: a job cannot be filed under someone else’s project', await outcome(() => startDeepResearch({ userId: owner, question: 'q', locale: 'en', projectId: theirs.id })), 'NOT_FOUND');
    check('… nor under a project the caller only views', await outcome(() => startDeepResearch({ userId: viewer, question: 'q', locale: 'en', projectId: shared.id })), 'FORBIDDEN');
    check('… nor report into someone else’s conversation', await outcome(() => startDeepResearch({ userId: owner, question: 'q', locale: 'en', conversationId: theirThread.id })), 'NOT_FOUND');
    check('… and no job was created', (await rows()).jobs, beforeResearch.jobs);
    check('… while the caller’s own project and thread pass the check (refused only for the missing provider)', await outcome(() => startDeepResearch({ userId: owner, question: 'q', locale: 'en', projectId: mine.id, conversationId: myThread.id })), 'VALIDATION');

    /* web search: searchWeb (likewise) */
    check('web search: it cannot be recorded under someone else’s project', await outcome(() => searchWeb({ userId: owner, query: 'q', locale: 'en', projectId: theirs.id })), 'NOT_FOUND');
    check('… nor under a project the caller only views', await outcome(() => searchWeb({ userId: viewer, query: 'q', locale: 'en', projectId: shared.id })), 'FORBIDDEN');
    check('… nor into someone else’s conversation', await outcome(() => searchWeb({ userId: owner, query: 'q', locale: 'en', conversationId: theirThread.id })), 'NOT_FOUND');
    check('… while the caller’s own project and thread pass the check (refused only for the missing provider)', await outcome(() => searchWeb({ userId: owner, query: 'q', locale: 'en', projectId: mine.id, conversationId: myThread.id })), 'VALIDATION');
  }

  /* ------------------------------------------------------------------ */
  console.log('\nWS4 A3: legacy analyses keep a project’s data in that project');
  {
    const projectX = await projectsRepo.create({ userId: owner, title: 'WS4 X', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
    const projectY = await projectsRepo.create({ userId: owner, title: 'WS4 Y', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
    const lines = ['a1,a2,a3,b1,b2,b3'];
    for (let i = 0; i < 40; i += 1) {
      const a = (i % 5) + 1;
      const b = ((i * 3) % 5) + 1;
      lines.push([a, Math.min(5, a + (i % 2)), Math.max(1, a - (i % 3 === 0 ? 1 : 0)), b, Math.min(5, b + (i % 2)), Math.max(1, b - (i % 4 === 0 ? 1 : 0))].join(','));
    }
    const upload = (projectId: string | null) => saveUpload({ userId: owner, projectId, file: { name: 'ws4.csv', bytes: new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer } });
    const inX = (await upload(projectX.id)).dataset;
    const unfiled = (await upload(null)).dataset;
    const items = { items: ['a1', 'a2', 'a3'] };
    const runsOf = async () => (await db.select({ n: count() }).from(analysisRuns).where(eq(analysisRuns.userId, owner)))[0]!.n;

    const beforeRuns = await runsOf();
    check('statistics: project X’s data is not analysed under project Y', await outcome(() => runAnalysis({ datasetId: inX.id, userId: owner, projectId: projectY.id, test: 'reliability.cronbachAlpha', columns: items })), 'NOT_FOUND');
    check('… and no run was recorded', await runsOf(), beforeRuns);
    const runX = (await runAnalysis({ datasetId: inX.id, userId: owner, projectId: projectX.id, test: 'reliability.cronbachAlpha', columns: items })).run;
    const runNone = (await runAnalysis({ datasetId: inX.id, userId: owner, test: 'reliability.cronbachAlpha', columns: items })).run;
    const runUnfiled = (await runAnalysis({ datasetId: unfiled.id, userId: owner, projectId: projectY.id, test: 'reliability.cronbachAlpha', columns: items })).run;
    check('… while in its own project, with no project, or with unfiled data it runs as before', [runX.projectId, runNone.projectId, runUnfiled.projectId], [projectX.id, null, projectY.id]);

    check('attach: a run of project X is not re-filed under project Y', await outcome(() => attachRun({ runId: runX.id, userId: owner, projectId: projectY.id, sectionKey: 'RESULTS' })), 'NOT_FOUND');
    check('… and it still belongs to X, unattached', await db.select({ projectId: analysisRuns.projectId, sectionKey: analysisRuns.sectionKey }).from(analysisRuns).where(eq(analysisRuns.id, runX.id)), [{ projectId: projectX.id, sectionKey: null }]);
    const attachedX = await attachRun({ runId: runX.id, userId: owner, projectId: projectX.id, sectionKey: 'RESULTS' });
    const attachedNone = await attachRun({ runId: runNone.id, userId: owner, projectId: projectY.id, sectionKey: 'RESULTS' });
    check('… while it attaches in its own project, and an unfiled run attaches anywhere the caller edits', [attachedX.projectId, attachedNone.projectId], [projectX.id, projectY.id]);

    const inspect = (projectId: string | null) => analyseDataRequest({ userId: owner, datasetId: inX.id, intent: 'data.inspect', message: 'inspect', mentioned: [], language: 'en', projectId });
    check('data analysis: project X’s data is refused under project Y', await outcome(() => inspect(projectY.id)), 'NOT_FOUND');
    check('… while in its own project it is read', await outcome(() => inspect(projectX.id)), 'ok');

    const model = {
      constructs: [
        { name: 'A', indicators: ['a1', 'a2', 'a3'], mode: 'reflective' as const },
        { name: 'B', indicators: ['b1', 'b2', 'b3'], mode: 'reflective' as const },
      ],
      paths: [{ from: 'A', to: 'B' }],
    };
    check('PLS: project X’s data is not estimated under project Y', await outcome(() => runPls({ datasetId: inX.id, userId: owner, model, projectId: projectY.id })), 'NOT_FOUND');
    check('… while in its own project it is', await outcome(() => runPls({ datasetId: inX.id, userId: owner, model, projectId: projectX.id })), 'ok');
    const cyclic = { ...model, paths: [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }] };
    const jobsOf = async () => (await db.select({ n: count() }).from(analysisJobs).where(eq(analysisJobs.userId, owner)))[0]!.n;
    const beforeJobs = await jobsOf();
    check('PLS bootstrap: project X’s data gets no job under project Y', await outcome(() => startBootstrap({ datasetId: inX.id, userId: owner, model: cyclic, projectId: projectY.id })), 'NOT_FOUND');
    check('… while in its own project it reaches model validation (the cyclic model is refused there, before any job)', await outcome(() => startBootstrap({ datasetId: inX.id, userId: owner, model: cyclic, projectId: projectX.id })), 'VALIDATION');
    check('… and neither created a job', await jobsOf(), beforeJobs);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nWS4 A5: no unscoped lookup is exported');
  check('conversations: no findById or listForProject', ['findById' in conversationsRepo, 'listForProject' in conversationsRepo], [false, false]);
  check('projects: no findById', 'findById' in projectsRepo, false);

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
