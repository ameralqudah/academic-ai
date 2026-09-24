/**
 * The research-run executor (P1-D).
 *
 *   plan (gateway) → for each ready step: resolve + validate input → policy →
 *   [approval] → claim → tool (timeout, cancel) → validated, bounded output →
 *   settle → next
 *
 * One runner per run: the run's lease is held for the whole advance, so a
 * RUNNING step found on entry is stranded (its runner died) — it counts an
 * attempt and is retried with the same idempotency key, which returns the
 * effect it already had instead of making a second one. Steps run one at a
 * time, in order (no parallel steps in P1-D). Every limit is checked before a
 * step starts; when one is reached the run stops with that reason recorded.
 * A tool never runs inside a database transaction.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { logger } from '@/lib/logger';
import { runForUser, withCallIds } from '@/server/ai/request-scope';
import type { ResearchRun, RunStep } from '@/server/db/schema';
import { WORKER_ID } from '@/server/jobs/leases';
import { AppError } from '@/server/http/errors';

import { inputHash, stepIdempotencyKey } from './approvals';
import { withRunScope } from './db-scope';
import { activeElapsedMs, bytesOf, limitsFor, type RunLimits, type Tier } from './limits';
import { createLeaseKeeper, type LeaseKeeper } from './lease';
import { planRun, resolveReferences } from './planner';
import { decide, productionPolicyDeps, storedDecision, type PolicyDecision } from './policy';
import { toolByName } from './registry';
import * as store from './store';
import type { StopReason } from './state';
import type { ProjectRole, ToolDef } from './types';

const HEARTBEAT_MS = 30_000;
const CANCEL_POLL_MS = 2_000;
let heartbeatMs = HEARTBEAT_MS;

/** For tests: a shorter heartbeat, to exercise lease loss quickly. `null` restores the default. */
export function setRunHeartbeatForTests(ms: number | null): void {
  heartbeatMs = ms ?? HEARTBEAT_MS;
}

/** The lease of the run this runner is advancing (lost ⇒ stop, write nothing more). */
const keeperScope = new AsyncLocalStorage<LeaseKeeper>();
const leaseLost = () => keeperScope.getStore()?.lost === true;

/** Errors a retry will not fix. */
const PERMANENT = new Set(['VALIDATION', 'FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED', 'IMPACT_ACK_REQUIRED', 'PLAN_LIMIT', 'UNAVAILABLE']);

class StepCancelled extends Error {}
/** Rolls back an authorise-and-claim whose step changed underneath it. */
class NotClaimed extends Error {}
class StepTimedOut extends Error {}
class StepLeaseLost extends Error {}

/**
 * Advances a run as far as it can go now: to its end, to an approval, or to
 * a limit. Returns 'busy' when another runner holds it.
 */
export async function advanceRun(runId: string): Promise<'ran' | 'busy' | 'skipped'> {
  const owner = await store.systemRunOwner(runId);
  if (!owner || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(owner.status)) return 'skipped';
  const userId = owner.userId;
  const leaseOwner = `${WORKER_ID}:${randomUUID().slice(0, 8)}`;
  let claims: number | null;
  try {
    claims = await store.claimRunLease(userId, runId, leaseOwner);
  } catch (error) {
    /* The database cannot enforce RLS for this run: stop it with that reason (fail closed), never retry forever. */
    if (isRlsUnavailable(error)) {
      await failRlsUnavailable(runId, error);
      return 'ran';
    }
    throw error;
  }
  if (claims === null) return 'busy';
  /*
   * The heartbeat renews the lease. A renewal that finds the lease gone, or
   * LEASE_RENEW_MAX_ERRORS failures in a row, means the lease is LOST: the
   * step in progress is aborted and nothing further is written (the store
   * also fences every write on this lease), so a runner that took over is
   * never displaced by this one.
   */
  const keeper = createLeaseKeeper(() => store.renewRunLease(userId, runId, leaseOwner), {
    onLost: (reason) => logger.error('runs.lease.lost', { runId, leaseOwner, reason }),
  });
  const heartbeat = setInterval(() => void keeper.tick(), heartbeatMs);
  heartbeat.unref?.();
  return keeperScope.run(keeper, () => store.asLeaseHolder(runId, leaseOwner, () => advanceHeld(userId, runId, owner.projectId, leaseOwner, claims, keeper, heartbeat)));
}

