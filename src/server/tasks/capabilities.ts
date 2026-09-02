/**
 * What a task step can do, and what each kind of work costs.
 *
 * The registry exists so the planner and the executor share one view of the
 * available work. The planner asks "what can I do" and the executor asks "how
 * long may this take"; a second list would drift, and the drift would show as a
 * plan containing a step nothing can run.
 *
 * **Timeouts are per capability, not global.** A uniform limit is wrong in both
 * directions: two minutes kills a deep research run that legitimately takes
 * ten, and gives a Markdown export a hundred and nineteen seconds it will never
 * use. The number here is what that kind of work actually needs.
 *
 * **Adding a capability is adding an entry.** Nothing in the planner or the
 * executor names a specific one, which is what keeps the planner generic — the
 * requirement that there be no `ThesisPlanner`.
 */

export type CapabilityId =
  | 'general.answer'
  | 'web.search'
  | 'academic.search'
  | 'deep.research'
  | 'literature.review'
  | 'file.analyse'
  | 'statistics.run'
  | 'statistics.pls'
  | 'statistics.cbsem'
  | 'survey.generate'
  | 'document.write'
  | 'document.generate'
  | 'quality.check'
  | 'citation.verify';

export interface CapabilityDefinition {
  id: CapabilityId;
  /** Shown in the plan, resolved from messages. */
  labelKey: string;
  /**
   * How long one attempt may run.
   *
   * Deep research is ten minutes because it genuinely is: fifteen searches,
   * eight page fetches and four model calls. A Markdown export is fifteen
   * seconds because anything longer means something has hung.
   */
  timeoutMs: number;
  /** Model calls this typically makes, for budgeting before it runs. */
  estimatedModelCalls: number;
  /**
   * Whether a failure is worth retrying.
   *
   * A network search is; a document generation that failed on malformed input
   * will fail again the same way, and retrying wastes the budget that a later
   * step needs.
   */
  retryable: boolean;
  maxAttempts: number;
  /** Whether this step needs a dataset attached to the task. */
  requiresDataset: boolean;
  /** Whether two steps of this kind can run at once without interfering. */
  parallelSafe: boolean;
}

const CAPABILITIES: Record<CapabilityId, CapabilityDefinition> = {
  'general.answer': {
    id: 'general.answer',
    labelKey: 'task.capability.generalAnswer',
    timeoutMs: 60_000,
    estimatedModelCalls: 1,
    retryable: true,
    maxAttempts: 2,
    requiresDataset: false,
    parallelSafe: true,
  },
  'web.search': {
    id: 'web.search',
    labelKey: 'task.capability.webSearch',
    timeoutMs: 90_000,
    estimatedModelCalls: 1,
    /* A search failure is usually transient: a timeout, a rate limit. */
    retryable: true,
    maxAttempts: 3,
    requiresDataset: false,
    parallelSafe: true,
  },
  'academic.search': {
    id: 'academic.search',
    labelKey: 'task.capability.academicSearch',
    timeoutMs: 120_000,
    estimatedModelCalls: 1,
    retryable: true,
    maxAttempts: 3,
    requiresDataset: false,
    parallelSafe: true,
  },
  'deep.research': {
    id: 'deep.research',
    labelKey: 'task.capability.deepResearch',
    /* Ten minutes. Fifteen searches, eight fetches, four model calls. */
    timeoutMs: 600_000,
    estimatedModelCalls: 8,
    /*
     * Not retried. A failed deep research run has already spent most of a
     * task's budget, and running it again would spend the rest — leaving
     * nothing for the writing the researcher actually asked for.
     */
    retryable: false,
    maxAttempts: 1,
    requiresDataset: false,
    parallelSafe: false,
  },
  'literature.review': {
    id: 'literature.review',
    labelKey: 'task.capability.literatureReview',
    timeoutMs: 300_000,
    estimatedModelCalls: 4,
    retryable: false,
    maxAttempts: 1,
    requiresDataset: false,
    parallelSafe: false,
  },
  'file.analyse': {
    id: 'file.analyse',
    labelKey: 'task.capability.fileAnalyse',
    timeoutMs: 60_000,
    estimatedModelCalls: 0,
    retryable: true,
    maxAttempts: 2,
    requiresDataset: true,
    parallelSafe: true,
  },
  'statistics.run': {
    id: 'statistics.run',
    labelKey: 'task.capability.statistics',
    timeoutMs: 120_000,
    /* Arithmetic. The interpretation afterwards is a separate step. */
    estimatedModelCalls: 0,
    retryable: false,
    maxAttempts: 1,
    requiresDataset: true,
    parallelSafe: true,
  },
  'statistics.pls': {
    id: 'statistics.pls',
    labelKey: 'task.capability.pls',
    /* Bootstrapping is five thousand re-estimations. */
    timeoutMs: 300_000,
    estimatedModelCalls: 0,
    retryable: false,
    maxAttempts: 1,
    requiresDataset: true,
    parallelSafe: false,
  },
  'statistics.cbsem': {
    id: 'statistics.cbsem',
    labelKey: 'task.capability.cbsem',
    timeoutMs: 180_000,
    estimatedModelCalls: 0,
    retryable: false,
    maxAttempts: 1,
    requiresDataset: true,
    parallelSafe: false,
  },
  'survey.generate': {
    id: 'survey.generate',
    labelKey: 'task.capability.survey',
    timeoutMs: 120_000,
    estimatedModelCalls: 1,
    retryable: true,
    maxAttempts: 2,
    requiresDataset: false,
    parallelSafe: true,
  },
  'document.write': {
    id: 'document.write',
    labelKey: 'task.capability.write',
    /* Writing a chapter, which is the longest single model call here. */
    timeoutMs: 240_000,
    estimatedModelCalls: 2,
    retryable: true,
    maxAttempts: 2,
    requiresDataset: false,
    parallelSafe: true,
  },
  'document.generate': {
    id: 'document.generate',
    labelKey: 'task.capability.generate',
    /* File assembly: no model call, so a long run means something is wrong. */
    timeoutMs: 60_000,
    estimatedModelCalls: 0,
    retryable: false,
    maxAttempts: 1,
    requiresDataset: false,
    parallelSafe: true,
  },
  'quality.check': {
    id: 'quality.check',
    labelKey: 'task.capability.quality',
    timeoutMs: 120_000,
    estimatedModelCalls: 0,
    retryable: true,
    maxAttempts: 2,
    requiresDataset: false,
    parallelSafe: true,
  },
  'citation.verify': {
    id: 'citation.verify',
    labelKey: 'task.capability.citations',
    timeoutMs: 180_000,
    estimatedModelCalls: 0,
    retryable: true,
    maxAttempts: 2,
    requiresDataset: false,
    parallelSafe: true,
  },
};

