/**
 * Research runs (P1-D), without a database: the tool registry, the limits,
 * the state machines, the hashes that bind approvals and idempotency, the
 * policy rules and the planner's validation.
 *
 *   npm run test:runs
 *
 * The database behaviour (RLS, triggers, the executor end to end) is in
 * scripts/runs-integration.ts.
 */

import './support/unit-env';

import { actionHash, inputHash, stepIdempotencyKey } from '@/server/runs/approvals';
import { DEFAULT_RUN_LIMITS, HARD_CEILINGS, resolveLimits } from '@/server/runs/limits';
import { decide, storedDecision, type PolicyDeps, type PolicyRequest } from '@/server/runs/policy';
import { gatewayToolsFor, listTools, TOOL_NAMES, toolByName } from '@/server/runs/registry';
import { canApproval, canRun, canStep, IllegalTransitionError, assertRun } from '@/server/runs/state';
import { STATS_TOOL_NAMES } from '@/server/stats/tool-names';

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         expected ${JSON.stringify(expected)}\n         got      ${JSON.stringify(actual)}`}`);
}
const section = (title: string) => console.log(`\n${title}`);

async function main() {
  section('Tool registry: one authoritative list');
  check('exactly the planned tools', [...TOOL_NAMES].sort(), [
    'createAnalysisSpec', 'createClaim', 'createDatasetVersion', 'createGraphNode', 'explainResult', 'extractEvidence', 'generateDraft',
    'generateFigureFromResult', 'generateTableFromResult', 'getAnalysisProvenance', 'getAnalysisResult', 'inspectDataset', 'listDatasets',
    'readGraph', 'replaceDatasetVersion', 'retrieveSource', 'runAnalysis', 'searchLiterature', 'validateAnalysisSpec', 'validateDataset',
  ]);
  check('unknown names are not tools', [toolByName('updateResultNumbers'), toolByName('createFakeResult'), toolByName('overwriteVerifiedResult'), toolByName(42), toolByName('__proto__')], [null, null, null, null, null]);
  check('no tool writes, fakes or overwrites results', TOOL_NAMES.some((name) => /fake|overwrite|updateResult|setResult|editResult|deleteResult/i.test(name)), false);
  check('no tool deletes anything, exports, or writes sections', TOOL_NAMES.some((name) => /delete|remove|export|section|publish|pls|cbsem|deepResearch/i.test(name)), false);
  const all = listTools();
  check('every tool that creates or changes something is idempotent on the step key', all.filter((tool) => tool.sideEffect !== 'read' && tool.sideEffect !== 'external_read' && tool.idempotency !== 'keyed' && tool.sideEffect !== 'compute').map((tool) => tool.name), []);
  check('scientific creators are keyed', ['createAnalysisSpec', 'runAnalysis', 'createDatasetVersion', 'createClaim', 'createGraphNode', 'replaceDatasetVersion'].map((name) => toolByName(name)?.idempotency), ['keyed', 'keyed', 'keyed', 'keyed', 'keyed', 'keyed']);
  check('destructive tools are never retried', all.filter((tool) => tool.sideEffect === 'destructive').map((tool) => [tool.name, tool.maxAttempts]), [['replaceDatasetVersion', 1]]);
  check('every tool has a version, a timeout and a role', all.every((tool) => /^\d+\.\d+\.\d+$/.test(tool.version) && tool.timeoutMs > 0 && ['VIEWER', 'EDITOR', 'OWNER'].includes(tool.requiredRole)), true);
  check('tools that change the project need an editor', all.filter((tool) => tool.sideEffect !== 'read' && tool.sideEffect !== 'external_read' && tool.category !== 'writing' && tool.name !== 'extractEvidence').every((tool) => tool.requiredRole !== 'VIEWER'), true);
  check('the assistant is offered exactly the seven statistics tools', listTools('assistant').map((tool) => tool.name), [...STATS_TOOL_NAMES]);
  check('each tool converts to a gateway tool with a JSON Schema', gatewayToolsFor(TOOL_NAMES).map((tool) => typeof tool.parameters === 'object' && tool.parameters !== null).every(Boolean), true);
  check('… only the names asked for', gatewayToolsFor(['runAnalysis', 'nope']).map((tool) => tool.name), ['runAnalysis']);
  const strict = toolByName('runAnalysis')!.input.safeParse({ specId: 'x', extra: 'injected' });
  check('tool inputs are strict: an injected parameter is refused', strict.success, false);
  const oversized = toolByName('searchLiterature')!.input.safeParse({ query: 'x'.repeat(400) });
  check('… and bounded', oversized.success, false);
  check('the registry cannot be modified', (() => { try { (listTools() as unknown as unknown[]).push({}); return 'modified'; } catch { return 'refused'; } })(), 'refused');

  section('Limits: central, per tier, configurable but capped');
  check('free tier as planned', [DEFAULT_RUN_LIMITS.free.maxSteps, DEFAULT_RUN_LIMITS.free.maxDurationMs, DEFAULT_RUN_LIMITS.free.maxRunTokens, DEFAULT_RUN_LIMITS.free.maxCostMicroUsd, DEFAULT_RUN_LIMITS.free.maxDailyCostMicroUsd, DEFAULT_RUN_LIMITS.free.maxActiveRuns], [10, 600_000, 60_000, 200_000, 1_000_000, 1]);
  check('paid tier as planned', [DEFAULT_RUN_LIMITS.paid.maxSteps, DEFAULT_RUN_LIMITS.paid.maxDurationMs, DEFAULT_RUN_LIMITS.paid.maxRunTokens, DEFAULT_RUN_LIMITS.paid.maxCostMicroUsd, DEFAULT_RUN_LIMITS.paid.maxActiveRuns], [20, 1_800_000, 400_000, 2_000_000, 3]);
  check('admin tier as planned', [DEFAULT_RUN_LIMITS.admin.maxSteps, DEFAULT_RUN_LIMITS.admin.maxDurationMs, DEFAULT_RUN_LIMITS.admin.maxRunTokens, DEFAULT_RUN_LIMITS.admin.maxActiveRuns], [30, 3_600_000, 1_000_000, 5]);
  check('payload limits as planned', [DEFAULT_RUN_LIMITS.free.maxStepInputBytes, DEFAULT_RUN_LIMITS.free.maxStepOutputBytes, DEFAULT_RUN_LIMITS.free.maxPlanBytes], [16_384, 65_536, 65_536]);
  check('an override can make a tier stricter', resolveLimits('{"free":{"maxSteps":4}}').free.maxSteps, 4);
  const refuses = (raw: string) => { try { resolveLimits(raw); return 'accepted'; } catch { return 'refused'; } };
  check('… never above the hard ceiling', refuses(`{"paid":{"maxSteps":${HARD_CEILINGS.maxSteps + 1}}}`), 'refused');
  check('… never with an unknown key', refuses('{"free":{"maxWhatever":1}}'), 'refused');
  check('… nested runs stay impossible', refuses('{"free":{"maxDepth":1}}'), 'refused');
  check('… a step stays one tool call', refuses('{"free":{"maxToolCallsPerStep":2}}'), 'refused');
  check('the limits are frozen', Object.isFrozen(DEFAULT_RUN_LIMITS.free), true);

  section('State machines (the same tables as the database triggers)');
  check('a run plans, runs, waits for approval and finishes', [canRun('QUEUED', 'PLANNING'), canRun('PLANNING', 'RUNNING'), canRun('RUNNING', 'WAITING_APPROVAL'), canRun('WAITING_APPROVAL', 'QUEUED'), canRun('RUNNING', 'SUCCEEDED')], [true, true, true, true, true]);
  check('a finished run never moves', [canRun('SUCCEEDED', 'RUNNING'), canRun('CANCELLED', 'SUCCEEDED'), canRun('FAILED', 'QUEUED'), canRun('CANCELLED', 'RUNNING')], [false, false, false, false]);
  check('a completed step is never cancelled or re-run', [canStep('SUCCEEDED', 'CANCELLED'), canStep('SUCCEEDED', 'QUEUED'), canStep('SKIPPED', 'QUEUED')], [false, false, false]);
  check('a step runs only once authorised', [canStep('QUEUED', 'RUNNING'), canStep('WAITING_APPROVAL', 'RUNNING'), canStep('AUTHORIZED', 'RUNNING')], [false, false, true]);
  check('a failed step may be retried', canStep('FAILED', 'QUEUED'), true);
  check('an approval is single use', [canApproval('APPROVED', 'CONSUMED'), canApproval('CONSUMED', 'APPROVED'), canApproval('REJECTED', 'APPROVED'), canApproval('EXPIRED', 'APPROVED')], [true, false, false, false]);
  check('an illegal move throws', (() => { try { assertRun('CANCELLED', 'SUCCEEDED'); return 'moved'; } catch (error) { return error instanceof IllegalTransitionError ? 'refused' : 'other'; } })(), 'refused');

  section('Hashes: approvals and idempotency bound to the exact action');
  const base = { projectId: 'p', runId: 'r', stepId: 's', userId: 'u', tool: 'replaceDatasetVersion', toolVersion: '1.0.0', inputHash: inputHash({ oldVersionId: 'a', newVersionId: 'b' }), reason: 'replaces_data', targets: { oldContentHash: 'h1' }, impactHash: 'i1' };
  const h = actionHash(base);
  check('the approval hash is deterministic', actionHash({ ...base }), h);
  check('… and changes when the input changes', actionHash({ ...base, inputHash: inputHash({ oldVersionId: 'a', newVersionId: 'c' }) }) !== h, true);
  check('… when the data it touches changes', actionHash({ ...base, targets: { oldContentHash: 'h2' } }) !== h, true);
  check('… when the Impact Report changes', actionHash({ ...base, impactHash: 'i2' }) !== h, true);
  check('… for another step, run, project, user or tool version', [actionHash({ ...base, stepId: 's2' }), actionHash({ ...base, runId: 'r2' }), actionHash({ ...base, projectId: 'p2' }), actionHash({ ...base, userId: 'u2' }), actionHash({ ...base, toolVersion: '1.0.1' })].every((other) => other !== h), true);
  check('input hashing ignores key order', inputHash({ a: 1, b: 2 }), inputHash({ b: 2, a: 1 }));
  const key = stepIdempotencyKey({ projectId: 'p', runId: 'r', seq: 0, tool: 'runAnalysis', toolVersion: '1.0.0', inputHash: 'x' });
  check('the step idempotency key is deterministic (a retry reuses it)', stepIdempotencyKey({ projectId: 'p', runId: 'r', seq: 0, tool: 'runAnalysis', toolVersion: '1.0.0', inputHash: 'x' }), key);
  check('… and distinct per step and input', [stepIdempotencyKey({ projectId: 'p', runId: 'r', seq: 1, tool: 'runAnalysis', toolVersion: '1.0.0', inputHash: 'x' }), stepIdempotencyKey({ projectId: 'p', runId: 'r', seq: 0, tool: 'runAnalysis', toolVersion: '1.0.0', inputHash: 'y' })].every((other) => other !== key), true);

  section('Policy: server-side, rule by rule, never from the model');
  const now = new Date('2026-09-23T12:00:00Z');
  const deps = (over: Partial<PolicyDeps> = {}): PolicyDeps => ({
    flags: () => ({ graph: true, runs: true }),
    role: async () => 'EDITOR',
    resource: async () => true,
    tier: async () => 'paid',
    runUsage: async () => ({ tokens: 0, costMicroUsd: 0 }),
    dailyCost: async () => 0,
    limits: (tier) => DEFAULT_RUN_LIMITS[tier],
    now: () => now,
    ...over,
  });
  const run = { id: 'run', status: 'RUNNING', cancelRequested: false, startedAt: new Date(now.getTime() - 60_000), retries: 0 };
  const request = (over: Partial<PolicyRequest> = {}): PolicyRequest => ({ userId: 'u', projectId: 'p', toolName: 'getAnalysisResult', input: { runId: 'x' }, execution: 'run', run, stepId: 's', inputHash: 'h', ...over });
  const outcome = async (req: PolicyRequest, d: PolicyDeps = deps()) => {
    const decision = await decide(req, d);
    return [decision.outcome, decision.reason ?? null];
  };
  check('a registered read by an editor in a running run is allowed', await outcome(request()), ['ALLOW', null]);
  check('an arbitrary tool name is denied', await outcome(request({ toolName: 'runShell' })), ['DENY', 'tool.known']);
  check('a non-string tool name is denied', await outcome(request({ toolName: { name: 'runAnalysis' } })), ['DENY', 'tool.known']);
  check('a tool outside its context is denied (data tools are not the assistant’s)', await outcome(request({ toolName: 'listDatasets', input: {}, execution: 'assistant' })), ['DENY', 'tool.context']);
  check('runs are denied with FF_RUNS off', await outcome(request(), deps({ flags: () => ({ graph: true, runs: false }) })), ['DENY', 'flag']);
  check('the assistant is denied with FF_GRAPH off', await outcome(request({ execution: 'assistant' }), deps({ flags: () => ({ graph: false, runs: false }) })), ['DENY', 'flag']);
  check('a non-member is denied (forged project id)', await outcome(request(), deps({ role: async () => null })), ['DENY', 'auth.project']);
  check('a viewer is denied a tool that needs an editor', await outcome(request({ toolName: 'runAnalysis', input: { specId: 'x' } }), deps({ role: async () => 'VIEWER' })), ['DENY', 'auth.project']);
  check('a resource of another project is denied (forged id)', await outcome(request(), deps({ resource: async () => false })), ['DENY', 'auth.resources']);
  check('a tier without the entitlement is denied', await outcome(request(), deps({ tier: async () => 'enterprise' as never, limits: () => DEFAULT_RUN_LIMITS.paid })), ['DENY', 'entitlement']);
  check('past the run’s time limit is denied', await outcome(request({ run: { ...run, startedAt: new Date(now.getTime() - 31 * 60_000) } })), ['DENY', 'limits.run']);
  check('past the run’s token budget (metered) is denied', await outcome(request(), deps({ runUsage: async () => ({ tokens: 400_000, costMicroUsd: 0 }) })), ['DENY', 'limits.run']);
  check('past the run’s cost budget (metered) is denied', await outcome(request(), deps({ runUsage: async () => ({ tokens: 0, costMicroUsd: 2_000_001 }) })), ['DENY', 'limits.run']);
  check('a model tool whose estimate would pass the budget is denied before it runs', await outcome(request({ toolName: 'extractEvidence', input: { question: 'q?', text: 'x'.repeat(60) } }), deps({ runUsage: async () => ({ tokens: 399_000, costMicroUsd: 0 }) })), ['DENY', 'limits.run']);
  check('past the daily cost limit is denied', await outcome(request(), deps({ dailyCost: async () => 20_000_000 })), ['DENY', 'limits.user']);
  check('too many retries is denied', await outcome(request({ run: { ...run, retries: 9 } })), ['DENY', 'limits.run']);
  check('a cancelled run executes nothing', await outcome(request({ run: { ...run, cancelRequested: true } })), ['DENY', 'run.state']);
  check('a run that is not running executes nothing', await outcome(request({ run: { ...run, status: 'WAITING_APPROVAL' } })), ['DENY', 'run.state']);
  const decision = await decide(request(), deps());
  check('every rule’s result is recorded', decision.rules.map((rule) => rule.rule), ['tool.known', 'tool.context', 'flag', 'auth.project', 'auth.resources', 'entitlement', 'limits.run', 'limits.user', 'run.state', 'approval']);
  check('the stored decision has no inputs', Object.keys(storedDecision(decision)).sort(), ['approval', 'evaluatedAt', 'outcome', 'reason', 'role', 'rules', 'tier', 'tool']);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