async function advanceHeld(userId: string, runId: string, projectId: string, leaseOwner: string, claims: number, keeper: LeaseKeeper, heartbeat: ReturnType<typeof setInterval>): Promise<'ran'> {
  try {
    if (claims > store.MAX_RUN_CLAIMS) {
      /* Claimed again and again without the run moving: nothing more a runner can do. */
      logger.error('runs.advance.claimLimit', { runId, claims });
      await stopRun(userId, runId, 'worker_lost', { message: `The run was picked up ${claims} times without progress.`, claims });
      return 'ran';
    }
    await runForUser(userId, () => withCallIds({ projectId, runId }, () => drive(userId, runId)));
    return 'ran';
  } catch (error) {
    if (keeper.lost) return 'ran'; /* another runner owns the run now: write nothing */
    if (isRlsUnavailable(error)) {
      await failRlsUnavailable(runId, error);
      return 'ran';
    }
    logger.error('runs.advance.crashed', { runId, error: String(error).slice(0, 300) });
    await stopRun(userId, runId, 'worker_lost', { message: String(error).slice(0, 300) }).catch(() => undefined);
    return 'ran';
  } finally {
    clearInterval(heartbeat);
    await store.releaseRunLease(userId, runId, leaseOwner).catch(() => undefined);
  }
}

function isRlsUnavailable(error: unknown): boolean {
  return error instanceof AppError && error.code === 'UNAVAILABLE' && (error.details as { reason?: string } | undefined)?.reason === 'rls_unavailable';
}

/** Records `rls_unavailable` through the one narrowly scoped owner-connection write (the RLS path is what failed). */
async function failRlsUnavailable(runId: string, error: unknown): Promise<void> {
  logger.error('runs.rls.unavailable', { runId });
  await store.systemFailRunRlsUnavailable(runId, error instanceof AppError ? error.message : 'Row-level security is not enforced.').catch((failure: unknown) => logger.error('runs.rls.failRecordFailed', { runId, error: String(failure).slice(0, 200) }));
}

async function drive(userId: string, runId: string): Promise<void> {
  for (let guard = 0; guard < 200; guard += 1) {
    if (leaseLost()) return;
    const run = await store.readRun(userId, runId);
    if (!run || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) return;
    if (run.cancelRequestedAt) {
      await cancelRemaining(userId, run);
      return;
    }
    const limits = limitsFor(run.tier as Tier);

    if (run.status === 'QUEUED' || (run.status === 'PLANNING' && !run.plan)) {
      if (!(await plan(userId, run, limits))) return;
      continue;
    }
    if (run.status === 'WAITING_APPROVAL') {
      if ((await settleWaiting(userId, run)) === 'stop') return;
      continue;
    }
    if (run.status !== 'RUNNING') return;
    const next = await nextStep(userId, run, limits);
    if (next === 'stop') return;
  }
}

/**
 * A run parked on an approval, settled deterministically from the waiting
 * step's approvals (newest decisions win in this order):
 * - an open request (PENDING, within its TTL): keep waiting for the person;
 * - APPROVED within its TTL: resume;
 * - REJECTED: the step is skipped and the run stops (`approval_rejected`);
 * - otherwise nothing can authorise it any more (expired, cancelled or already
 *   used): open requests past their TTL are expired, the step is skipped and
 *   the run stops (`approval_expired`). The TTL itself is unchanged.
 * - No step is waiting (an earlier runner stopped part-way): resume, and the
 *   step logic settles the run from its steps.
 */
