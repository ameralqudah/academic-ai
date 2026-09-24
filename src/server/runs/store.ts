/**
 * Reading and writing the run tables (P1-D). The only module that touches
 * them; every statement runs under `withRunScope` (row-level security as the
 * acting user), except the few system reads marked as such.
 *
 * Every state change is conditional on the state it expects, returns whether
 * it applied, and writes a run event in the same transaction.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import { researchRuns, runApprovals, runEvents, runSteps, type ResearchRun, type RunApproval, type RunEvent, type RunStep } from '@/server/db/schema';

import { systemDb, withRunScope, type RunTx } from './db-scope';
import { bytesOf } from './limits';
import { TERMINAL_RUN, type ApprovalStatus, type RunStatus, type StepStatus, type StopReason } from './state';

const EVENT_BYTES = 3_500;

/** Event data as stored: bounded, and never raw datasets or secrets (callers pass summaries). */
function boundedData(data: Record<string, unknown>): Record<string, unknown> {
  if (bytesOf(data) <= EVENT_BYTES) return data;
  const small: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const candidate = { ...small, [key]: typeof value === 'string' ? value.slice(0, 300) : value };
    if (bytesOf(candidate) > EVENT_BYTES) {
      small.truncated = true;
      break;
    }
    small[key] = candidate[key];
  }
  return small;
}

export async function appendEvent(tx: RunTx, event: { runId: string; projectId: string; userId: string; stepId?: string | null; type: string; data?: Record<string, unknown> }): Promise<void> {
  await tx.insert(runEvents).values({
    runId: event.runId,
    projectId: event.projectId,
    userId: event.userId,
    stepId: event.stepId ?? null,
    type: event.type.slice(0, 40),
    data: boundedData(event.data ?? {}),
  });
}

/* -------------------------------------------------------------------------- */
/*                              Lease fencing                                 */
/* -------------------------------------------------------------------------- */

/**
 * While a runner holds a run's lease, every run and step write it makes is
 * fenced on that lease: it applies only while `research_runs.lease_owner` is
 * still this runner. A stale runner (its lease lapsed and another runner took
 * the run) therefore cannot change the run or its steps. Writes outside a
 * runner (the service: create, cancel, decide; the reaper) are not fenced.
 */
const leaseHolder = new AsyncLocalStorage<{ runId: string; owner: string }>();

export function asLeaseHolder<T>(runId: string, owner: string, work: () => Promise<T>): Promise<T> {
  return leaseHolder.run({ runId, owner }, work);
}

function runLeaseFence(runId: string) {
  const held = leaseHolder.getStore();
  return held && held.runId === runId ? eq(researchRuns.leaseOwner, held.owner) : undefined;
}

/** For a step write: its run must still be leased by this runner. Without `runId`, applies to whatever run the runner holds. */
function stepLeaseFence(runId?: string) {
  const held = leaseHolder.getStore();
  if (!held || (runId && held.runId !== runId)) return undefined;
  return sql`exists (select 1 from ${researchRuns} where ${researchRuns.id} = ${runSteps.runId} and ${researchRuns.leaseOwner} = ${held.owner})`;
}

/* -------------------------------------------------------------------------- */
/*                                    Runs                                    */
/* -------------------------------------------------------------------------- */

export interface NewRun {
  projectId: string;
  intent: string;
  context: Record<string, unknown>;
  tier: string;
  limits: Record<string, number>;
  idempotencyKey: string | null;
}

/**
 * Creates a run, idempotent on (user, key), refusing when the user already has
 * `maxActive` unfinished runs. The count and the insert are serialised per user.
 */
