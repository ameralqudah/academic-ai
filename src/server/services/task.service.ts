/**
 * Creating, running and resuming tasks.
 *
 * The layer between the API and the executor: it owns the transition from a
 * request to a plan, and the decision to run in the background rather than in
 * a request that would time out.
 */

import { logger } from '@/lib/logger';
import type { Task, TaskStep } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as tasksRepo from '@/server/repositories/tasks.repository';
import { capabilityFor, DEFAULT_BUDGET, type TaskBudget } from '@/server/tasks/capabilities';
import { runTask } from '@/server/tasks/executor';
import { planAdditionalSteps, planTask } from '@/server/tasks/planner';

/**
 * The reason behind a thrown error, where the message reveals one.
 *
 * Shared with the executor's step-level classification so a quota reads the
 * same whether it stopped the planning or the tenth step. Pattern matching on
 * a message is imprecise by nature; the generic key is the honest answer when
 * nothing matches, rather than guessing.
 */
export function classifyFailure(detail: string): string {
  if (/quota|limit|allowance|429|rate.?limit/i.test(detail)) return 'task.error.quota';
  if (/unauthor|api.?key|credential|401|403/i.test(detail)) return 'task.error.credentials';
  if (/network|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(detail)) return 'task.error.network';
  return 'task.error.crashed';
}

/** More than this in flight and the user is queueing work nobody will read. */
const MAX_ACTIVE = 2;

export async function startTask(input: {
  userId: string;
  request: string;
  locale: 'ar' | 'en';
  projectId?: string | null;
  conversationId?: string | null;
  datasetId?: string | null;
  budget?: Partial<TaskBudget>;
}): Promise<Task> {
  const active = (await tasksRepo.listForUser(input.userId, 20)).filter((task) =>
    ['QUEUED', 'PLANNING', 'RUNNING'].includes(task.status),
  );

  if (active.length >= MAX_ACTIVE) {
    throw new AppError(
      'VALIDATION',
      'You already have work running. Wait for it to finish.',
      'لديك عمل قيد التنفيذ. انتظر انتهاءه.',
    );
  }

  /*
   * The budget is resolved at creation and stored, so raising the default later
   * does not silently change what a running task is allowed to do.
   */
  const budget: TaskBudget = { ...DEFAULT_BUDGET, ...input.budget };

  const task = await tasksRepo.create({
    userId: input.userId,
    projectId: input.projectId ?? null,
    conversationId: input.conversationId ?? null,
    request: input.request,
    locale: input.locale,
    status: 'QUEUED',
    context: input.datasetId ? { datasetId: input.datasetId } : {},
    budget: budget as unknown as Record<string, number>,
    spent: { modelCalls: 0, retries: 0 },
  });

  /*
   * Planning and execution run without being awaited, so the response reaches
   * the client while the work continues. The rejection handler is not optional:
   * an unhandled rejection from a floating promise takes down the process.
   */
  void planAndRun(task.id).catch((error: unknown) => {
    logger.error('task.crashed', { taskId: task.id, error: String(error) });

    /*
     * The cause, where it can be recognised.
     *
     * A researcher watched a task fail before any step existed and saw one
     * word: "Failed". Planning needs a model call, so an exhausted allowance or
     * a missing key stops the task here — and both are things they can act on,
     * where a bare failure is a dead end.
     */
    const detail = String(error);

    /*
     * The message as well as the key.
     *
     * The key alone produced "Stopped by an unexpected error" — true, useless,
     * and exactly what the researcher already knew. The provider's own message
     * names the cause, and the classifier will never recognise every phrasing
     * one invents, so keeping the text is what makes an unclassified failure
     * actionable.
     *
     * Stored in `context` rather than a new column: a migration for one
     * diagnostic string is not worth the deploy risk, and the field already
     * holds task-scoped facts.
     */
    void tasksRepo.setStatus(task.id, 'FAILED', {
      errorReasonKey: classifyFailure(detail),
      context: { ...task.context, failureDetail: detail.slice(0, 400) },
    });
  });

  return task;
}

/**
 * Plans a task and runs it.
 *
 * Exported so a worker process can drive it later without this file changing —
 * moving execution off the web process becomes a question of who calls this.
 */