async function settleWaiting(userId: string, run: ResearchRun): Promise<'continue' | 'stop'> {
  const steps = await store.readSteps(userId, run.id);
  const waiting = steps.find((step) => step.status === 'WAITING_APPROVAL');
  const resume = async () => ((await store.transitionRun(userId, run.id, ['WAITING_APPROVAL'], 'RUNNING', { wait: 'resume' }, { type: 'run.resumed' })) ? 'continue' : 'stop');
  if (!waiting) return resume();
  const approvals = await store.approvalsForStep(userId, waiting.id);
  const now = Date.now();
  if (approvals.some((approval) => approval.status === 'PENDING' && approval.expiresAt.getTime() > now)) return 'stop';
  if (approvals.some((approval) => approval.status === 'APPROVED' && approval.expiresAt.getTime() > now)) return resume();
  if (approvals.some((approval) => approval.status === 'REJECTED')) {
    await store.transitionStep(userId, waiting, ['WAITING_APPROVAL'], 'SKIPPED', { error: { code: 'approval_rejected' }, finishedAt: new Date() });
    await stopRun(userId, run.id, 'approval_rejected');
    return 'stop';
  }
  for (const approval of approvals) {
    if (approval.status === 'PENDING' || approval.status === 'APPROVED') await store.expireApproval(userId, approval, 'timed_out');
  }
  await store.transitionStep(userId, waiting, ['WAITING_APPROVAL'], 'SKIPPED', { error: { code: 'approval_expired' }, finishedAt: new Date() });
  await stopRun(userId, run.id, 'approval_expired');
  return 'stop';
}

/* -------------------------------------------------------------------------- */
/*                                   Planning                                  */
/* -------------------------------------------------------------------------- */

async function plan(userId: string, run: ResearchRun, limits: Readonly<RunLimits>): Promise<boolean> {
  if (run.status === 'QUEUED' && !(await store.transitionRun(userId, run.id, ['QUEUED'], 'PLANNING', { startedAt: new Date() }))) return false;
  const role = await productionPolicyDeps.role(run.projectId, userId);
  if (!role || role === 'VIEWER') {
    await stopRun(userId, run.id, 'policy_denied', { message: 'The run’s owner can no longer edit this project.' });
    return false;
  }
  let result: Awaited<ReturnType<typeof planRun>>;
  try {
    result = await planRun({ userId, projectId: run.projectId, intent: run.intent, context: run.context, role: role as ProjectRole, tier: run.tier as Tier, limits });
  } catch (error) {
    await stopRun(userId, run.id, 'planner_failed', { message: error instanceof AppError ? error.message : 'The plan could not be made.' });
    return false;
  }
  if (!result.ok) {
    await stopRun(userId, run.id, 'plan_invalid', { errors: result.errors });
    return false;
  }
  return store.recordPlan(userId, run.id, { summary: result.plan.summary, steps: result.plan.steps.map(({ seq, tool, label, dependsOn }) => ({ seq, tool, label, dependsOn })) }, result.plan.steps, result.meta);
}

/* -------------------------------------------------------------------------- */
/*                                    Steps                                    */
/* -------------------------------------------------------------------------- */

const OPEN = ['QUEUED', 'AUTHORIZED', 'WAITING_APPROVAL'];