export async function createRun(userId: string, run: NewRun, maxActive: number): Promise<{ run: ResearchRun; created: boolean } | { refused: 'too_many_active' }> {
  return withRunScope(userId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`research-runs:${userId}`}))`);
    if (run.idempotencyKey) {
      const [existing] = await tx.select().from(researchRuns).where(and(eq(researchRuns.userId, userId), eq(researchRuns.idempotencyKey, run.idempotencyKey))).limit(1);
      if (existing) return { run: existing, created: false };
    }
    const active = await tx
      .select({ id: researchRuns.id })
      .from(researchRuns)
      .where(and(eq(researchRuns.userId, userId), inArray(researchRuns.status, ['QUEUED', 'PLANNING', 'RUNNING', 'WAITING_APPROVAL'])));
    if (active.length >= maxActive) return { refused: 'too_many_active' as const };
    const [row] = await tx
      .insert(researchRuns)
      .values({ projectId: run.projectId, userId, intent: run.intent, context: run.context, tier: run.tier, limits: run.limits, idempotencyKey: run.idempotencyKey })
      .returning();
    await appendEvent(tx, { runId: row!.id, projectId: run.projectId, userId, type: 'run.created', data: { tier: run.tier, intentChars: run.intent.length } });
    return { run: row!, created: true };
  });
}

/** The run if the user may see it (RLS), in this project. */
export async function readRun(userId: string, runId: string, projectId?: string): Promise<ResearchRun | null> {
  return withRunScope(userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(researchRuns)
      .where(and(eq(researchRuns.id, runId), ...(projectId ? [eq(researchRuns.projectId, projectId)] : [])))
      .limit(1);
    return row ?? null;
  });
}

export async function listRuns(userId: string, projectId: string, limit = 50): Promise<ResearchRun[]> {
  return withRunScope(userId, (tx) => tx.select().from(researchRuns).where(eq(researchRuns.projectId, projectId)).orderBy(desc(researchRuns.createdAt)).limit(Math.min(limit, 100)));
}

export interface RunView {
  run: ResearchRun;
  steps: RunStep[];
  approvals: RunApproval[];
  events: RunEvent[];
}

export async function readRunView(userId: string, runId: string, projectId: string, eventsAfter = 0): Promise<RunView | null> {
  return withRunScope(userId, async (tx) => {
    const [run] = await tx.select().from(researchRuns).where(and(eq(researchRuns.id, runId), eq(researchRuns.projectId, projectId))).limit(1);
    if (!run) return null;
    const steps = await tx.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq));
    const approvals = await tx.select().from(runApprovals).where(eq(runApprovals.runId, runId)).orderBy(asc(runApprovals.createdAt));
    const events = await tx.select().from(runEvents).where(and(eq(runEvents.runId, runId), gt(runEvents.id, eventsAfter))).orderBy(asc(runEvents.id)).limit(200);
    return { run, steps, approvals, events };
  });
}

export interface RunPatch {
  plan?: Record<string, unknown>;
  stopReason?: StopReason | null;
  spent?: Record<string, number>;
  planner?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
  replans?: number;
  startedAt?: Date;
  /**
   * The approval clock, kept in `spent` by the database's clock: `park` starts
   * a wait (`waitingSince`), `resume` adds it to `waitedMs` and clears it.
   */
  wait?: 'park' | 'resume';
}

/** `spent` is merged, never replaced, so a stale snapshot cannot drop a counter written since. */
function spentSet(patch: Pick<RunPatch, 'spent' | 'wait'>) {
  const nowMs = sql`(extract(epoch from now()) * 1000)::bigint`;
  let expression = sql`${researchRuns.spent}`;
  if (patch.spent) expression = sql`(${expression} || ${JSON.stringify(patch.spent)}::jsonb)`;
  if (patch.wait === 'park') expression = sql`(${expression} || jsonb_build_object('waitingSince', ${nowMs}))`;
  if (patch.wait === 'resume') {
    expression = sql`((${expression} - 'waitingSince') || jsonb_build_object('waitedMs', coalesce((${researchRuns.spent}->>'waitedMs')::bigint, 0) + greatest(0, ${nowMs} - coalesce((${researchRuns.spent}->>'waitingSince')::bigint, ${nowMs}))))`;
  }
  return patch.spent || patch.wait ? { spent: expression } : {};
}

/**
 * Moves a run from one of `from` to `to` (conditional). A terminal state records
 * `finished_at`; a failure records its stop reason. Returns whether it applied.
 */
export async function transitionRun(
  userId: string,
  runId: string,
  from: RunStatus[],
  to: RunStatus,
  patch: RunPatch = {},
  event?: { type: string; data?: Record<string, unknown> },
  tx?: RunTx,
): Promise<boolean> {
  const { spent, wait, ...rest } = patch;
  const work = async (t: RunTx) => {
    const rows = await t
      .update(researchRuns)
      .set({
        status: to,
        updatedAt: new Date(),
        ...(TERMINAL_RUN.has(to) ? { finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } : {}),
        ...rest,
        ...spentSet({ spent, wait }),
        /* The run moved: claims are counted again from here (see claimRunLease). */
        attempts: 0,
      })
      .where(and(eq(researchRuns.id, runId), inArray(researchRuns.status, from), runLeaseFence(runId)))
      .returning({ id: researchRuns.id, projectId: researchRuns.projectId });
    if (rows.length === 0) return false;
    await appendEvent(t, { runId, projectId: rows[0]!.projectId, userId, type: event?.type ?? `run.${to.toLowerCase()}`, data: { from, to, ...(patch.stopReason ? { stopReason: patch.stopReason } : {}), ...(event?.data ?? {}) } });
    return true;
  };
  return tx ? work(tx) : withRunScope(userId, work);
}

/** Updates progress fields without changing status (spent, planner metadata). */
export async function patchRun(userId: string, runId: string, patch: Pick<RunPatch, 'spent' | 'planner'>): Promise<void> {
  await withRunScope(userId, async (tx) => {
    const { spent, ...rest } = patch;
    await tx.update(researchRuns).set({ ...rest, ...spentSet({ spent }), updatedAt: new Date() }).where(and(eq(researchRuns.id, runId), runLeaseFence(runId)));
  });
}

/** Records a cancel request (monotonic: set once). Returns the run as it is now. */
export async function requestCancel(userId: string, runId: string, projectId: string): Promise<ResearchRun | null> {
  return withRunScope(userId, async (tx) => {
    const rows = await tx
      .update(researchRuns)
      .set({ cancelRequestedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(researchRuns.id, runId), eq(researchRuns.projectId, projectId), isNull(researchRuns.cancelRequestedAt), inArray(researchRuns.status, ['QUEUED', 'PLANNING', 'RUNNING', 'WAITING_APPROVAL'])))
      .returning();
    if (rows[0]) await appendEvent(tx, { runId, projectId, userId, type: 'run.cancel_requested' });
    const [row] = await tx.select().from(researchRuns).where(and(eq(researchRuns.id, runId), eq(researchRuns.projectId, projectId))).limit(1);
    return row ?? null;
  });
}

/* -------------------------------- Leases -------------------------------- */

export const RUN_LEASE_SECONDS = 120;

/**
 * Claims a run's lease. Returns the number of claims since the run last
 * changed state (`attempts` is reset by every transition), or null when
 * another runner holds it. A run claimed again and again without moving is
 * stopped by the executor (MAX_RUN_CLAIMS), so a run the engine cannot
 * advance is never re-dispatched forever.
 */
export async function claimRunLease(userId: string, runId: string, owner: string): Promise<number | null> {
  return withRunScope(userId, async (tx) => {
    const rows = await tx
      .update(researchRuns)
      .set({ leaseOwner: owner, leaseExpiresAt: sql`now() + make_interval(secs => ${RUN_LEASE_SECONDS})`, attempts: sql`${researchRuns.attempts} + 1`, updatedAt: new Date() })
      .where(and(eq(researchRuns.id, runId), or(isNull(researchRuns.leaseExpiresAt), lt(researchRuns.leaseExpiresAt, sql`now()`), eq(researchRuns.leaseOwner, owner))))
      .returning({ attempts: researchRuns.attempts });
    return rows[0]?.attempts ?? null;
  });
}

/** Claims without a state change after which a run is stopped as `worker_lost`. */
export const MAX_RUN_CLAIMS = 20;

export async function renewRunLease(userId: string, runId: string, owner: string): Promise<boolean> {
  return withRunScope(userId, async (tx) => {
    const rows = await tx
      .update(researchRuns)
      .set({ leaseExpiresAt: sql`now() + make_interval(secs => ${RUN_LEASE_SECONDS})` })
      .where(and(eq(researchRuns.id, runId), eq(researchRuns.leaseOwner, owner)))
      .returning({ id: researchRuns.id });
    return rows.length > 0;
  });
}

export async function releaseRunLease(userId: string, runId: string, owner: string): Promise<void> {
  await withRunScope(userId, async (tx) => {
    await tx.update(researchRuns).set({ leaseOwner: null, leaseExpiresAt: null }).where(and(eq(researchRuns.id, runId), eq(researchRuns.leaseOwner, owner)));
  });
}

/* -------------------------------------------------------------------------- */
/*                                    Steps                                   */
/* -------------------------------------------------------------------------- */

export interface NewStep {
  seq: number;
  tool: string;
  toolVersion: string;
  label: string;
  dependsOn: number[];
  input: Record<string, unknown>;
  maxAttempts: number;
}

/** Records the plan and its steps, and moves the run PLANNING → RUNNING, in one transaction. */
export async function recordPlan(userId: string, runId: string, plan: Record<string, unknown>, steps: NewStep[], planner: Record<string, unknown>): Promise<boolean> {
  return withRunScope(userId, async (tx) => {
    const [run] = await tx.select().from(researchRuns).where(eq(researchRuns.id, runId)).limit(1);
    if (!run || run.status !== 'PLANNING' || run.plan) return false;
    if (steps.length) {
      await tx.insert(runSteps).values(steps.map((step) => ({ runId, seq: step.seq, tool: step.tool, toolVersion: step.toolVersion, label: step.label.slice(0, 200), dependsOn: step.dependsOn, input: step.input, maxAttempts: step.maxAttempts })));
    }
    return transitionRun(userId, runId, ['PLANNING'], 'RUNNING', { plan, planner }, { type: 'run.planned', data: { steps: steps.length, tools: steps.map((step) => step.tool) } }, tx);
  });
}

export async function readSteps(userId: string, runId: string): Promise<RunStep[]> {
  return withRunScope(userId, (tx) => tx.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq)));
}

export interface StepPatch {
  validatedInput?: Record<string, unknown>;
  inputHash?: string;
  idempotencyKey?: string;
  policy?: Record<string, unknown>;
  approvalId?: string | null;
  claimToken?: string | null;
  attempts?: number;
  output?: Record<string, unknown>;
  outputRef?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  durationMs?: number | null;
}

/**
 * Moves a step from one of `from` to `to` (conditional; also on the claim token
 * when given). Writes the event with the run's project. Returns whether it applied.
 */
export async function transitionStep(
  userId: string,
  step: Pick<RunStep, 'id' | 'runId'>,
  from: StepStatus[],
  to: StepStatus,
  patch: StepPatch = {},
  options: { claimToken?: string; event?: { type: string; data?: Record<string, unknown> }; tx?: RunTx } = {},
): Promise<boolean> {
  const work = async (tx: RunTx) => {
    const rows = await tx
      .update(runSteps)
      .set({ status: to, updatedAt: new Date(), ...patch })
      .where(and(eq(runSteps.id, step.id), inArray(runSteps.status, from), ...(options.claimToken ? [eq(runSteps.claimToken, options.claimToken)] : []), stepLeaseFence(step.runId)))
      .returning({ id: runSteps.id });
    if (rows.length === 0) return false;
    const [run] = await tx.select({ projectId: researchRuns.projectId }).from(researchRuns).where(eq(researchRuns.id, step.runId)).limit(1);
    await appendEvent(tx, { runId: step.runId, projectId: run!.projectId, userId, stepId: step.id, type: options.event?.type ?? `step.${to.toLowerCase()}`, data: { from, to, ...(options.event?.data ?? {}) } });
    return true;
  };
  return options.tx ? work(options.tx) : withRunScope(userId, work);
}

/** Marks a failed step as final (no attempts left): a permanent error, or the run was cancelled. */
export async function exhaustAttempts(userId: string, stepId: string): Promise<void> {
  await withRunScope(userId, async (tx) => {
    await tx.update(runSteps).set({ attempts: sql`${runSteps.maxAttempts}`, updatedAt: new Date() }).where(and(eq(runSteps.id, stepId), eq(runSteps.status, 'FAILED'), stepLeaseFence()));
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Approvals                                 */
/* -------------------------------------------------------------------------- */

export interface NewApproval {
  runId: string;
  stepId: string;
  projectId: string;
  actionHash: string;
  action: Record<string, unknown>;
  reason: string;
  expiresAt: Date;
}

/**
 * Opens an approval request for a step and parks the step and the run, in one
 * transaction. An open request with the same hash is reused; one with a
 * different hash (the action changed) is expired first.
 */
export async function requestApproval(userId: string, step: RunStep, approval: NewApproval): Promise<RunApproval | null> {
  return withRunScope(userId, async (tx) => {
    const open = await tx.select().from(runApprovals).where(and(eq(runApprovals.stepId, step.id), inArray(runApprovals.status, ['PENDING', 'APPROVED'])));
    let current = open.find((row) => row.actionHash === approval.actionHash && row.expiresAt > new Date());
    for (const row of open) {
      if (row !== current) {
        await tx.update(runApprovals).set({ status: 'EXPIRED' }).where(and(eq(runApprovals.id, row.id), inArray(runApprovals.status, ['PENDING', 'APPROVED'])));
        await appendEvent(tx, { runId: approval.runId, projectId: approval.projectId, userId, stepId: step.id, type: 'approval.expired', data: { approvalId: row.id, reason: 'action_changed' } });
      }
    }
    if (!current) {
      const [row] = await tx.insert(runApprovals).values({ ...approval, userId }).returning();
      current = row!;
      await appendEvent(tx, { runId: approval.runId, projectId: approval.projectId, userId, stepId: step.id, type: 'approval.requested', data: { approvalId: current.id, reason: approval.reason, actionHash: approval.actionHash } });
    }
    /* Both or neither: a run parked without its step would wait on an approval no step can use. */
    if (!(await transitionStep(userId, step, ['QUEUED', 'WAITING_APPROVAL'], 'WAITING_APPROVAL', { approvalId: current.id }, { tx, event: { type: 'step.waiting_approval', data: { approvalId: current.id } } }))) throw new NotParked();
    if (!(await transitionRun(userId, approval.runId, ['RUNNING'], 'WAITING_APPROVAL', { wait: 'park' }, { type: 'run.waiting_approval', data: { approvalId: current.id, stepId: step.id } }, tx))) throw new NotParked();
    return current;
  }).catch((error: unknown) => {
    if (error instanceof NotParked) return null;
    throw error;
  });
}

/** Rolls back an approval request whose step or run is no longer where it was expected. */
class NotParked extends Error {}

export async function readApproval(userId: string, approvalId: string): Promise<RunApproval | null> {
  return withRunScope(userId, async (tx) => {
    const [row] = await tx.select().from(runApprovals).where(eq(runApprovals.id, approvalId)).limit(1);
    return row ?? null;
  });
}

/**
 * Records a decision on a PENDING approval (conditional). RLS lets only the
 * run's owner (an editor) or a project OWNER update it; the service checks the
 * same and the hash before calling.
 */
export async function decideApproval(
  userId: string,
  approval: RunApproval,
  decision: 'APPROVED' | 'REJECTED',
): Promise<boolean> {
  return withRunScope(userId, async (tx) => {
    const rows = await tx
      .update(runApprovals)
      .set({ status: decision, decidedBy: userId, decidedAt: new Date() })
      .where(and(eq(runApprovals.id, approval.id), eq(runApprovals.status, 'PENDING'), eq(runApprovals.actionHash, approval.actionHash), gt(runApprovals.expiresAt, sql`now()`)))
      .returning({ id: runApprovals.id });
    if (rows.length === 0) return false;
    await appendEvent(tx, { runId: approval.runId, projectId: approval.projectId, userId, stepId: approval.stepId, type: `approval.${decision.toLowerCase()}`, data: { approvalId: approval.id, actionHash: approval.actionHash } });
    return true;
  });
}

/** Consumes an APPROVED approval whose hash matches (single use). */
export async function consumeApproval(userId: string, approval: RunApproval, actionHash: string, tx: RunTx): Promise<boolean> {
  const rows = await tx
    .update(runApprovals)
    .set({ status: 'CONSUMED', consumedAt: new Date() })
    .where(and(eq(runApprovals.id, approval.id), eq(runApprovals.status, 'APPROVED'), eq(runApprovals.actionHash, actionHash), gt(runApprovals.expiresAt, sql`now()`)))
    .returning({ id: runApprovals.id });
  if (rows.length === 0) return false;
  await appendEvent(tx, { runId: approval.runId, projectId: approval.projectId, userId, stepId: approval.stepId, type: 'approval.consumed', data: { approvalId: approval.id } });
  return true;
}

export async function expireApproval(userId: string, approval: RunApproval, reason: string): Promise<boolean> {
  return withRunScope(userId, async (tx) => {
    const rows = await tx
      .update(runApprovals)
      .set({ status: 'EXPIRED' as ApprovalStatus })
      .where(and(eq(runApprovals.id, approval.id), inArray(runApprovals.status, ['PENDING', 'APPROVED'])))
      .returning({ id: runApprovals.id });
    if (rows.length === 0) return false;
    await appendEvent(tx, { runId: approval.runId, projectId: approval.projectId, userId, stepId: approval.stepId, type: 'approval.expired', data: { approvalId: approval.id, reason } });
    return true;
  });
}

export async function approvalsForStep(userId: string, stepId: string, tx?: RunTx): Promise<RunApproval[]> {
  const work = (t: RunTx) => t.select().from(runApprovals).where(eq(runApprovals.stepId, stepId)).orderBy(desc(runApprovals.createdAt));
  return tx ? work(tx) : withRunScope(userId, work);
}

/* -------------------------------------------------------------------------- */
/*                          System reads (owner role)                         */
/* -------------------------------------------------------------------------- */

/**
 * The owner of a run, for a job runner that has no session. Only identifies
 * whom to act as; everything after runs in `withRunScope` as that user.
 */
export async function systemRunOwner(runId: string): Promise<{ userId: string; projectId: string; status: string } | null> {
  const [row] = await systemDb.select({ userId: researchRuns.userId, projectId: researchRuns.projectId, status: researchRuns.status }).from(researchRuns).where(eq(researchRuns.id, runId)).limit(1);
  return row ?? null;
}

/**
 * Runs the reaper should pick up (a read of the owner connection; the run is
 * then advanced in `withRunScope` as its owner). Unfinished, no live lease, and:
 * - a runner disappeared (lease lapsed, or never taken for a while); or
 * - quiet for 2 minutes and needing attention: a cancellation to finish, or a
 *   wait on an approval that no PENDING, unexpired request can end any more
 *   (approved but never dispatched; rejected, expired or cancelled but never
 *   settled). A run waiting on a person, within the TTL, is never picked up.
 * Oldest first (then by id), in bounded batches, so what is picked up is
 * deterministic and a long tail cannot starve older runs. Every dispatch of a
 * picked run moves it (the claim refreshes `updated_at`), settles it, or finds
 * it leased; a run whose owner can no longer edit is settled
 * (`systemSettleIneligibleOwnerRun`), so none stays at the head forever.
 */
export const REAPER_RUN_BATCH = 50;

export async function systemStrandedRuns(limit = REAPER_RUN_BATCH): Promise<{ id: string; userId: string }[]> {
  const quiet = lt(researchRuns.updatedAt, sql`now() - interval '2 minutes'`);
  const leaseFree = or(isNull(researchRuns.leaseExpiresAt), lt(researchRuns.leaseExpiresAt, sql`now()`));
  const noOpenRequest = sql`not exists (select 1 from ${runApprovals} where ${runApprovals.runId} = ${researchRuns.id} and ${runApprovals.status} = 'PENDING' and ${runApprovals.expiresAt} > now())`;
  return systemDb
    .select({ id: researchRuns.id, userId: researchRuns.userId })
    .from(researchRuns)
    .where(
      and(
        inArray(researchRuns.status, ['QUEUED', 'PLANNING', 'RUNNING', 'WAITING_APPROVAL']),
        leaseFree,
        or(
          and(inArray(researchRuns.status, ['QUEUED', 'PLANNING', 'RUNNING']), or(lt(researchRuns.leaseExpiresAt, sql`now()`), and(isNull(researchRuns.leaseExpiresAt), quiet))),
          and(quiet, or(isNotNull(researchRuns.cancelRequestedAt), and(eq(researchRuns.status, 'WAITING_APPROVAL'), noOpenRequest))),
        ),
      ),
    )
    .orderBy(asc(researchRuns.updatedAt), asc(researchRuns.id))
    .limit(Math.max(1, limit));
}

/**
 * One of the two writes through the owner connection (P1-D WS1, approved): ends a
 * run as FAILED with `rls_unavailable` when the database can no longer enforce
 * row-level security for it. Fail-closed: nothing is executed; the run can
 * only stop. The row's triggers still enforce a legal transition. The other is
 * `systemSettleIneligibleOwnerRun`; every other write goes through
 * `withRunScope` (a smoke gate checks this).
 */
export async function systemFailRunRlsUnavailable(runId: string, message: string): Promise<boolean> {
  return systemDb.transaction(async (tx) => {
    const rows = await tx
      .update(researchRuns)
      .set({ status: 'FAILED', stopReason: 'rls_unavailable', error: { reason: 'rls_unavailable', message: message.slice(0, 300) }, finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(researchRuns.id, runId), inArray(researchRuns.status, ['QUEUED', 'PLANNING', 'RUNNING', 'WAITING_APPROVAL'])))
      .returning({ projectId: researchRuns.projectId, userId: researchRuns.userId });
    if (!rows[0]) return false;
    await appendEvent(tx, { runId, projectId: rows[0].projectId, userId: rows[0].userId, type: 'run.failed', data: { to: 'FAILED', stopReason: 'rls_unavailable', via: 'system' } });
    return true;
  });
}

/**
 * The second owner-connection write (WS1 follow-up M2): settles a run whose
 * owner can no longer edit its project (demoted below EDITOR, or removed).
 * Under RLS nobody can move such a run any more — its owner may not write it,
 * and no one else acts as its owner — so without this it would stay
 * unfinished and be re-dispatched by the reaper forever.
 *
 * Narrow by construction: terminal only (nothing is executed or resumed); only
 * for `ownerId`, the run's recorded owner; only while the run is unfinished
 * and no runner holds a live lease; and only when the owner's rank, computed
 * in this transaction by the same `app_project_rank` the policies use, is
 * below EDITOR (3). A cancellation already requested ends it CANCELLED;
 * otherwise FAILED with `policy_denied` (what the planner records for the same
 * condition). Its open approvals are expired, so none can be decided, used, or
 * swept again. Every change writes an event marked `via: 'system'`.
 * Idempotent: a finished run is never matched again.
 */
export async function systemSettleIneligibleOwnerRun(runId: string, ownerId: string): Promise<boolean> {
  return systemDb.transaction(async (tx) => {
    /* The rank is the owner's: app_project_rank reads the acting user from this transaction-local setting. */
    await tx.execute(sql`select set_config('app.user_id', ${ownerId}, true)`);
    const unfinished = inArray(researchRuns.status, ['QUEUED', 'PLANNING', 'RUNNING', 'WAITING_APPROVAL']);
    const leaseFree = or(isNull(researchRuns.leaseExpiresAt), lt(researchRuns.leaseExpiresAt, sql`now()`));
    const [run] = await tx
      .select({ projectId: researchRuns.projectId, status: researchRuns.status, cancelRequestedAt: researchRuns.cancelRequestedAt, rank: sql<number>`app_project_rank(${researchRuns.projectId})` })
      .from(researchRuns)
      .where(and(eq(researchRuns.id, runId), eq(researchRuns.userId, ownerId), unfinished, leaseFree))
      .for('update');
    if (!run || Number(run.rank) >= 3) return false;
    const cancelled = run.cancelRequestedAt !== null;
    const to = cancelled ? 'CANCELLED' : 'FAILED';
    const stopReason: StopReason = cancelled ? 'cancelled' : 'policy_denied';
    const message = 'The run’s owner can no longer edit this project.';
    const rows = await tx
      .update(researchRuns)
      .set({ status: to, stopReason, error: { reason: stopReason, cause: 'owner_ineligible', message }, finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, attempts: 0, updatedAt: new Date() })
      .where(and(eq(researchRuns.id, runId), eq(researchRuns.userId, ownerId), unfinished, leaseFree))
      .returning({ id: researchRuns.id });
    if (!rows[0]) return false;
    const expired = await tx
      .update(runApprovals)
      .set({ status: 'EXPIRED' as ApprovalStatus })
      .where(and(eq(runApprovals.runId, runId), inArray(runApprovals.status, ['PENDING', 'APPROVED'])))
      .returning({ id: runApprovals.id, stepId: runApprovals.stepId });
    for (const approval of expired) {
      await appendEvent(tx, { runId, projectId: run.projectId, userId: ownerId, stepId: approval.stepId, type: 'approval.expired', data: { approvalId: approval.id, reason: 'owner_ineligible', via: 'system' } });
    }
    await appendEvent(tx, { runId, projectId: run.projectId, userId: ownerId, type: `run.${to.toLowerCase()}`, data: { from: run.status, to, stopReason, cause: 'owner_ineligible', ownerRank: Number(run.rank), via: 'system' } });
    return true;
  });
}

/** Open approvals past their expiry, with the run owner to act as. */
export async function systemExpiredApprovals(limit = 50): Promise<{ id: string; userId: string; runId: string }[]> {
  return systemDb
    .select({ id: runApprovals.id, userId: researchRuns.userId, runId: runApprovals.runId })
    .from(runApprovals)
    .innerJoin(researchRuns, eq(researchRuns.id, runApprovals.runId))
    .where(and(inArray(runApprovals.status, ['PENDING', 'APPROVED']), lt(runApprovals.expiresAt, sql`now()`)))
    .limit(limit);
}
