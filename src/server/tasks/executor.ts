/**
 * Running a plan.
 *
 * The executor holds no state. Everything it needs is in the rows, and every
 * transition is written before the work that follows — so a process that stops
 * mid-task can be replaced by another that picks up from the same place. That
 * is not a nicety on a platform where the service restarts on deploy: without
 * it, every deploy loses whatever was running.
 *
 * **Dependencies decide order, not the plan's sequence.** Steps become ready
 * when everything they need has completed. Two searches with no dependency on
 * each other are both ready at once, which is what makes parallel execution
 * possible later without changing anything here.
 *
 * **A failure blocks what depended on it and nothing else.** A failed search
 * must not produce a literature review written from nothing; an unrelated data
 * analysis has no reason to stop.
 */

import { logger } from '@/lib/logger';
import type { Task, TaskStep } from '@/server/db/schema';
import * as tasksRepo from '@/server/repositories/tasks.repository';

import {
  capabilityFor,
  fitsInBudget,
  limitReached,
  type LimitReason,
  type TaskBudget,
} from './capabilities';
import { blockedSteps, readySteps } from './planner';

/**
 * What a capability handler receives and returns.
 *
 * Structured on both sides. Passing the conversation or a whole file between
 * steps would cost tokens on every call and make each step's behaviour depend
 * on everything before it — which cannot be tested and cannot be reasoned
 * about.
 */
export interface StepContext {
  taskId: string;
  userId: string;
  locale: 'ar' | 'en';
  /** The step's own input, as planned. */
  input: Record<string, unknown>;
  /** Outputs of the steps this one depends on, keyed by capability. */
  dependencies: Record<string, Record<string, unknown>>;
  /** Task-level facts: the dataset, the project, answers the user gave. */
  context: Record<string, unknown>;
  /** Aborts when the capability's timeout elapses. */
  signal: AbortSignal;
}

export interface StepResult {
  output: Record<string, unknown>;
  artifactIds?: string[];
  /** Model calls made, counted against the budget. */
  modelCalls?: number;
  /**
   * Something the step discovered that may need more work.
   *
   * The hook for adaptive planning: a search that found a contradiction, an
   * analysis that revealed an unexpected variable. The executor passes it to
   * the planner, which decides whether to add steps.
   */
  suggestsMoreWork?: string;
  /** Something only the user can supply. Pauses the task. */
  needsUserInput?: string;
}

export type StepHandler = (context: StepContext) => Promise<StepResult>;

/*
 * Handlers are registered rather than imported, so this file names no
 * capability. Adding one is registering a handler; the executor does not
 * change, which is what keeps it generic.
 */
const handlers = new Map<string, StepHandler>();

export function registerHandler(capability: string, handler: StepHandler): void {
  handlers.set(capability, handler);
}

export function hasHandler(capability: string): boolean {
  return handlers.has(capability);
}

export interface RunOptions {
  /** Checked between steps, so cancellation takes effect within one step. */
  shouldStop?: () => Promise<boolean>;
  onProgress?: (progress: { completed: number; total: number; current?: string }) => void;
  /** Extends the plan when a step suggests more work. */
  onSuggestion?: (
    task: Task,
    trigger: string,
    stepsAvailable: number,
  ) => Promise<number>;
}

/**
 * Runs a task to completion, a pause, or a failure.
 *
 * Resumable by construction: called again on a task that stopped halfway, it
 * finds the completed steps still completed and continues from the rest.
 */