export async function planAndRun(taskId: string): Promise<void> {
  const task = await tasksRepo.findAny(taskId);
  if (!task) return;

  const existing = await tasksRepo.stepsOf(taskId);

  /*
   * A task that already has steps is being resumed, not planned again.
   * Re-planning would discard completed work and produce a different plan from
   * the one the user has been watching.
   */
  if (existing.length === 0) {
    await tasksRepo.setStatus(taskId, 'PLANNING');

    const plan = await planTask({
      userId: task.userId,
      request: task.request,
      locale: (task.locale as 'ar' | 'en') ?? 'en',
      context: task.context,
    });

    if (plan.missingInformation.length > 0) {
      /*
       * Asked before any work is done, so the answer shapes the plan rather
       * than invalidating half of it.
       */
      await tasksRepo.setStatus(taskId, 'WAITING_FOR_INPUT', {
        pendingQuestion: plan.missingInformation.join('\n'),
        context: { ...task.context, pendingPlanSummary: plan.summary },
      });
      return;
    }

    await persistPlan(taskId, plan.steps, false);
    await tasksRepo.mergeContext(taskId, { summary: plan.summary });
  }

  await runTask(taskId, {
    shouldStop: async () => (await tasksRepo.findAny(taskId))?.status === 'CANCELLED',
    onSuggestion: async (current, trigger, available) => {
      const steps = await tasksRepo.stepsOf(current.id);

      /*
       * A recommendation that names a capability is acted on directly.
       *
       * The handler already decided what would help and with what input; asking
       * a model to re-derive that from a sentence costs a call, adds latency,
       * and can produce a different answer than the one the handler stated.
       * Only when nothing is recommended does the planner reason about it.
       */
      const direct = trigger.recommendedNextActions.filter((action) => {
        /* Already planned and waiting: adding it again would duplicate work. */
        if (steps.some((step) => step.capability === action.capability && step.status === 'PENDING')) {
          return false;
        }

        /*
         * A retry with the same input will fail the same way.
         *
         * A search that found the wrong corpus recommended searching again, and
         * the recommendation carried the query that had just failed — so the
         * second search would return the same wrong corpus, recommend a third,
         * and the task would spend its budget repeating one mistake.
         *
         * Requiring the input to differ is what makes a recommendation a
         * correction rather than a repetition.
         */
        const identical = steps.some(
          (step) =>
            step.capability === action.capability &&
            step.status === 'COMPLETED' &&
            JSON.stringify(step.input) === JSON.stringify(action.input ?? {}),
        );

        return !identical;
      });

      if (direct.length > 0) {
        await persistPlan(
          current.id,
          direct.slice(0, available).map((action, index) => ({
            key: `replan_${index}`,
            capability: action.capability,
            /*
             * The capability's own label, not the recommendation's reason.
             *
             * Using the reason put "the query found the wrong corpus" in the
             * step list as though it were work to be done — a sentence
             * explaining *why* a step was added, displayed as the step itself.
             * The reason belongs in the observation, which is where it is.
             */
            label: capabilityFor(action.capability)?.labelKey ?? action.capability,
            dependsOn: [],
            input: action.input ?? {},
          })),
          true,
        );

        return Math.min(direct.length, available);
      }

      const added = await planAdditionalSteps({
        userId: current.userId,
        locale: (current.locale as 'ar' | 'en') ?? 'en',
        originalRequest: current.request,
        completedSteps: steps
          .filter((step) => step.status === 'COMPLETED')
          .map((step) => ({ capability: step.capability, label: step.label, output: step.output })),
        remainingSteps: steps
          .filter((step) => step.status === 'PENDING')
          .map((step) => ({ key: step.id, capability: step.capability, label: step.label })),
        /*
         * Described for the model only when there is nothing structured to act
         * on — the fallback, not the normal path.
         */
        trigger: [
          trigger.status === 'partial' ? 'The step completed only partially.' : '',
          ...trigger.missingInformation,
        ]
          .filter(Boolean)
          .join(' '),
        stepsAvailable: available,
      });

      /* Marked dynamic, so the plan's history stays legible. */
      await persistPlan(current.id, added, true);
      return added.length;
    },
  });
}

/**
 * Writes planned steps as rows.
 *
 * Dependencies arrive as plan-local keys and are rewritten to row ids here,
 * because the plan cannot know ids that do not exist yet.
 */
async function persistPlan(
  taskId: string,
  steps: { key: string; capability: string; label: string; dependsOn: string[]; input: Record<string, unknown> }[],
  dynamic: boolean,
): Promise<void> {
  if (steps.length === 0) return;

  const existing = await tasksRepo.stepsOf(taskId);
  const base = existing.length;

  /* Inserted without dependencies first, so every id exists before linking. */
  const inserted = await tasksRepo.addSteps(
    steps.map((step, index) => ({
      taskId,
      ordinal: base + index,
      capability: step.capability,
      label: step.label,
      status: 'PENDING',
      dependsOn: [],
      input: step.input,
      dynamic,
    })),
  );

  const idByKey = new Map(steps.map((step, index) => [step.key, inserted[index]?.id as string]));

  /* Dynamic steps may depend on completed ones, matched by capability. */
  for (const step of existing) idByKey.set(step.capability, step.id);

  for (const [index, step] of steps.entries()) {
    const dependencies = step.dependsOn
      .map((key) => idByKey.get(key))
      .filter((id): id is string => Boolean(id));

    if (dependencies.length === 0) continue;

    await tasksRepo.updateDependencies(inserted[index]?.id as string, dependencies);
  }
}

