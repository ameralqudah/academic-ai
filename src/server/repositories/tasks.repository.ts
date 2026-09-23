/**
 * Reading and writing task state.
 *
 * Everything here assumes the process may stop between any two calls. A task
 * that was running when the server restarted must be recoverable from the rows
 * alone — which is why the executor holds no state of its own and every
 * transition is written before the work that follows it.
 */

import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';

import { db } from '@/server/db';
import {
  taskSteps,
  tasks,
  type NewTask,
  type NewTaskStep,
  type Task,
  type TaskStep,
} from '@/server/db/schema';

export type TaskStatus =
  | 'QUEUED'
  | 'PLANNING'
  | 'RUNNING'
  /**
   * Extending a plan while it runs.
   *
   * Distinct from RUNNING because the two answer different questions for a
   * watching researcher: RUNNING means a step is working, REPLANNING means the
   * shape of the work is changing. A panel that showed both as "running" would
   * leave a pause of several seconds unexplained.
   */
  | 'REPLANNING'
  | 'PAUSED'
  | 'WAITING_FOR_INPUT'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type StepStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'BLOCKED';

/** A step in one of these states has its outcome; it is never rewritten (P1-D). */
const SETTLED_STEP_STATUSES = ['COMPLETED', 'FAILED', 'SKIPPED', 'BLOCKED'];

/**
 * The claim a settle belongs to (P1-D).
 *
 * The executor passes the `startedAt` its claim wrote. A settle then applies
 * only while the step is still RUNNING under that same claim: a runner that
 * lost the step (recovered by another after a crash, or cancelled) cannot
 * overwrite what the current holder wrote. Without a claim, a settle still
 * never rewrites a settled step.
 */
export interface StepClaim {
  startedAt: Date;
}

function settleable(stepId: string, claim?: StepClaim) {
  return claim
    ? and(eq(taskSteps.id, stepId), eq(taskSteps.status, 'RUNNING'), eq(taskSteps.startedAt, claim.startedAt))
    : and(eq(taskSteps.id, stepId), notInArray(taskSteps.status, SETTLED_STEP_STATUSES));
}

export async function create(input: NewTask): Promise<Task> {
  const [row] = await db.insert(tasks).values(input).returning();
  return row as Task;
}

export async function findOwned(id: string, userId: string): Promise<Task | undefined> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
    .limit(1);

  return row;
}

/** Without the ownership check, for the executor, which already has the task. */
export async function findAny(id: string): Promise<Task | undefined> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return row;
}

export async function listForUser(userId: string, limit = 20): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, userId))
    .orderBy(desc(tasks.createdAt))
    .limit(limit);
}

/** A task in one of these states is finished; nothing may move it again (P1-D). */
export const TERMINAL_TASK_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;

/**
 * Moves a task to `status`, unless it has already finished.
 *
 * Conditional on the task not being terminal, so a cancel is never overwritten
 * by a runner that finishes a moment later, and a completed task never reads
 * as cancelled. Returns whether the write applied. Reopening a failed task is
 * a separate, explicit transition (`reopenFailed`).
 */
export async function setStatus(
  id: string,
  status: TaskStatus,
  extra: Partial<Task> = {},
): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status,
      updatedAt: new Date(),
      ...(status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED'
        ? { finishedAt: new Date() }
        : {}),
      ...extra,
    })
    .where(and(eq(tasks.id, id), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES])))
    .returning({ id: tasks.id });

  return rows.length > 0;
}

/**
 * Returns a failed task to the queue for a retry (P1-D).
 *
 * The one transition out of a terminal state, and only from FAILED: a
 * cancelled task stays cancelled and a completed one stays completed. Failed
 * and blocked steps go back to pending; completed steps keep their results.
 */
export async function reopenFailed(id: string): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ status: 'QUEUED', errorReasonKey: null, finishedAt: null, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), eq(tasks.status, 'FAILED')))
    .returning({ id: tasks.id });
  if (rows.length === 0) return false;

  await db
    .update(taskSteps)
    .set({ status: 'PENDING', startedAt: null, finishedAt: null })
    .where(and(eq(taskSteps.taskId, id), inArray(taskSteps.status, ['FAILED', 'BLOCKED'])));
  return true;
}

