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
import {
  failed,
  makeOutput,
  needsInput,
  succeeded,
  type Finding,
  type Observation,
  type OutputReference,
  type ProducerContext,
} from './contracts';
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
  stepId: string;
  userId: string;
  projectId: string | null;
  locale: 'ar' | 'en';
  /** The step's own input, as planned. */
  input: Record<string, unknown>;

  /**
   * Typed outputs from every completed step, addressable by data type.
   *
   * The contract that replaces `dependencies['academic.search']`. A handler
   * asks for `sources.v1` and does not name the producer — so deep research can
   * feed a literature review that an academic search fed yesterday, and
   * renaming a capability breaks nothing.
   */
  available: OutputReference[];

  /**
   * The old keyed-by-capability view.
   *
   * Kept while handlers migrate, and deprecated: it is the mechanism whose
   * silent failure mode this phase exists to remove. A consumer reading a
   * capability that did not run gets `undefined` and writes from nothing,
   * with nothing thrown.
   *
   * @deprecated Read from `available` by type.
   */
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
   * @deprecated Return an `Observation` with `recommendedNextActions`.
   *
   * Free text the planner could only hand to a model. A structured
   * recommendation names the capability that would help, which the planner can
   * act on without a model call.
   */
  suggestsMoreWork?: string;
  /** @deprecated Return an `Observation` with status `needs-input`. */
  needsUserInput?: string;
}

/**
 * A handler returns either shape.
 *
 * Both are supported during migration and normalised to an `Observation`
 * immediately, so everything downstream reasons about one contract. Migrating
 * all twelve handlers in one change would mean twelve untested rewrites
 * landing together.
 */
export type StepHandler = (context: StepContext) => Promise<StepResult | Observation>;

/** Whether a handler returned the canonical contract. */
function isObservation(value: StepResult | Observation): value is Observation {
  return 'status' in value && 'outputs' in value;
}

/**
 * Wraps a legacy result in an observation.
 *
 * The old shape carries less information — no typed outputs, no evidence, no
 * structured findings — so the wrapper produces a `generic.v1` output and marks
 * what it cannot know. That loss is the argument for migrating handlers rather
 * than leaving them wrapped indefinitely.
 */
function normalise(
  result: StepResult | Observation,
  producer: ProducerContext,
): Observation {
  if (isObservation(result)) return result;

  if (result.needsUserInput) {
    return needsInput(result.needsUserInput, 'answer', { modelCalls: result.modelCalls });
  }

  const outputs = [makeOutput(producer, 'generic.v1', result.output)];

  return succeeded(outputs, {
    modelCalls: result.modelCalls,
    artifacts: (result.artifactIds ?? []).map((id) => ({
      id,
      kind: 'unknown',
      filename: '',
      validationStatus: 'unchecked',
    })),
    ...(result.suggestsMoreWork
      ? {
          /*
           * Free text becomes `missingInformation`, never a recommendation.
           *
           * A recommendation names a capability the planner can schedule. A
           * sentence names nothing, and putting one in that field produced an
           * entry with an empty capability — an item that looks actionable,
           * reaches the planner, and cannot be acted on.
           *
           * `missingInformation` is the honest home for a string: it says
           * something is lacking without pretending to say what would fix it.
           * The planner reasons about it with a model, which is the correct
           * cost for information that was never structured.
           */
          missingInformation: [result.suggestsMoreWork],
        }
      : {}),
  });
}

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

/**
 * What a step observed that may warrant more work.
 *
 * Passed to the planner whole. Every field here is something a handler stated
 * deliberately, and flattening any of it means the planner has to infer what
 * was already known.
 */
export interface ReplanTrigger {
  stepId: string;
  /** The capability that observed this. */
  capability: string;
  status: Observation['status'];
  missingInformation: string[];
  /** Only recommendations naming a capability; the rest are dropped upstream. */
  recommendedNextActions: Observation['recommendedNextActions'];
  confidence: number;
  warnings: Finding[];
}