async function nextStep(userId: string, run: ResearchRun, limits: Readonly<RunLimits>): Promise<'continue' | 'stop'> {
  let steps = await store.readSteps(userId, run.id);

  /* We hold the lease, so a RUNNING step is stranded: its runner died mid-step. */
  for (const step of steps.filter((candidate) => candidate.status === 'RUNNING')) {
    await failAttempt(userId, run, step, { code: 'interrupted', message: 'The worker stopped during this step.' }, true, limits);
  }
  if (steps.some((step) => step.status === 'RUNNING')) steps = await store.readSteps(userId, run.id);

  /* The run's time limit, before anything starts: active time only (waiting on an approval is bounded by its own TTL). */
  if (activeElapsedMs(run.startedAt, run.spent, Date.now()) > limits.maxDurationMs) {
    await stopRun(userId, run.id, 'limit_time');
    return 'stop';
  }

  const bySeq = new Map(steps.map((step) => [step.seq, step]));
  const failedFinal = (step: RunStep) => step.status === 'FAILED' && step.attempts >= step.maxAttempts;

  /* Steps whose dependency can no longer succeed are skipped, with the reason. */
  for (const step of steps) {
    if (!OPEN.includes(step.status)) continue;
    const broken = (step.dependsOn as number[]).some((seq) => {
      const dependency = bySeq.get(seq);
      return !dependency || failedFinal(dependency) || dependency.status === 'SKIPPED' || dependency.status === 'CANCELLED';
    });
    if (broken) await store.transitionStep(userId, step, ['QUEUED', 'AUTHORIZED', 'WAITING_APPROVAL'], 'SKIPPED', { error: { code: 'dependency_failed' }, finishedAt: new Date() });
  }
  steps = await store.readSteps(userId, run.id);

  const retrying = steps.find((step) => step.status === 'FAILED' && step.attempts < step.maxAttempts);
  const ready = retrying ?? steps.find((step) => OPEN.includes(step.status) && (step.dependsOn as number[]).every((seq) => bySeq.get(seq)?.status === 'SUCCEEDED'));

  if (!ready) {
    const open = steps.filter((step) => OPEN.includes(step.status));
    if (open.length > 0) {
      /* Open steps that can never become ready: a plan inconsistency. */
      await stopRun(userId, run.id, 'dependency_failed');
      return 'stop';
    }
    const failure = steps.find((step) => step.status !== 'SUCCEEDED');
    if (!failure) {
      await store.transitionRun(userId, run.id, ['RUNNING'], 'SUCCEEDED', { stopReason: 'completed', spent: await spentOf(run, steps) });
      return 'stop';
    }
    const code = (failure.error as { code?: string } | null)?.code;
    await stopRun(userId, run.id, (code && ['policy_denied', 'approval_rejected', 'approval_expired', 'dependency_failed'].includes(code) ? code : 'tool_failed') as StopReason);
    return 'stop';
  }

  if (ready.status === 'FAILED') {
    /* A retry: back to the queue with the same validated input and idempotency key. */
    if (!(await store.transitionStep(userId, ready, ['FAILED'], 'QUEUED', { claimToken: null, startedAt: null }, { event: { type: 'step.retry', data: { attempts: ready.attempts } } }))) return 'stop';
    return 'continue';
  }

  return runStep(userId, run, ready, steps, limits);
}