/** Merges into the context rather than replacing it. */
export async function mergeContext(id: string, patch: Record<string, unknown>): Promise<void> {
  const task = await findAny(id);
  if (!task) return;

  await db
    .update(tasks)
    .set({ context: { ...task.context, ...patch }, updatedAt: new Date() })
    .where(eq(tasks.id, id));
}

export async function recordSpend(id: string, patch: Record<string, number>): Promise<void> {
  const task = await findAny(id);
  if (!task) return;

  const spent = { ...task.spent };
  for (const [key, value] of Object.entries(patch)) {
    spent[key] = (spent[key] ?? 0) + value;
  }

  await db.update(tasks).set({ spent, updatedAt: new Date() }).where(eq(tasks.id, id));
}

/* -------------------------------------------------------------------------- */
/*                                    Steps                                   */
/* -------------------------------------------------------------------------- */

export async function addSteps(steps: NewTaskStep[]): Promise<TaskStep[]> {
  if (steps.length === 0) return [];
  return db.insert(taskSteps).values(steps).returning();
}

export async function stepsOf(taskId: string): Promise<TaskStep[]> {
  return db
    .select()
    .from(taskSteps)
    .where(eq(taskSteps.taskId, taskId))
    .orderBy(asc(taskSteps.ordinal));
}

/**
 * Claims a step for execution.
 *
 * Conditional on it still being pending, so two workers cannot both start the
 * same step — the update returns nothing for the loser. That matters as soon as
 * independent steps run in parallel, which the design allows for.
 */
export async function claimStep(stepId: string): Promise<TaskStep | undefined> {
  const [row] = await db
    .update(taskSteps)
    .set({ status: 'RUNNING', startedAt: new Date() })
    .where(and(eq(taskSteps.id, stepId), eq(taskSteps.status, 'PENDING')))
    .returning();

  return row;
}

export async function completeStep(
  stepId: string,
  output: Record<string, unknown>,
  artifactIds: string[] = [],
  claim?: StepClaim,
): Promise<boolean> {
  const [step] = await db.select().from(taskSteps).where(eq(taskSteps.id, stepId)).limit(1);

  const rows = await db
    .update(taskSteps)
    .set({
      status: 'COMPLETED',
      output,
      artifactIds,
      finishedAt: new Date(),
      durationMs: step?.startedAt ? Date.now() - step.startedAt.getTime() : null,
    })
    .where(settleable(stepId, claim))
    .returning({ id: taskSteps.id });

  return rows.length > 0;
}

/**
 * Records a failure, or returns the step to pending for another attempt.
 *
 * The decision is here rather than in the executor so that a crash between
 * deciding and writing cannot leave a step marked failed when it had retries
 * left.
 */
export async function failStep(
  stepId: string,
  reasonKey: string,
  retryable: boolean,
  maxAttempts: number,
  /**
   * The failure as the handler described it.
   *
   * Stored so a replanner can read the structured errors rather than a reason
   * key. Without it a failed step carries one string, and the whole point of
   * structured findings — that a planner can act on a code — is lost at exactly
   * the moment it matters.
   */
  observation?: Record<string, unknown>,
  claim?: StepClaim,
): Promise<{ willRetry: boolean; applied?: boolean }> {
  const [step] = await db.select().from(taskSteps).where(eq(taskSteps.id, stepId)).limit(1);
  if (!step) return { willRetry: false };

  const attempts = step.attempts + 1;
  const willRetry = retryable && attempts < maxAttempts;

  const rows = await db
    .update(taskSteps)
    .set({
      status: willRetry ? 'PENDING' : 'FAILED',
      attempts,
      errorReasonKey: reasonKey,
      /*
       * The observation, which carries the handler's own message.
       *
       * A researcher saw "failed after 2 attempts" for a step whose thrown
       * error said exactly what went wrong — the message was stored and the
       * interface had no way to reach it, because only the reason key was
       * consulted and unrecognised throws all share one key.
       */
      ...(observation ? { output: { observation } } : {}),
      ...(willRetry ? { startedAt: null } : { finishedAt: new Date() }),
    })
    .where(settleable(stepId, claim))
    .returning({ id: taskSteps.id });

  return rows.length > 0 ? { willRetry, applied: true } : { willRetry: false, applied: false };
}

