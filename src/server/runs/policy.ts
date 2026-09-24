/**
 * The policy decision (P1-D): ALLOW, DENY or REQUIRE_APPROVAL, for one tool
 * execution, on the server, immediately before it runs.
 *
 * Rules are evaluated in a fixed order and the first DENY wins. The decision
 * is built only from the registry's declaration of the tool, the caller's
 * project role, the resources the input names, the plan tier, the metered
 * usage and the run's state — never from anything a model said. Every rule's
 * result is kept on the decision, so "why was this allowed?" has an answer.
 */

import { and, eq, gt, sql } from 'drizzle-orm';

import { getEnv } from '@/config/env';
import { planTier } from '@/server/ai/gateway';
import { db } from '@/server/db';
import { aiUsageEvents } from '@/server/db/schema';
import * as graph from '@/server/graph/service';
import { AppError } from '@/server/http/errors';
import { requireRun, requireSpec } from '@/server/stats/runs';
import { requireVersion } from '@/server/stats/versions';

import { actionHash } from './approvals';
import { activeElapsedMs, limitsFor, MODEL_CALL_ESTIMATE, type RunLimits, type Tier } from './limits';
import { toolByName } from './registry';
import type { ApprovalNeed, ProjectRole, ResourceRef, ToolContext, ToolContextKind, ToolDef } from './types';

export type PolicyOutcome = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

export interface RuleResult {
  rule: string;
  ok: boolean;
  detail?: string;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  /** The first failing rule, when denied. */
  reason?: string;
  rules: RuleResult[];
  tool: string;
  tier?: Tier;
  role?: ProjectRole;
  approval?: { need: ApprovalNeed; actionHash: string; approvalId?: string };
  evaluatedAt: string;
}

export interface RunState {
  id: string;
  status: string;
  cancelRequested: boolean;
  startedAt: Date | null;
  retries: number;
  /** Time spent parked on approvals (`spent.waitedMs`); not counted against `maxDurationMs`. */
  waitedMs?: number;
}

export interface ExistingApproval {
  id: string;
  status: string;
  actionHash: string;
  expiresAt: Date;
}

export interface PolicyRequest {
  userId: string;
  projectId: string;
  toolName: unknown;
  /** Validated against the tool's schema by the caller; the policy never re-parses model output. */
  input: Record<string, unknown>;
  execution: ToolContextKind;
  run?: RunState;
  stepId?: string;
  inputHash?: string;
  approvals?: ExistingApproval[];
  /** For `tool.approval()`; the idempotency key is not needed to decide. */
  toolContext?: Omit<ToolContext, 'idempotencyKey' | 'signal'>;
}

/** Everything the policy looks up, injectable for tests. */
export interface PolicyDeps {
  flags(): { graph: boolean; runs: boolean };
  role(projectId: string, userId: string): Promise<ProjectRole | null>;
  resource(ref: ResourceRef, userId: string, projectId: string): Promise<boolean>;
  tier(userId: string): Promise<Tier>;
  runUsage(runId: string): Promise<{ tokens: number; costMicroUsd: number }>;
  dailyCost(userId: string): Promise<number>;
  limits(tier: Tier): Readonly<RunLimits>;
  now(): Date;
}

const RANK: Record<ProjectRole, number> = { VIEWER: 1, EDITOR: 3, OWNER: 4 };