export function capabilityFor(id: string): CapabilityDefinition | undefined {
  return CAPABILITIES[id as CapabilityId];
}

export function isKnownCapability(id: string): id is CapabilityId {
  return id in CAPABILITIES;
}

export function allCapabilities(): CapabilityDefinition[] {
  return Object.values(CAPABILITIES);
}

/**
 * Registers a capability at runtime.
 *
 * The extension point: a new kind of work becomes an entry here and a handler
 * in the executor, and neither the planner nor the state machine changes.
 */
export function registerCapability(definition: CapabilityDefinition): void {
  (CAPABILITIES as Record<string, CapabilityDefinition>)[definition.id] = definition;
}

/* -------------------------------------------------------------------------- */
/*                                   Budget                                   */
/* -------------------------------------------------------------------------- */

export interface TaskBudget {
  /**
   * Steps a task may contain.
   *
   * Fifty rather than a dozen, because a thesis workflow legitimately needs
   * more: search, verify, review, write eight chapters, generate tables, check,
   * export. A limit set for a short task would refuse the work this exists to
   * do.
   */
  maxSteps: number;
  /** Wall-clock across the whole task. */
  maxDurationMs: number;
  /** Across every step, since this is what actually costs money. */
  maxModelCalls: number;
  /** Retries across the task, so one flaky step cannot consume the budget. */
  maxRetries: number;
}

export const DEFAULT_BUDGET: TaskBudget = {
  maxSteps: 50,
  /* Two hours. A dissertation workflow is long; an infinite one is a bug. */
  maxDurationMs: 2 * 60 * 60 * 1000,
  maxModelCalls: 120,
  maxRetries: 12,
};

export interface Spent {
  steps: number;
  durationMs: number;
  modelCalls: number;
  retries: number;
}

export type LimitReason = 'maxSteps' | 'maxDuration' | 'maxModelCalls' | 'maxRetries';

/**
 * Whether a limit has been reached.
 *
 * Returns which one, because the remedies differ: a step limit means the plan
 * grew beyond what was expected, a duration limit means something is slow, and
 * a model-call limit means the work costs more than budgeted. A single boolean
 * would leave the user unable to tell which.
 */
export function limitReached(budget: TaskBudget, spent: Spent): LimitReason | null {
  if (spent.steps >= budget.maxSteps) return 'maxSteps';
  if (spent.durationMs >= budget.maxDurationMs) return 'maxDuration';
  if (spent.modelCalls >= budget.maxModelCalls) return 'maxModelCalls';
  if (spent.retries >= budget.maxRetries) return 'maxRetries';
  return null;
}

/**
 * Whether one more step of this capability fits in what remains.
 *
 * Checked before starting rather than after finishing: a step that would exceed
 * the budget should not begin, because stopping it halfway wastes what it spent
 * and leaves partial output nothing can use.
 */
export function fitsInBudget(
  budget: TaskBudget,
  spent: Spent,
  capability: CapabilityDefinition,
): boolean {
  if (spent.steps + 1 > budget.maxSteps) return false;
  if (spent.modelCalls + capability.estimatedModelCalls > budget.maxModelCalls) return false;
  if (spent.durationMs + capability.timeoutMs > budget.maxDurationMs) return false;
  return true;
}