/**
 * Supplies the answer a task was waiting for and resumes it.
 *
 * The task continues from where it stopped: the completed steps stay completed,
 * and the step that asked runs again with the answer in context.
 */
export async function answerTask(input: {
  taskId: string;
  userId: string;
  answer: string;
}): Promise<void> {
  const task = await tasksRepo.findOwned(input.taskId, input.userId);

  if (!task) {
    throw new AppError('NOT_FOUND', 'That task was not found.', 'لم يُعثر على هذه المهمة.');
  }

  if (task.status !== 'WAITING_FOR_INPUT') {
    throw new AppError(
      'VALIDATION',
      'That task is not waiting for anything.',
      'هذه المهمة لا تنتظر ردًّا.',
    );
  }

  await tasksRepo.mergeContext(input.taskId, {
    userAnswers: [
      ...(((task.context.userAnswers as string[]) ?? [])),
      input.answer,
    ],
  });

  await tasksRepo.setStatus(input.taskId, 'RUNNING', { pendingQuestion: null });

  void planAndRun(input.taskId).catch((error: unknown) => {
    logger.error('task.resumeCrashed', { taskId: input.taskId, error: String(error) });
  });
}

/** Continues a task that paused at a limit, with more budget. */
export async function resumeTask(input: {
  taskId: string;
  userId: string;
  additionalBudget?: Partial<TaskBudget>;
}): Promise<void> {
  const task = await tasksRepo.findOwned(input.taskId, input.userId);

  if (!task) {
    throw new AppError('NOT_FOUND', 'That task was not found.', 'لم يُعثر على هذه المهمة.');
  }

  if (task.status !== 'PAUSED') {
    throw new AppError('VALIDATION', 'That task is not paused.', 'هذه المهمة ليست متوقّفة.');
  }

  if (input.additionalBudget) {
    const budget = task.budget as unknown as TaskBudget;

    await tasksRepo.setStatus(input.taskId, 'PAUSED', {
      budget: {
        maxSteps: budget.maxSteps + (input.additionalBudget.maxSteps ?? 0),
        maxDurationMs: budget.maxDurationMs + (input.additionalBudget.maxDurationMs ?? 0),
        maxModelCalls: budget.maxModelCalls + (input.additionalBudget.maxModelCalls ?? 0),
        maxRetries: budget.maxRetries + (input.additionalBudget.maxRetries ?? 0),
      } as unknown as Record<string, number>,
    });
  }

  void planAndRun(input.taskId).catch((error: unknown) => {
    logger.error('task.resumeCrashed', { taskId: input.taskId, error: String(error) });
  });
}

export async function cancelTask(taskId: string, userId: string): Promise<void> {
  const task = await tasksRepo.findOwned(taskId, userId);

  if (!task) {
    throw new AppError('NOT_FOUND', 'That task was not found.', 'لم يُعثر على هذه المهمة.');
  }

  await tasksRepo.setStatus(taskId, 'CANCELLED');
}

export interface TaskView {
  task: Task;
  steps: TaskStep[];
}

export async function getTask(taskId: string, userId: string): Promise<TaskView> {
  const task = await tasksRepo.findOwned(taskId, userId);

  if (!task) {
    throw new AppError('NOT_FOUND', 'That task was not found.', 'لم يُعثر على هذه المهمة.');
  }

  return { task, steps: await tasksRepo.stepsOf(taskId) };
}

/**
 * Resumes tasks that were mid-flight when the process stopped.
 *
 * Called at startup. Without it, every deploy strands whatever was running —
 * the task sits at RUNNING forever with nothing driving it.
 */
export async function resumeInterrupted(): Promise<number> {
  const tasks = await tasksRepo.resumable();

  for (const task of tasks) {
    logger.info('task.resumingAfterRestart', { taskId: task.id, status: task.status });

    void planAndRun(task.id).catch((error: unknown) => {
      logger.error('task.resumeCrashed', { taskId: task.id, error: String(error) });
    });
  }

  return tasks.length;
}