async function runStep(userId: string, run: ResearchRun, step: RunStep, steps: RunStep[], limits: Readonly<RunLimits>): Promise<'continue' | 'stop'> {
  const tool = toolByName(step.tool);
  if (!tool || tool.version !== step.toolVersion) {
    await store.transitionStep(userId, step, ['QUEUED', 'AUTHORIZED', 'WAITING_APPROVAL'], 'SKIPPED', { error: { code: 'tool_unavailable' }, finishedAt: new Date() });
    await stopRun(userId, run.id, 'policy_denied', { message: `Tool ${step.tool}@${step.toolVersion} is not available.` });
    return 'stop';
  }

  /*
   * An AUTHORIZED step at this point was authorised but never claimed (a
   * runner died in between, before authorise and claim became one
   * transaction). Its approval, if any, was consumed, so back to the queue:
   * the policy decides again, and asks again if the action needs it.
   */
  if (step.status === 'AUTHORIZED') {
    await store.transitionStep(userId, step, ['AUTHORIZED'], 'QUEUED', {}, { event: { type: 'step.requeued', data: { reason: 'authorised_not_claimed' } } });
    return 'continue';
  }

  /* 1. Resolve references to earlier outputs, then validate against the tool's schema (written once). */
  let validated = step.validatedInput;
  if (!validated) {
    const outputs = new Map(steps.filter((candidate) => candidate.status === 'SUCCEEDED').map((candidate) => [candidate.seq, ((candidate.output as { output?: Record<string, unknown> } | null)?.output ?? {}) as Record<string, unknown>]));
    let parsed: { success: true; data: Record<string, unknown> } | { success: false; message: string };
    try {
      const result = (tool.input as import('zod').ZodType<Record<string, unknown>>).safeParse(resolveReferences(step.input, outputs));
      parsed = result.success ? { success: true, data: result.data } : { success: false, message: result.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
    } catch (error) {
      parsed = { success: false, message: String((error as Error).message).slice(0, 300) };
    }
    if (!parsed.success || bytesOf(parsed.data) > limits.maxStepInputBytes) {
      await store.transitionStep(userId, step, ['QUEUED'], 'SKIPPED', { error: { code: 'invalid_input', message: parsed.success ? 'input too large' : parsed.message }, finishedAt: new Date() });
      await stopRun(userId, run.id, 'plan_invalid');
      return 'stop';
    }
    validated = parsed.data;
    const hash = inputHash(validated);
    const key = stepIdempotencyKey({ projectId: run.projectId, runId: run.id, seq: step.seq, tool: tool.name, toolVersion: tool.version, inputHash: hash });
    if (!(await store.transitionStep(userId, step, ['QUEUED'], 'QUEUED', { validatedInput: validated, inputHash: hash, idempotencyKey: key }, { event: { type: 'step.validated', data: { inputHash: hash } } }))) return 'stop';
    step = { ...step, validatedInput: validated, inputHash: hash, idempotencyKey: key };
  }

  /* 2. Policy, immediately before execution. */
  const approvals = await store.approvalsForStep(userId, step.id);
  const decision = await decide({
    userId,
    projectId: run.projectId,
    toolName: tool.name,
    input: validated,
    execution: 'run',
    run: { id: run.id, status: run.status, cancelRequested: Boolean(run.cancelRequestedAt), startedAt: run.startedAt, retries: Number((run.spent as Record<string, number>).retries ?? 0), waitedMs: Number((run.spent as Record<string, number>).waitedMs ?? 0) },
    stepId: step.id,
    inputHash: step.inputHash ?? undefined,
    approvals: approvals.map((approval) => ({ id: approval.id, status: approval.status, actionHash: approval.actionHash, expiresAt: approval.expiresAt })),
    toolContext: { userId, projectId: run.projectId, tier: run.tier as Tier, execution: 'run', runId: run.id, stepId: step.id },
  });

  if (decision.outcome === 'DENY') {
    await store.transitionStep(userId, step, ['QUEUED', 'AUTHORIZED', 'WAITING_APPROVAL'], 'SKIPPED', { policy: storedDecision(decision), error: { code: 'policy_denied', rule: decision.reason ?? null }, finishedAt: new Date() });
    const limit = decision.rules.find((rule) => !rule.ok)?.detail;
    await stopRun(userId, run.id, (limit && /^limit_/.test(limit) ? limit : 'policy_denied') as StopReason, { rule: decision.reason ?? null });
    return 'stop';
  }

  if (decision.outcome === 'REQUIRE_APPROVAL') {
    const need = decision.approval!.need;
    /* Parks the step and the run together, or neither (then the loop reads the state again). */
    await store.requestApproval(userId, step, {
      runId: run.id,
      stepId: step.id,
      projectId: run.projectId,
      actionHash: decision.approval!.actionHash,
      reason: need.reason.slice(0, 64),
      action: {
        tool: tool.name,
        toolVersion: tool.version,
        inputHash: step.inputHash,
        summary: need.summary,
        targets: need.targets,
        impactHash: need.impactHash ?? null,
        preview: need.preview ?? {},
        sideEffect: tool.sideEffect,
        risk: tool.risk,
      },
      expiresAt: new Date(Date.now() + limits.approvalTtlMs),
    });
    return 'stop';
  }

  /*
   * 3–4. Authorise and claim in ONE transaction: consume the approval (single
   * use), record the decision, and claim the step as RUNNING (counting the
   * attempt, so a crash mid-step is counted). Either all of it commits or none:
   * a consumed approval can never be left behind with a step that is not running.
   */
  const token = randomUUID();
  const attempts = step.attempts + 1;
  const claimed = await withRunScope(userId, async (tx) => {
    if (decision.approval?.approvalId) {
      const approval = approvals.find((candidate) => candidate.id === decision.approval!.approvalId)!;
      if (!(await store.consumeApproval(userId, approval, decision.approval.actionHash, tx))) return false;
    }
    if (!(await store.transitionStep(userId, step, ['QUEUED', 'WAITING_APPROVAL'], 'AUTHORIZED', { policy: storedDecision(decision) }, { tx, event: { type: 'step.authorized', data: { rules: decision.rules.length } } }))) throw new NotClaimed();
    if (!(await store.transitionStep(userId, step, ['AUTHORIZED'], 'RUNNING', { claimToken: token, attempts, startedAt: new Date(), finishedAt: null }, { tx, event: { type: 'step.running', data: { attempt: attempts } } }))) throw new NotClaimed();
    return true;
  }).catch((error: unknown) => {
    if (error instanceof NotClaimed) return false;
    throw error;
  });
  if (!claimed) return 'continue';

  /* 5. Execute: outside any transaction, with a timeout and cancellation. */
  const started = Date.now();
  try {
    const result = await executeTool(userId, run, step, tool, validated, decision, limits);
    if (leaseLost()) return 'stop'; /* the lease went while the tool ran: the runner that took over settles the step */
    const output = (tool.output as import('zod').ZodType<Record<string, unknown>>).safeParse(result.output);
    if (!output.success) throw new AppError('INTERNAL', 'The tool returned an output outside its schema.', 'أعادت الأداة نتيجة خارج مخططها.', { reason: 'invalid_output' });
    const stored = { output: output.data };
    if (bytesOf(stored) > limits.maxStepOutputBytes) throw new AppError('VALIDATION', 'The tool output is larger than a step may store.', 'نتيجة الأداة أكبر مما تحفظه الخطوة.', { reason: 'output_too_large' });
    const settled = await store.transitionStep(
      userId,
      step,
      ['RUNNING'],
      'SUCCEEDED',
      { output: stored, outputRef: result.ref ?? null, finishedAt: new Date(), durationMs: Date.now() - started, error: null },
      { claimToken: token, event: { type: 'step.succeeded', data: { ref: result.ref ?? null, durationMs: Date.now() - started } } },
    );
    if (settled) await store.patchRun(userId, run.id, { spent: await spentOf(run, await store.readSteps(userId, run.id)) });
    return 'continue';
  } catch (error) {
    if (error instanceof StepLeaseLost) return 'stop';
    if (error instanceof StepCancelled) {
      await store.transitionStep(userId, step, ['RUNNING'], 'CANCELLED', { finishedAt: new Date(), durationMs: Date.now() - started, error: { code: 'cancelled' } }, { claimToken: token });
      return 'continue';
    }
    const code = error instanceof StepTimedOut ? 'timeout' : error instanceof AppError ? ((error.details as { reason?: string } | undefined)?.reason ?? error.code) : 'tool_error';
    const permanent = error instanceof AppError && PERMANENT.has(error.code);
    const message = error instanceof AppError ? error.message : error instanceof StepTimedOut ? 'The step took longer than its limit.' : 'The tool failed.';
    if (!(error instanceof AppError)) logger.error('runs.step.threw', { runId: run.id, stepId: step.id, tool: tool.name, error: String(error).slice(0, 300) });
    await failAttempt(userId, run, { ...step, attempts, claimToken: token, status: 'RUNNING' }, { code, message: message.slice(0, 300) }, !permanent && tool.sideEffect !== 'destructive', limits, token);
    return 'continue';
  }
}

async function executeTool(
  userId: string,
  run: ResearchRun,
  step: RunStep,
  tool: ToolDef,
  input: Record<string, unknown>,
  decision: PolicyDecision,
  limits: Readonly<RunLimits>,
) {
  const controller = new AbortController();
  let stop: ((reason: 'timeout' | 'cancelled' | 'lease_lost') => void) | undefined;
  const stopped = new Promise<'timeout' | 'cancelled' | 'lease_lost'>((resolve) => {
    stop = resolve;
  });
  /* The lease was lost: abort the tool and stop waiting for it (no settle; see advanceRun). */
  const keeper = keeperScope.getStore();
  const onLeaseLost = () => {
    controller.abort();
    stop?.('lease_lost');
  };
  if (keeper?.lost) onLeaseLost();
  else keeper?.signal.addEventListener('abort', onLeaseLost, { once: true });
  const timeout = setTimeout(() => {
    controller.abort();
    stop?.('timeout');
  }, Math.min(tool.timeoutMs, limits.maxStepMs));
  const watch = setInterval(() => {
    void store
      .readRun(userId, run.id)
      .then((current) => {
        if (current?.cancelRequestedAt) {
          controller.abort();
          stop?.('cancelled');
        }
      })
      .catch(() => undefined);
  }, CANCEL_POLL_MS);
  watch.unref?.();
  try {
    const running = withCallIds({ projectId: run.projectId, runId: run.id, stepId: step.id }, () =>
      tool.execute(input as never, {
        userId,
        projectId: run.projectId,
        tier: run.tier as Tier,
        execution: 'run',
        runId: run.id,
        stepId: step.id,
        idempotencyKey: step.idempotencyKey!,
        signal: controller.signal,
        approvedImpactHash: decision.approval?.need.impactHash ?? null,
      }),
    );
    running.catch(() => undefined);
    const raced = await Promise.race([running.then((result) => ({ result })), stopped]);
    if (raced === 'lease_lost') throw new StepLeaseLost();
    if (raced === 'cancelled') throw new StepCancelled();
    if (raced === 'timeout') throw new StepTimedOut();
    return raced.result;
  } finally {
    clearTimeout(timeout);
    clearInterval(watch);
    keeper?.signal.removeEventListener('abort', onLeaseLost);
  }
}

/** A failed attempt: retried later if attempts and the run's retry budget allow, else final. */
async function failAttempt(
  userId: string,
  run: ResearchRun,
  step: RunStep,
  error: { code: string; message: string },
  retryable: boolean,
  limits: Readonly<RunLimits>,
  claimToken?: string,
): Promise<void> {
  const retries = Number((run.spent as Record<string, number>).retries ?? 0);
  const attempts = Math.max(step.attempts, 1);
  const canRetry = retryable && attempts < step.maxAttempts && retries < limits.maxRetriesPerRun;
  const failed = await store.transitionStep(
    userId,
    step,
    ['RUNNING'],
    'FAILED',
    { attempts, error: { ...error, final: !canRetry }, finishedAt: new Date() },
    { ...(claimToken ? { claimToken } : {}), event: { type: canRetry ? 'step.failed_retrying' : 'step.failed', data: { code: error.code, attempts } } },
  );
  if (!failed) return;
  if (!canRetry && attempts < step.maxAttempts) {
    /* Not retried (permanent error or run retry budget): make it final so the run stops. */
    await store.exhaustAttempts(userId, step.id);
  }
  if (canRetry) await store.patchRun(userId, run.id, { spent: { retries: retries + 1 } });
}

async function spentOf(run: ResearchRun, steps: RunStep[]): Promise<Record<string, number>> {
  const usage = await productionPolicyDeps.runUsage(run.id);
  /* Only what is recomputed here: `spent` is merged, so other counters (retries, waitedMs) are kept. */
  return {
    steps: steps.filter((step) => step.status === 'SUCCEEDED').length,
    tokens: usage.tokens,
    costMicroUsd: usage.costMicroUsd,
  };
}

/** Ends a run as FAILED with a recorded reason (or CANCELLED when that is the reason). */
export async function stopRun(userId: string, runId: string, reason: StopReason, error: Record<string, unknown> = {}): Promise<boolean> {
  const to = reason === 'cancelled' ? 'CANCELLED' : 'FAILED';
  return store.transitionRun(userId, runId, ['QUEUED', 'PLANNING', 'RUNNING', 'WAITING_APPROVAL'], to, { stopReason: reason, error: { reason, ...error } }, { type: `run.${to.toLowerCase()}`, data: { stopReason: reason } });
}

/** Cancels every open step and expires open approvals, then the run (monotonic). */
export async function cancelRemaining(userId: string, run: ResearchRun): Promise<void> {
  const steps = await store.readSteps(userId, run.id);
  for (const step of steps) {
    if (['QUEUED', 'AUTHORIZED', 'WAITING_APPROVAL'].includes(step.status)) {
      await store.transitionStep(userId, step, ['QUEUED', 'AUTHORIZED', 'WAITING_APPROVAL'], 'CANCELLED', { finishedAt: new Date(), error: { code: 'cancelled' } });
    }
    if (step.status === 'FAILED' && step.attempts < step.maxAttempts) {
      await store.exhaustAttempts(userId, step.id);
    }
    for (const approval of await store.approvalsForStep(userId, step.id)) {
      if (approval.status === 'PENDING' || approval.status === 'APPROVED') await store.expireApproval(userId, approval, 'cancelled');
    }
  }
  await stopRun(userId, run.id, 'cancelled');
}
