/**
 * Research runs, for routes and the UI (P1-D). Every function authenticates
 * the actor against the project here (never trusting the client), and every
 * run-table read or write goes through the store under row-level security.
 */

import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';
import { planTier } from '@/server/ai/gateway';
import type { ResearchRun, RunApproval, RunEvent, RunStep } from '@/server/db/schema';
import { requireProjectRole } from '@/server/graph/service';
import { AppError } from '@/server/http/errors';
import { dispatchResearchRun } from '@/server/jobs/dispatch';
import { jobRunner } from '@/server/jobs/mode';
import { requireVersion } from '@/server/stats/versions';

import { assertRlsEnforced } from './db-scope';
import { cancelRemaining, stopRun } from './executor';
import { limitsFor, type Tier } from './limits';
import { toolsFor } from './planner';
import { productionPolicyDeps } from './policy';
import * as store from './store';
import type { ProjectRole } from './types';

export interface RunActor {
  userId: string;
}

/** Research runs are on only with FF_GRAPH, FF_RUNS and a queue-backed job runner. */
export function runsEnabled(): boolean {
  const env = getEnv();
  return env.FF_GRAPH && env.FF_RUNS && jobRunner() !== 'direct';
}

function assertEnabled(): void {
  const env = getEnv();
  if (!env.FF_GRAPH || !env.FF_RUNS) throw new AppError('NOT_FOUND', 'The resource was not found.', 'العنصر المطلوب غير موجود.');
  if (jobRunner() === 'direct') {
    throw new AppError('UNAVAILABLE', 'Research runs need the background job queue (JOB_RUNNER inline or worker).', 'تحتاج عمليات البحث إلى طابور المهام الخلفية.', { reason: 'queue_required' });
  }
}

async function role(projectId: string, userId: string, minimum: ProjectRole): Promise<ProjectRole> {
  await requireProjectRole(projectId, userId, minimum === 'OWNER' ? 'OWNER' : minimum === 'EDITOR' ? 'EDITOR' : 'VIEWER');
  return (await productionPolicyDeps.role(projectId, userId)) ?? minimum;
}

export interface CreateRunInput {
  intent: string;
  datasetVersionId?: string | null;
  idempotencyKey?: string | null;
}

export async function createRun(actor: RunActor, projectId: string, input: CreateRunInput): Promise<{ run: ResearchRun; created: boolean }> {
  assertEnabled();
  await assertRlsEnforced();
  await role(projectId, actor.userId, 'EDITOR');
  const tier = (await planTier(actor.userId)) as Tier;
  const limits = limitsFor(tier);
  const intent = input.intent.trim();
  if (!intent || intent.length > limits.maxIntentChars) throw new AppError('VALIDATION', `Describe the work in 1–${limits.maxIntentChars} characters.`, 'صِف العمل باختصار.');
  const context: Record<string, unknown> = {};
  if (input.datasetVersionId) {
    const version = await requireVersion(input.datasetVersionId, actor, 'VIEWER', projectId);
    context.datasetVersionId = version.id;
  }
  const created = await store.createRun(
    actor.userId,
    { projectId, intent, context, tier, limits: { ...limits }, idempotencyKey: input.idempotencyKey?.slice(0, 200) ?? null },
    limits.maxActiveRuns,
  );
  if ('refused' in created) {
    throw new AppError('VALIDATION', `You already have ${limits.maxActiveRuns} run(s) in progress. Wait for one to finish.`, 'لديك عمليات قيد التنفيذ؛ انتظر انتهاء إحداها.', { reason: 'too_many_active_runs' });
  }
  if (created.created) await dispatchResearchRun(created.run.id);
  return created;
}

export interface RunDetail {
  run: ResearchRun;
  steps: RunStep[];
  approvals: RunApproval[];
  events: RunEvent[];
  role: ProjectRole;
}

export async function getRun(actor: RunActor, projectId: string, runId: string, eventsAfter = 0): Promise<RunDetail> {
  assertEnabled();
  const current = await role(projectId, actor.userId, 'VIEWER');
  const view = await store.readRunView(actor.userId, runId, projectId, eventsAfter);
  if (!view) throw new AppError('NOT_FOUND', 'The run was not found.', 'لم يُعثر على العملية.');
  return { ...view, role: current };
}

export async function listRuns(actor: RunActor, projectId: string): Promise<ResearchRun[]> {
  assertEnabled();
  await role(projectId, actor.userId, 'VIEWER');
  return store.listRuns(actor.userId, projectId);
}

/** Requests cancellation (monotonic). A run not yet executing a step is cancelled at once. */
export async function cancelRun(actor: RunActor, projectId: string, runId: string): Promise<ResearchRun> {
  assertEnabled();
  const current = await role(projectId, actor.userId, 'EDITOR');
  /* Only the run's owner (still an editor) or a project owner may cancel it (RLS: research_runs_update, migration 0016). */
  const existing = await store.readRun(actor.userId, runId, projectId);
  if (!existing) throw new AppError('NOT_FOUND', 'The run was not found.', 'لم يُعثر على العملية.');
  if (existing.userId !== actor.userId && current !== 'OWNER') {
    throw new AppError('FORBIDDEN', 'Only the person who started the run, or a project owner, can cancel it.', 'يلغي العمليةَ صاحبُها أو مالك المشروع فقط.');
  }
  const run = await store.requestCancel(actor.userId, runId, projectId);
  if (!run) throw new AppError('NOT_FOUND', 'The run was not found.', 'لم يُعثر على العملية.');
  if (run.cancelRequestedAt && (run.status === 'QUEUED' || run.status === 'WAITING_APPROVAL')) {
    /* Nothing is executing: settle it now as the run's owner (RLS: the owner writes its steps). */
    await cancelRemaining(run.userId, run).catch((error: unknown) => logger.warn('runs.cancel.settleFailed', { runId, error: String(error).slice(0, 200) }));
  } else if (run.cancelRequestedAt && ['PLANNING', 'RUNNING'].includes(run.status)) {
    /* The runner sees the request within seconds; re-dispatch in case none is holding it. */
    await dispatchResearchRun(run.id);
  }
  return (await store.readRun(actor.userId, runId, projectId)) ?? run;
}