export interface RunOptions {
  /** Checked between steps, so cancellation takes effect within one step. */
  shouldStop?: () => Promise<boolean>;
  onProgress?: (progress: { completed: number; total: number; current?: string }) => void;
  /** Extends the plan when a step suggests more work. */
  /**
   * Called when a step's observation implies more work.
   *
   * Receives the structured observation rather than a sentence describing it,
   * so a recommendation naming a capability and its input can be acted on
   * directly — no model call to recover information the handler already stated.
   */
  onSuggestion?: (
    task: Task,
    trigger: ReplanTrigger,
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
        result.observation as unknown as Record<string, unknown>,
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

    const observation = result.observation;

    /*
     * The typed outputs are stored alongside the legacy shape.
     *
     * `outputs` is what a migrated consumer reads by type; `legacy` is what an
     * unmigrated one reads by capability name. Keeping both means producers and
     * consumers can migrate independently rather than in one change.
     */
    await tasksRepo.completeStep(
      claimed.id,
      {
        outputs: observation.outputs as unknown as Record<string, unknown>[],
        legacy: legacyShape(observation),
        /*
         * The whole observation, not a selection of its fields.
         *
         * The first version stored status, confidence, warnings and evidence
         * individually — and a replanner reading a resumed task then had no
         * `recommendedNextActions` and no `missingInformation`, which are
         * exactly the fields it reasons over. Storing the record entire means a
         * task resumed after a restart can be replanned as well as one that
         * never stopped.
         */
        observation: observation as unknown as Record<string, unknown>,
        status: observation.status,
        confidence: observation.confidence,
      } as unknown as Record<string, unknown>,
      observation.artifacts.map((artifact) => artifact.id),
    );

    await tasksRepo.recordSpend(taskId, { modelCalls: observation.modelCalls ?? 0 });

    /*
     * Replanning driven by structure rather than prose.
     *
     * Three signals now reach the planner where one string did: a partial
     * result with named gaps, an explicit recommendation, or low confidence.
     * The planner can act on the first two without a model call.
     */
    const wantsMore =
      observation.status === 'partial' ||
      observation.recommendedNextActions.length > 0 ||
      observation.missingInformation.length > 0;

    if (wantsMore && options.onSuggestion) {
      const room = budget.maxSteps - steps.length;

      if (room > 0) {
        /*
         * The observation reaches the planner as it was written.
         *
         * It used to be flattened into a sentence — "academic.search: rephrase"
         * — which threw away the named capability and the structured input, and
         * then required a model call to reconstruct what the handler had
         * already stated precisely. Structuring a recommendation only to
         * stringify it at the last step is the whole failure the observation
         * contract exists to prevent.
         *
         * Recommendations naming no capability are dropped here rather than
         * passed on. An empty name cannot be acted upon, and letting one
         * through means the planner must guess — which is the behaviour this
         * replaced.
         */
        const actionable = observation.recommendedNextActions.filter(
          (action) => action.capability.trim().length > 0,
        );

        if (actionable.length < observation.recommendedNextActions.length) {
          logger.warn('task.recommendationWithoutCapability', {
            taskId,
            capability: claimed.capability,
            dropped: observation.recommendedNextActions.length - actionable.length,
          });
        }

        const added = await options.onSuggestion(current, {
          stepId: claimed.id,
          capability: claimed.capability,
          status: observation.status,
          missingInformation: observation.missingInformation,
          recommendedNextActions: actionable,
          confidence: observation.confidence,
          warnings: observation.warnings,
        }, room);

        if (added > 0) logger.info('task.stepsAdded', { taskId, added, from: observation.status });
      }
    }
  }
}

/**
 * The observation as the old output shape.
 *
 * Written so an unmigrated consumer reading `dependencies['academic.search']`
 * finds what it always found. Removed once every handler reads by type — at
 * which point the deprecated field goes with it.
 */
function legacyShape(observation: Observation): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const output of observation.outputs) {
    if (output.data && typeof output.data === 'object') {
      Object.assign(merged, output.data);
    }
  }

  return merged;
}

async function pauseAtLimit(taskId: string, limit: LimitReason): Promise<void> {
  await tasksRepo.setStatus(taskId, 'PAUSED', { pauseReasonKey: `task.paused.${limit}` });
  logger.info('task.pausedAtLimit', { taskId, limit });
}