export const productionPolicyDeps: PolicyDeps = {
  flags: () => ({ graph: getEnv().FF_GRAPH, runs: getEnv().FF_RUNS }),
  async role(projectId, userId) {
    for (const role of ['OWNER', 'EDITOR', 'VIEWER'] as const) {
      try {
        await graph.requireProjectRole(projectId, userId, role);
        return role;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        if (error.code === 'NOT_FOUND') return null;
      }
    }
    return null;
  },
  async resource(ref, userId, projectId) {
    const actor = { userId };
    try {
      if (ref.kind === 'datasetVersion') await requireVersion(ref.id, actor, 'VIEWER', projectId);
      else if (ref.kind === 'spec') await requireSpec(ref.id, actor, 'VIEWER', projectId);
      else if (ref.kind === 'statRun') await requireRun(ref.id, actor, 'VIEWER', projectId);
      else await graph.getNode(projectId, actor, ref.id);
      return true;
    } catch (error) {
      if (error instanceof AppError) return false;
      throw error;
    }
  },
  tier: (userId) => planTier(userId),
  async runUsage(runId) {
    const [row] = await db
      .select({ tokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)::bigint`, cost: sql<number>`coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::bigint` })
      .from(aiUsageEvents)
      .where(eq(aiUsageEvents.runId, runId));
    return { tokens: Number(row?.tokens ?? 0), costMicroUsd: Number(row?.cost ?? 0) };
  },
  async dailyCost(userId) {
    const [row] = await db
      .select({ cost: sql<number>`coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::bigint` })
      .from(aiUsageEvents)
      .where(and(eq(aiUsageEvents.userId, userId), gt(aiUsageEvents.createdAt, sql`now() - interval '1 day'`)));
    return Number(row?.cost ?? 0);
  },
  limits: limitsFor,
  now: () => new Date(),
};

/** The decision for one execution. Never throws for a denial; throws only on infrastructure errors. */
export async function decide(request: PolicyRequest, deps: PolicyDeps = productionPolicyDeps): Promise<PolicyDecision> {
  const rules: RuleResult[] = [];
  const evaluatedAt = deps.now().toISOString();
  const tool = toolByName(request.toolName);
  const name = typeof request.toolName === 'string' ? request.toolName.slice(0, 80) : String(request.toolName).slice(0, 80);
  const deny = (rule: string, detail: string, extra: Partial<PolicyDecision> = {}): PolicyDecision => {
    rules.push({ rule, ok: false, detail });
    return { outcome: 'DENY', reason: rule, rules, tool: name, evaluatedAt, ...extra };
  };
  const pass = (rule: string, detail?: string) => rules.push({ rule, ok: true, ...(detail ? { detail } : {}) });

  /* 1. Only registered tools exist. */
  if (!tool) return deny('tool.known', 'not in the registry');
  pass('tool.known', `${tool.name}@${tool.version}`);

  /* 2. The tool is offered in this context. */
  if (!tool.contexts.includes(request.execution)) return deny('tool.context', `not available in ${request.execution}`);
  pass('tool.context', request.execution);

  /* 3. The feature is switched on. */
  const flags = deps.flags();
  if (!flags.graph || (request.execution === 'run' && !flags.runs)) return deny('flag', request.execution === 'run' ? 'FF_RUNS off' : 'FF_GRAPH off');
  pass('flag');

  /* 4. The caller's role on the project, fresh (never from a token or the client). */
  const role = await deps.role(request.projectId, request.userId);
  if (!role) return deny('auth.project', 'not a member of this project');
  if (RANK[role] < RANK[tool.requiredRole]) return deny('auth.project', `${role} < ${tool.requiredRole}`, { role });
  pass('auth.project', role);

  /* 5. Every resource the input names belongs to this project and is visible to the caller. */
  let refs: ResourceRef[];
  try {
    refs = tool.resources(request.input as never);
  } catch {
    return deny('auth.resources', 'input names no valid resources', { role });
  }
  for (const ref of refs) {
    if (!(await deps.resource(ref, request.userId, request.projectId))) return deny('auth.resources', `${ref.kind} not in this project`, { role });
  }
  pass('auth.resources', `${refs.length} checked`);

  /* 6. The plan tier is entitled to the tool. */
  const tier = await deps.tier(request.userId);
  if (!tool.tiers.includes(tier)) return deny('entitlement', `${tier} plan`, { role, tier });
  pass('entitlement', tier);

  const limits = deps.limits(tier);
  const estimate = { tokens: tool.estimatedModelCalls * MODEL_CALL_ESTIMATE.tokens, costMicroUsd: tool.estimatedModelCalls * MODEL_CALL_ESTIMATE.costMicroUsd };

  /* 7. The run's budget: time, retries, metered tokens and cost (plus this tool's estimate). */
  if (request.execution === 'run') {
    const run = request.run;
    if (!run) return deny('limits.run', 'no run', { role, tier });
    if (activeElapsedMs(run.startedAt, { waitedMs: run.waitedMs ?? 0 }, deps.now().getTime()) > limits.maxDurationMs) return deny('limits.run', 'limit_time', { role, tier });
    if (run.retries > limits.maxRetriesPerRun) return deny('limits.run', 'limit_retries', { role, tier });
    const usage = await deps.runUsage(run.id);
    if (usage.tokens >= limits.maxRunTokens || usage.tokens + estimate.tokens > limits.maxRunTokens) return deny('limits.run', 'limit_tokens', { role, tier });
    if (usage.costMicroUsd >= limits.maxCostMicroUsd || usage.costMicroUsd + estimate.costMicroUsd > limits.maxCostMicroUsd) return deny('limits.run', 'limit_cost', { role, tier });
    pass('limits.run', `tokens ${usage.tokens}, cost ${usage.costMicroUsd}`);
  }

  /* 8. The user's daily spend across runs. */
  if (estimate.costMicroUsd > 0 || request.execution === 'run') {
    const daily = await deps.dailyCost(request.userId);
    if (daily >= limits.maxDailyCostMicroUsd || daily + estimate.costMicroUsd > limits.maxDailyCostMicroUsd) return deny('limits.user', 'limit_daily_cost', { role, tier });
    pass('limits.user', `daily cost ${daily}`);
  }

  /* 9. The run is live: running, not cancelled. */
  if (request.execution === 'run') {
    if (request.run?.cancelRequested) return deny('run.state', 'cancel requested', { role, tier });
    if (request.run?.status !== 'RUNNING') return deny('run.state', `run is ${request.run?.status}`, { role, tier });
    pass('run.state');
  }

  /* 10. Approval, bound to the exact action. */
  const context = request.toolContext ?? { userId: request.userId, projectId: request.projectId, tier, execution: request.execution };
  const need = await tool.approval(request.input as never, { ...context, idempotencyKey: '', signal: new AbortController().signal } as ToolContext);
  if (!need) {
    pass('approval', 'not required');
    return { outcome: 'ALLOW', rules, tool: tool.name, tier, role, evaluatedAt };
  }
  if (request.execution !== 'run' || !request.run || !request.stepId || !request.inputHash) {
    /* The assistant has no approval flow: an action that needs one is refused there and must go through a run. */
    return deny('approval', `requires approval (${need.reason}); use a research run`, { role, tier });
  }
  const hash = actionHash({
    projectId: request.projectId,
    runId: request.run.id,
    stepId: request.stepId,
    userId: request.userId,
    tool: tool.name,
    toolVersion: tool.version,
    inputHash: request.inputHash,
    reason: need.reason,
    targets: need.targets,
    impactHash: need.impactHash ?? null,
  });
  const approved = (request.approvals ?? []).find((approval) => approval.status === 'APPROVED' && approval.actionHash === hash && approval.expiresAt.getTime() > deps.now().getTime());
  if (approved) {
    pass('approval', `approved ${approved.id}`);
    return { outcome: 'ALLOW', rules, tool: tool.name, tier, role, evaluatedAt, approval: { need, actionHash: hash, approvalId: approved.id } };
  }
  rules.push({ rule: 'approval', ok: false, detail: need.reason });
  return { outcome: 'REQUIRE_APPROVAL', reason: 'approval', rules, tool: tool.name, tier, role, evaluatedAt, approval: { need, actionHash: hash } };
}

/** The policy decision as stored on a step (bounded, no inputs or secrets). */
export function storedDecision(decision: PolicyDecision): Record<string, unknown> {
  return {
    outcome: decision.outcome,
    reason: decision.reason ?? null,
    tool: decision.tool,
    tier: decision.tier ?? null,
    role: decision.role ?? null,
    rules: decision.rules.map((rule) => ({ rule: rule.rule, ok: rule.ok, detail: rule.detail?.slice(0, 120) ?? null })),
    approval: decision.approval ? { reason: decision.approval.need.reason, actionHash: decision.approval.actionHash, approvalId: decision.approval.approvalId ?? null } : null,
    evaluatedAt: decision.evaluatedAt,
  };
}

export type { ToolDef };