/**
 * Decides an approval. The client must send back the exact action hash it was
 * shown; only the run's owner (still an editor) or a project owner may decide.
 */
export async function decideApproval(actor: RunActor, projectId: string, runId: string, approvalId: string, input: { decision: 'approve' | 'reject'; actionHash: string }): Promise<RunDetail> {
  assertEnabled();
  const current = await role(projectId, actor.userId, 'EDITOR');
  const approval = await store.readApproval(actor.userId, approvalId);
  if (!approval || approval.runId !== runId || approval.projectId !== projectId) throw new AppError('NOT_FOUND', 'The approval was not found.', 'لم يُعثر على طلب الموافقة.');
  if (approval.userId !== actor.userId && current !== 'OWNER') {
    throw new AppError('FORBIDDEN', 'Only the person who started the run, or a project owner, can decide.', 'يقرّر صاحب العملية أو مالك المشروع فقط.');
  }
  if (approval.status !== 'PENDING') throw new AppError('CONFLICT', 'This approval has already been decided or has expired.', 'حُسم هذا الطلب أو انتهت صلاحيته.', { reason: 'approval_not_pending', status: approval.status });
  if (approval.expiresAt.getTime() <= Date.now()) throw new AppError('CONFLICT', 'This approval request has expired.', 'انتهت صلاحية طلب الموافقة.', { reason: 'approval_expired' });
  if (input.actionHash !== approval.actionHash) {
    throw new AppError('CONFLICT', 'The action changed since it was shown; review it again.', 'تغيّر الإجراء منذ عرضه؛ راجعه من جديد.', { reason: 'action_hash_mismatch' });
  }
  const decided = await store.decideApproval(actor.userId, approval, input.decision === 'approve' ? 'APPROVED' : 'REJECTED');
  if (!decided) throw new AppError('CONFLICT', 'This approval could not be decided (it changed or expired).', 'تعذّر حسم الطلب.', { reason: 'approval_not_pending' });
  if (input.decision === 'reject') {
    /* The owner of the run settles its steps (RLS); a rejection ends the run. */
    try {
      const steps = await store.readSteps(approval.userId, runId);
      const step = steps.find((candidate) => candidate.id === approval.stepId);
      if (step) await store.transitionStep(approval.userId, step, ['WAITING_APPROVAL'], 'SKIPPED', { error: { code: 'approval_rejected' }, finishedAt: new Date() });
      await stopRun(approval.userId, runId, 'approval_rejected');
    } finally {
      /* If settling failed part-way, the executor finishes it from the REJECTED approval. */
      await dispatchResearchRun(runId);
    }
  } else {
    await dispatchResearchRun(runId);
  }
  return getRun(actor, projectId, runId);
}

export interface ToolView {
  name: string;
  version: string;
  category: string;
  description: string;
  sideEffect: string;
  risk: string;
  requiredRole: string;
}

/** The tools the caller could use in a run here (the planner sees the same list). */
export async function listToolsFor(actor: RunActor, projectId: string): Promise<{ tools: ToolView[]; tier: Tier; role: ProjectRole }> {
  assertEnabled();
  const current = await role(projectId, actor.userId, 'VIEWER');
  const tier = (await planTier(actor.userId)) as Tier;
  const tools = toolsFor(current, tier).map((tool) => ({ name: tool.name, version: tool.version, category: tool.category, description: tool.description, sideEffect: tool.sideEffect, risk: tool.risk, requiredRole: tool.requiredRole }));
  return { tools, tier, role: current };
}

/**
 * The reaper's share (P1-D): re-queue runs whose runner disappeared, and settle
 * approvals past their expiry (the waiting step is skipped and the run stops
 * with `approval_expired`). Nothing is executed here.
 */
export async function reapRuns(): Promise<number> {
  if (!getEnv().FF_RUNS) return 0;
  let settled = 0;
  for (const run of await store.systemStrandedRuns()) {
    await dispatchResearchRun(run.id);
    settled += 1;
  }
  for (const expired of await store.systemExpiredApprovals()) {
    const approval = await store.readApproval(expired.userId, expired.id);
    if (!approval) continue;
    if (await store.expireApproval(expired.userId, approval, 'timed_out')) {
      const steps = await store.readSteps(expired.userId, expired.runId);
      const step = steps.find((candidate) => candidate.id === approval.stepId);
      if (step) await store.transitionStep(expired.userId, step, ['WAITING_APPROVAL'], 'SKIPPED', { error: { code: 'approval_expired' }, finishedAt: new Date() });
      await stopRun(expired.userId, expired.runId, 'approval_expired');
      settled += 1;
    }
  }
  return settled;
}