type Executed =
  | { kind: 'completed'; observation: Observation }
  | { kind: 'failed'; reasonKey: string; observation: Observation }
  | { kind: 'needs-input'; question: string; observation: Observation };

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
  if (!handler) {
    return {
      kind: 'failed',
      reasonKey: 'task.error.noHandler',
      observation: failed([
        {
          code: 'task.error.noHandler',
          severity: 'error',
          message: `No handler registered for ${step.capability}`,
          reference: step.capability,
        },
      ]),
    };
  }

  /*
   * Every completed step's typed outputs, not just this step's dependencies.
   *
   * A consumer asks for `sources.v1` and gets whatever produced it — which is
   * the substitution the old contract forbade. Scoping to declared dependencies
   * would reintroduce the coupling by another route: the step would still have
   * to know which producer to depend on.
   */
  const available: OutputReference[] = [];

  for (const entry of allSteps) {
    if (entry.status !== 'COMPLETED') continue;

    const stored = (entry.output as { outputs?: OutputReference[] } | null)?.outputs;
    if (Array.isArray(stored)) available.push(...stored);
  }

  /*
   * The legacy view, built only from declared dependencies as it always was.
   * Handlers still reading it behave exactly as before.
   */
  const byId = new Map(allSteps.map((entry) => [entry.id, entry]));
  const dependencies: Record<string, Record<string, unknown>> = {};

  for (const id of step.dependsOn) {
    const dependency = byId.get(id);
    if (!dependency?.output) continue;

    /*
     * A migrated handler stores `{ outputs, legacy }`; the old view reads the
     * legacy half, so a migrated producer keeps feeding an unmigrated consumer.
     */
    const output = dependency.output as Record<string, unknown>;
    dependencies[dependency.capability] = (output.legacy as Record<string, unknown>) ?? output;
  }

  const producer: ProducerContext = {
    taskId: task.id,
    stepId: step.id,
    capability: step.capability,
    projectId: task.projectId,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const raw = await handler({
      taskId: task.id,
      stepId: step.id,
      userId: task.userId,
      projectId: task.projectId,
      locale: (task.locale as 'ar' | 'en') ?? 'en',
      input: step.input,
      available,
      dependencies,
      context: task.context,
      signal: controller.signal,
    });

    const observation = normalise(raw, producer);

    if (observation.status === 'needs-input') {
      return {
        kind: 'needs-input',
        question: observation.requiresUserInput?.question ?? 'More information is needed.',
        observation,
      };
    }

    if (observation.status === 'failed') {
      return {
        kind: 'failed',
        /*
         * The first error's code, so a retry policy can branch on what went
         * wrong rather than on a generic failure.
         */
        reasonKey: observation.errors[0]?.code ?? 'task.error.stepFailed',
        observation,
      };
    }

    return { kind: 'completed', observation };
  } catch (error) {
    const aborted = controller.signal.aborted;

    /*
     * The specific cause, where it can be recognised.
     *
     * A researcher watched a literature review fail and saw only "failed after
     * 1 attempt" — which could mean a quota, an outage, or a bug, and gives
     * them nothing to act on. An exhausted allowance in particular is not a
     * malfunction: it is a thing they can fix, and saying so is the difference
     * between a dead end and a next step.
     */
    const detail = String(error);

    const code = aborted
      ? 'task.error.timeout'
      : /quota|limit|allowance|429|rate.?limit/i.test(detail)
        ? 'task.error.quota'
        : /unauthor|api.?key|credential|401|403/i.test(detail)
          ? 'task.error.credentials'
          : /network|fetch failed|ENOTFOUND|ECONNREFUSED|timeout/i.test(detail)
            ? 'task.error.network'
            : 'task.error.stepThrew';

    return {
      kind: 'failed',
      reasonKey: code,
      /*
       * A thrown handler still produces a structured observation, so the
       * replanner sees the same shape whether a step returned a failure or
       * crashed.
       */
      observation: failed([
        {
          code,
          severity: 'error',
          message: String(error).slice(0, 300),
          reference: step.capability,
        },
      ]),
    };
  } finally {
    clearTimeout(timeout);
  }
}