/**
 * Sets a step aside without failing the task.
 *
 * For a step the task added to itself and then could not run. It was never
 * something the researcher asked for, so it neither fails the task nor holds
 * up the steps they did ask for.
 */
export async function skipStep(stepId: string, reasonKey: string, claim?: StepClaim): Promise<void> {
  await db
    .update(taskSteps)
    .set({ status: 'SKIPPED', errorReasonKey: reasonKey, finishedAt: new Date() })
    .where(settleable(stepId, claim));
}

/**
 * A step that stopped to ask the researcher something, waiting for the answer.
 *
 * Not a failure, and not an attempt. It was recorded as one: a question
 * consumed the step's attempts, so the second question — "which variables?",
 * asked again after the answer named none — marked the step failed after two
 * attempts and ended a task that had done nothing wrong.
 */
export async function awaitInput(stepId: string, claim?: StepClaim): Promise<void> {
  await db
    .update(taskSteps)
    .set({ status: 'PENDING', errorReasonKey: 'task.step.needsInput', startedAt: null })
    .where(settleable(stepId, claim));
}

/** Marks steps that can never run because a dependency failed. */
export async function blockSteps(stepIds: string[]): Promise<void> {
  if (stepIds.length === 0) return;

  await db
    .update(taskSteps)
    .set({ status: 'BLOCKED', finishedAt: new Date() })
    .where(and(inArray(taskSteps.id, stepIds), notInArray(taskSteps.status, SETTLED_STEP_STATUSES)));
}

/**
 * Returns steps left running when the process stopped.
 *
 * A step marked RUNNING with no live executor is stranded: nothing will finish
 * it, and it blocks everything downstream. Recovery returns it to pending so
 * the work resumes rather than the task hanging.
 *
 * Called only by a runner that holds the task (its lease, or the direct call
 * of a test): no other runner can be executing the step, so it is stranded.
 * The interrupted execution counts as an attempt (P1-D). A step allowed one
 * attempt — a statistics run, a document build, deep research — is marked
 * failed as interrupted instead of running a second time, so a crash never
 * silently repeats work that may already have had effects.
 */
export async function recoverStranded(taskId: string, maxAttemptsOf: (capability: string) => number = () => 2): Promise<number> {
  const stranded = await db
    .select({ id: taskSteps.id, capability: taskSteps.capability, attempts: taskSteps.attempts, startedAt: taskSteps.startedAt })
    .from(taskSteps)
    .where(and(eq(taskSteps.taskId, taskId), eq(taskSteps.status, 'RUNNING')));

  let recovered = 0;
  for (const step of stranded) {
    const attempts = step.attempts + 1;
    const exhausted = attempts >= maxAttemptsOf(step.capability);
    const rows = await db
      .update(taskSteps)
      .set(
        exhausted
          ? { status: 'FAILED', attempts, errorReasonKey: 'task.step.interrupted', finishedAt: new Date() }
          : { status: 'PENDING', attempts, startedAt: null },
      )
      .where(
        and(
          eq(taskSteps.id, step.id),
          eq(taskSteps.status, 'RUNNING'),
          step.startedAt ? eq(taskSteps.startedAt, step.startedAt) : sql`${taskSteps.startedAt} is null`,
        ),
      )
      .returning({ id: taskSteps.id });
    recovered += rows.length;
  }

  return recovered;
}

/** Tasks that were mid-flight when the process stopped. */
export async function resumable(): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ['RUNNING', 'PLANNING']))
    .orderBy(asc(tasks.createdAt))
    .limit(20);
}

/**
 * Links a step to its dependencies after insertion.
 *
 * Two passes are needed because a plan expresses dependencies by its own keys,
 * and the row ids do not exist until the rows do.
 */
export async function updateDependencies(stepId: string, dependsOn: string[]): Promise<void> {
  await db.update(taskSteps).set({ dependsOn }).where(eq(taskSteps.id, stepId));
}

/** Replaces a step's input, for a retry with different parameters. */
export async function updateStepInput(
  stepId: string,
  input: Record<string, unknown>,
): Promise<void> {
  await db.update(taskSteps).set({ input }).where(eq(taskSteps.id, stepId));
}

