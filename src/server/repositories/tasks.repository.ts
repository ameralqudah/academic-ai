/**
 * Reading and writing task state.
 *
 * Everything here assumes the process may stop between any two calls. A task
 * that was running when the server restarted must be recoverable from the rows
 * alone — which is why the executor holds no state of its own and every
 * transition is written before the work that follows it.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';

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
  | 'PAUSED'
  | 'WAITING_FOR_INPUT'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type StepStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'BLOCKED';

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

export async function setStatus(
  id: string,
  status: TaskStatus,
  extra: Partial<Task> = {},
): Promise<void> {
  await db
    .update(tasks)
    .set({
      status,
      updatedAt: new Date(),
      ...(status === 'RUNNING' && !extra.startedAt ? {} : {}),
      ...(status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED'
        ? { finishedAt: new Date() }
        : {}),
      ...extra,
    })
    .where(eq(tasks.id, id));
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
): Promise<void> {
  const [step] = await db.select().from(taskSteps).where(eq(taskSteps.id, stepId)).limit(1);

  await db
    .update(taskSteps)
    .set({
      status: 'COMPLETED',
      output,
      artifactIds,
      finishedAt: new Date(),
      durationMs: step?.startedAt ? Date.now() - step.startedAt.getTime() : null,
    })
    .where(eq(taskSteps.id, stepId));
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
): Promise<{ willRetry: boolean }> {
  const [step] = await db.select().from(taskSteps).where(eq(taskSteps.id, stepId)).limit(1);
  if (!step) return { willRetry: false };

  const attempts = step.attempts + 1;
  const willRetry = retryable && attempts < maxAttempts;

  await db
    .update(taskSteps)
    .set({
      status: willRetry ? 'PENDING' : 'FAILED',
      attempts,
      errorReasonKey: reasonKey,
      ...(observation ? { output: { observation } } : {}),
      ...(willRetry ? { startedAt: null } : { finishedAt: new Date() }),
    })
    .where(eq(taskSteps.id, stepId));

  return { willRetry };
}

/** Marks steps that can never run because a dependency failed. */
export async function blockSteps(stepIds: string[]): Promise<void> {
  if (stepIds.length === 0) return;

  await db
    .update(taskSteps)
    .set({ status: 'BLOCKED', finishedAt: new Date() })
    .where(inArray(taskSteps.id, stepIds));
}

/**
 * Returns steps left running when the process stopped.
 *
 * A step marked RUNNING with no live executor is stranded: nothing will finish
 * it, and it blocks everything downstream. Recovery returns it to pending so
 * the work resumes rather than the task hanging.
 */
export async function recoverStranded(taskId: string): Promise<number> {
  const rows = await db
    .update(taskSteps)
    .set({ status: 'PENDING', startedAt: null })
    .where(and(eq(taskSteps.taskId, taskId), eq(taskSteps.status, 'RUNNING')))
    .returning({ id: taskSteps.id });

  return rows.length;
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
