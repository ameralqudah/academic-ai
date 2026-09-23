/**
 * The run, step and approval state machines (P1-D).
 *
 * The same tables are enforced by the database (migration 0014 triggers);
 * the service checks them first so an illegal move fails with a clear error
 * instead of a database exception, and every write is additionally
 * conditional on the state it expects (`UPDATE … WHERE status = from`).
 */

export const RUN_STATUSES = ['QUEUED', 'PLANNING', 'RUNNING', 'WAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_STATUSES = ['QUEUED', 'AUTHORIZED', 'WAITING_APPROVAL', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CONSUMED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const TERMINAL_RUN: ReadonlySet<RunStatus> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
/** FAILED is terminal only when no attempt is left; the step table says so per row. */
export const SETTLED_STEP: ReadonlySet<StepStatus> = new Set(['SUCCEEDED', 'CANCELLED', 'SKIPPED']);
export const SETTLED_APPROVAL: ReadonlySet<ApprovalStatus> = new Set(['REJECTED', 'EXPIRED', 'CONSUMED']);

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  QUEUED: ['PLANNING', 'CANCELLED', 'FAILED'],
  PLANNING: ['RUNNING', 'FAILED', 'CANCELLED', 'QUEUED'],
  RUNNING: ['WAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'QUEUED'],
  WAITING_APPROVAL: ['QUEUED', 'RUNNING', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  QUEUED: ['AUTHORIZED', 'WAITING_APPROVAL', 'SKIPPED', 'CANCELLED'],
  WAITING_APPROVAL: ['AUTHORIZED', 'SKIPPED', 'CANCELLED', 'QUEUED'],
  AUTHORIZED: ['RUNNING', 'CANCELLED', 'QUEUED', 'SKIPPED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUEUED'],
  FAILED: ['QUEUED'],
  SUCCEEDED: [],
  CANCELLED: [],
  SKIPPED: [],
};

const APPROVAL_TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  PENDING: ['APPROVED', 'REJECTED', 'EXPIRED'],
  APPROVED: ['CONSUMED', 'EXPIRED'],
  REJECTED: [],
  EXPIRED: [],
  CONSUMED: [],
};

export const canRun = (from: RunStatus, to: RunStatus) => RUN_TRANSITIONS[from].includes(to);
export const canStep = (from: StepStatus, to: StepStatus) => STEP_TRANSITIONS[from].includes(to);
export const canApproval = (from: ApprovalStatus, to: ApprovalStatus) => APPROVAL_TRANSITIONS[from].includes(to);

/** Why a run stopped. Recorded on the run and in its events; never silent. */
export const STOP_REASONS = [
  'completed',
  'limit_steps',
  'limit_time',
  'limit_tokens',
  'limit_cost',
  'limit_daily_cost',
  'limit_retries',
  'limit_replans',
  'policy_denied',
  'approval_rejected',
  'approval_expired',
  'planner_failed',
  'plan_invalid',
  'tool_failed',
  'dependency_failed',
  'cancelled',
  'worker_lost',
  'rls_unavailable',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export class IllegalTransitionError extends Error {
  constructor(
    readonly kind: 'run' | 'step' | 'approval',
    readonly from: string,
    readonly to: string,
  ) {
    super(`${kind}: illegal transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertRun(from: RunStatus, to: RunStatus): void {
  if (!canRun(from, to)) throw new IllegalTransitionError('run', from, to);
}
export function assertStep(from: StepStatus, to: StepStatus): void {
  if (!canStep(from, to)) throw new IllegalTransitionError('step', from, to);
}
export function assertApproval(from: ApprovalStatus, to: ApprovalStatus): void {
  if (!canApproval(from, to)) throw new IllegalTransitionError('approval', from, to);
}