export async function runTask(taskId: string, options: RunOptions = {}): Promise<void> {
  const task = await tasksRepo.findAny(taskId);
  if (!task) return;

  if (task.status === 'CANCELLED' || task.status === 'COMPLETED') return;

  /*
   * Steps left RUNNING by a stopped process are returned to pending. Nothing
   * will finish them, and they block everything downstream — a task that hangs
   * with no explanation is worse than one that repeats a step.
   */
  const recovered = await tasksRepo.recoverStranded(taskId);
  if (recovered > 0) {
    logger.info('task.recoveredStranded', { taskId, steps: recovered });
  }

  await tasksRepo.setStatus(taskId, 'RUNNING', {
    ...(task.startedAt ? {} : { startedAt: new Date() }),
    pendingQuestion: null,
    pauseReasonKey: null,
  });

  const budget = task.budget as unknown as TaskBudget;
  const startedAt = task.startedAt?.getTime() ?? Date.now();

  for (;;) {
    if (await options.shouldStop?.()) {
      await tasksRepo.setStatus(taskId, 'CANCELLED');
      return;
    }

    const current = await tasksRepo.findAny(taskId);
    if (!current || current.status === 'CANCELLED') return;

    const steps = await tasksRepo.stepsOf(taskId);

    /*
     * Blocked steps are marked before readiness is computed, so a step whose
     * dependency failed is not left pending forever. The user sees "blocked"
     * with a reason rather than a task that stopped moving.
     */
    const blocked = blockedSteps(steps as unknown as { id: string; status: string; dependsOn: string[] }[]);

    if (blocked.length > 0) {
      await tasksRepo.blockSteps(blocked.map((step) => step.id));
      logger.info('task.stepsBlocked', { taskId, count: blocked.length });
      continue;
    }

    const ready = readySteps(steps as unknown as { id: string; status: string; dependsOn: string[] }[]);

    if (ready.length === 0) {
      /* Nothing ready: either everything is done, or what remains cannot run. */
      const unfinished = steps.filter(
        (step) => step.status === 'PENDING' || step.status === 'RUNNING',
      );

      if (unfinished.length === 0) {
        const anyFailed = steps.some((step) => step.status === 'FAILED');

        /*
         * A task with a failed step still completes if the rest succeeded. The
         * researcher gets what could be produced, and the report says what
         * could not — which is more useful than discarding everything.
         */
        await tasksRepo.setStatus(taskId, anyFailed ? 'FAILED' : 'COMPLETED', {
          ...(anyFailed ? { errorReasonKey: 'task.error.stepFailed' } : {}),
        });

        logger.info('task.finished', {
          taskId,
          steps: steps.length,
          failed: steps.filter((step) => step.status === 'FAILED').length,
        });
        return;
      }

      /*
       * Steps remain but none can run — a dependency on something that will
       * never complete. Paused rather than failed: the state is recoverable if
       * the user resolves what is missing.
       */
      await tasksRepo.setStatus(taskId, 'PAUSED', { pauseReasonKey: 'task.paused.deadlocked' });
      logger.warn('task.deadlocked', { taskId, unfinished: unfinished.length });
      return;
    }

    const spent = {
      steps: steps.filter((step) => step.status === 'COMPLETED').length,
      durationMs: Date.now() - startedAt,
      modelCalls: (current.spent.modelCalls as number) ?? 0,
      retries: (current.spent.retries as number) ?? 0,
    };

    const limit = limitReached(budget, spent);

    if (limit) {
      /*
       * Paused, not failed. The work done is kept, the reason is named, and the
       * user can raise the limit and continue — which is the whole point of
       * having budgets rather than hard failures.
       */
      await pauseAtLimit(taskId, limit);
      return;
    }

    /*
     * One step per iteration. The readiness computation already identifies
     * every independent step, so running them concurrently is a change to this
     * line rather than to the design — deliberately not made yet, because
     * concurrent model calls against one provider hit rate limits that would
     * fail steps for reasons unrelated to their work.
     */
    const next = ready[0] as unknown as TaskStep;
    const capability = capabilityFor(next.capability);

    if (!capability || !hasHandler(next.capability)) {
      await tasksRepo.failStep(next.id, 'task.error.noHandler', false, 1);
      continue;
    }

    if (!fitsInBudget(budget, spent, capability)) {
      await pauseAtLimit(taskId, 'maxModelCalls');
      return;
    }

    const claimed = await tasksRepo.claimStep(next.id);

    /* Another worker took it, or it changed underneath. Re-evaluate. */
    if (!claimed) continue;

    options.onProgress?.({
      completed: spent.steps,
      total: steps.length,
      current: next.label,
    });

    const result = await executeStep(current, claimed, steps, capability.timeoutMs);

    if (result.kind === 'needs-input') {
      /*
       * The step is returned to pending, not failed. When the user answers, the
       * task resumes from here rather than restarting — which is the difference
       * between asking a question and losing an hour of work.
       */
      await tasksRepo.failStep(claimed.id, 'task.step.needsInput', true, capability.maxAttempts + 1);
      await tasksRepo.setStatus(taskId, 'WAITING_FOR_INPUT', {
        pendingQuestion: result.question,
      });
      return;
    }

    if (result.kind === 'failed') {
      const { willRetry } = await tasksRepo.failStep(
        claimed.id,
        result.reasonKey,
        capability.retryable,
        capability.maxAttempts,
      );

      await tasksRepo.recordSpend(taskId, { retries: willRetry ? 1 : 0 });

      logger.info('task.stepFailed', {
        taskId,
        capability: next.capability,
        reason: result.reasonKey,
        willRetry,
      });

      continue;
    }

    await tasksRepo.completeStep(claimed.id, result.output, result.artifactIds ?? []);
    await tasksRepo.recordSpend(taskId, { modelCalls: result.modelCalls ?? 0 });

    /* Adaptive planning: the step found something the plan did not anticipate. */
    if (result.suggestsMoreWork && options.onSuggestion) {
      const available = budget.maxSteps - steps.length;

      if (available > 0) {
        const added = await options.onSuggestion(current, result.suggestsMoreWork, available);
        if (added > 0) logger.info('task.stepsAdded', { taskId, added });
      }
    }
  }
}

async function pauseAtLimit(taskId: string, limit: LimitReason): Promise<void> {
  await tasksRepo.setStatus(taskId, 'PAUSED', { pauseReasonKey: `task.paused.${limit}` });
  logger.info('task.pausedAtLimit', { taskId, limit });
}

type Executed =
  | { kind: 'completed'; output: Record<string, unknown>; artifactIds?: string[]; modelCalls?: number; suggestsMoreWork?: string }
  | { kind: 'failed'; reasonKey: string }
  | { kind: 'needs-input'; question: string };

/**
 * Runs one step under its capability's timeout.
 *
 * The timeout is per capability because a uniform one is wrong in both
 * directions: two minutes kills a deep research run that legitimately takes
 * ten, and gives a Markdown export a hundred and nineteen seconds it will never
 * use.
 */
async function executeStep(
  task: Task,
  step: TaskStep,
  allSteps: TaskStep[],
  timeoutMs: number,
): Promise<Executed> {
  const handler = handlers.get(step.capability);
  if (!handler) return { kind: 'failed', reasonKey: 'task.error.noHandler' };

  /*
   * Dependency outputs, keyed by capability rather than by id. A step that
   * needs the search results asks for `dependencies['academic.search']` and
   * does not need to know which step produced them.
   */
  const byId = new Map(allSteps.map((entry) => [entry.id, entry]));
  const dependencies: Record<string, Record<string, unknown>> = {};

  for (const id of step.dependsOn) {
    const dependency = byId.get(id);
    if (dependency?.output) dependencies[dependency.capability] = dependency.output;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await handler({
      taskId: task.id,
      userId: task.userId,
      locale: (task.locale as 'ar' | 'en') ?? 'en',
      input: step.input,
      dependencies,
      context: task.context,
      signal: controller.signal,
    });

    if (result.needsUserInput) return { kind: 'needs-input', question: result.needsUserInput };

    return {
      kind: 'completed',
      output: result.output,
      artifactIds: result.artifactIds,
      modelCalls: result.modelCalls,
      suggestsMoreWork: result.suggestsMoreWork,
    };
  } catch (error) {
    const aborted = controller.signal.aborted;

    return {
      kind: 'failed',
      reasonKey: aborted ? 'task.error.timeout' : 'task.error.stepThrew',
    };
  } finally {
    clearTimeout(timeout);
  }
}
