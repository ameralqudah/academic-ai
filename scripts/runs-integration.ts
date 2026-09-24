/**
 * Research runs (P1-D) against PostgreSQL: row-level security, the database
 * triggers, and the executor end to end with a scripted model (no network).
 *
 *   DATABASE_URL=…/academic_ai_test npm run db:migrate && npm run db:seed
 *   DATABASE_URL=…/academic_ai_test npm run test:runs:db
 *
 * The run: intent → plan (gateway) → registry → policy → approval (hash) →
 * executor → P1-C statistics engine → Research Graph provenance → events.
 * Security: forged tool names, projects, resources and approvals; privilege;
 * RLS at the database; direct state changes refused by triggers. Failure:
 * crash mid-step (no duplicate scientific records), cancellation, limits,
 * expired approvals, an approval whose action changed.
 */

import 'dotenv/config';

process.env.JOB_RUNNER = 'inline';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { and, eq, sql } from 'drizzle-orm';

import { resetEnvCache } from '@/config/env';
import { forgetPlan, productionDeps, setGatewayForTests } from '@/server/ai/gateway';
import { FakeAdapter } from '@/server/ai/gateway/adapters/fake';
import { createGateway } from '@/server/ai/gateway/gateway';
import { db } from '@/server/db';
import { aiUsageEvents, datasetVersions as datasetVersionsTable, graphEdges, graphNodes, projectMembers, researchRuns, runApprovals, runEvents, runSteps, statRuns, statSpecs, usageTracking } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as projectsRepo from '@/server/repositories/projects.repository';
import { register } from '@/server/services/account.service';
import { saveUpload } from '@/server/services/dataset.service';
import { assertRlsEnforced, forgetRlsCheck, withRunScope } from '@/server/runs/db-scope';
import * as executorModule from '@/server/runs/executor';
import { advanceRun } from '@/server/runs/executor';
import { resetLimits } from '@/server/runs/limits';
import { toolByName } from '@/server/runs/registry';
import { cancelRun, createRun, decideApproval, getRun, listToolsFor, reapRuns } from '@/server/runs/service';
import * as store from '@/server/runs/store';
import { previewVersionReplacement, replacementOf, replaceVersion } from '@/server/stats/graph';
import { createSpec, startRun } from '@/server/stats/runs';
import { listVersions, transformVersion } from '@/server/stats/versions';

const RUN = `runs-${Date.now()}`;
/** Idempotency keys unique to this test run (keys are global, as in production). */
const testKey = (label: string) => createHash('sha256').update(`${RUN}:${label}`).digest('hex');
let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         expected ${JSON.stringify(expected)}\n         got      ${JSON.stringify(actual)}`}`);
}
async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    if (error instanceof AppError) return `${error.code}${(error.details as { reason?: string } | undefined)?.reason ? `:${(error.details as { reason: string }).reason}` : ''}`;
    return `db:${String((error as { cause?: { message?: string } }).cause?.message ?? error).slice(0, 90)}`;
  }
}
async function refused(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return false;
  } catch (error) {
    return !(error instanceof AppError);
  }
}
const section = (title: string) => console.log(`\n${title}`);

/** A transaction as the restricted role with `userId` set: what the database lets that user do. */
async function asApp<T>(userId: string | null, work: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role academic_app`);
    if (userId) await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return work(tx);
  });
}

async function main() {
  process.env.FF_GRAPH = 'true';
  process.env.FF_RUNS = 'true';
  resetEnvCache();
  resetLimits();

  const user = async (name: string) => (await register({ name, email: `${RUN}-${name}@example.test`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123', locale: 'en' })).id;
  const owner = await user('owner');
  const editor = await user('editor');
  const viewer = await user('viewer');
  const stranger = await user('stranger');
  const project = await projectsRepo.create({ userId: owner, title: 'Runs', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  const theirs = await projectsRepo.create({ userId: stranger, title: 'Theirs', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  await db.insert(projectMembers).values([{ projectId: project.id, userId: editor, role: 'EDITOR' }, { projectId: project.id, userId: viewer, role: 'VIEWER' }]);
  const P = project.id;
  const me = { userId: owner };

  const csv = readFileSync('evals/fixtures/datasets/engine_survey.csv');
  const bytes = csv.buffer.slice(csv.byteOffset, csv.byteOffset + csv.byteLength) as ArrayBuffer;
  const upload = await saveUpload({ userId: owner, projectId: P, file: { name: 'survey.csv', bytes } });
  const v1 = (await listVersions(me, upload.dataset.id, P)).versions[0]!;
  const items = ['T1', 'T2', 'T3', 'T4', 'S1', 'S2', 'S3', 'S4'];
  const { version: v2 } = await transformVersion(me, v1.id, { operation: 'set-schema', columns: [...items.map((name) => ({ name, type: 'ordinal' as const, scaleMin: 1, scaleMax: 5 })), { name: 'group', type: 'nominal' as const }, { name: 'bin', type: 'binary' as const }] }, P);
  const foreignUpload = await saveUpload({ userId: stranger, projectId: theirs.id, file: { name: 'theirs.csv', bytes } });
  const foreignVersion = (await listVersions({ userId: stranger }, foreignUpload.dataset.id, theirs.id)).versions[0]!;

  const fake = new FakeAdapter('openai');
  setGatewayForTests(createGateway({ ...productionDeps, adapters: () => ({ openai: fake }), models: async () => ({ configured: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai', siblings: {} }) }));
  /* One scripted plan per run: any reply left unused (a run cancelled before planning) is discarded first. */
  const planReply = (steps: unknown[]) => {
    (fake as unknown as { script: unknown[] }).script.length = 0;
    fake.push({ reply: { text: JSON.stringify({ summary: 'test plan', steps }) } });
  };
  const drain = async (runId: string) => {
    for (let i = 0; i < 5; i += 1) await advanceRun(runId);
    return store.readRun(owner, runId);
  };
  /* Each scenario gets its own slot: free users may hold one active run. */
  const finish = async (runId: string, userId = owner) => {
    const run = await store.readRun(userId, runId);
    if (run && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) await cancelRun({ userId }, P, runId).catch(() => undefined);
  };

  /* ------------------------------------------------------------------ */
  section('Row-level security is enforced by the database');
  await assertRlsEnforced();
  check('the run engine proves RLS before starting (restricted role, no bypass, RLS on)', true, true);
  const probe = (await createRun(me, P, { intent: 'probe run for RLS' })).run;
  check('the owner reads the run through RLS', (await asApp(owner, (tx) => tx.select().from(researchRuns).where(eq(researchRuns.id, probe.id)))).length, 1);
  check('a viewer of the project reads it', (await asApp(viewer, (tx) => tx.select().from(researchRuns).where(eq(researchRuns.id, probe.id)))).length, 1);
  check('a stranger reads nothing', (await asApp(stranger, (tx) => tx.select().from(researchRuns).where(eq(researchRuns.id, probe.id)))).length, 0);
  check('with no user set, nothing is visible', (await asApp(null, (tx) => tx.select().from(researchRuns))).length, 0);
  check('… and no event either', (await asApp(stranger, (tx) => tx.select().from(runEvents).where(eq(runEvents.runId, probe.id)))).length, 0);
  check('a stranger cannot create a run in the project (forged project id)', await refused(() => asApp(stranger, (tx) => tx.insert(researchRuns).values({ projectId: P, userId: stranger, intent: 'x', tier: 'free', limits: {} }))), true);
  check('a viewer cannot create one', await refused(() => asApp(viewer, (tx) => tx.insert(researchRuns).values({ projectId: P, userId: viewer, intent: 'x', tier: 'free', limits: {} }))), true);
  check('nobody creates a run in someone else’s name', await refused(() => asApp(editor, (tx) => tx.insert(researchRuns).values({ projectId: P, userId: owner, intent: 'x', tier: 'free', limits: {} }))), true);
  const strangerUpdate = await asApp(stranger, (tx) => tx.update(researchRuns).set({ cancelRequestedAt: new Date() }).where(eq(researchRuns.id, probe.id)).returning({ id: researchRuns.id }));
  check('a stranger’s update touches nothing', strangerUpdate.length, 0);
  const viewerUpdate = await asApp(viewer, (tx) => tx.update(researchRuns).set({ cancelRequestedAt: new Date() }).where(eq(researchRuns.id, probe.id)).returning({ id: researchRuns.id }));
  check('a viewer’s update touches nothing', viewerUpdate.length, 0);
  check('the restricted role cannot delete', await refused(() => asApp(owner, (tx) => tx.delete(researchRuns).where(eq(researchRuns.id, probe.id)))), true);
  check('the application scope is the restricted role (not the owner connection)', await withRunScope(owner, async (tx) => ((await tx.execute(sql`select current_user as u`)) as unknown as { u: string }[])[0]?.u), 'academic_app');
  await db.execute(sql`alter role academic_app bypassrls`);
  forgetRlsCheck();
  check('if the role could bypass RLS, runs refuse to start (no application-only fallback)', await outcome(() => assertRlsEnforced()), 'UNAVAILABLE:rls_unavailable');
  await db.execute(sql`alter role academic_app nobypassrls`);
  forgetRlsCheck();
  await assertRlsEnforced();
  await finish(probe.id);

  /* ------------------------------------------------------------------ */
  section('Database triggers: the run record cannot be rewritten');
  const [frozen] = await db.select().from(researchRuns).where(eq(researchRuns.id, probe.id));
  check('the probe run was cancelled monotonically', [frozen?.status, frozen?.stopReason, Boolean(frozen?.cancelRequestedAt)], ['CANCELLED', 'cancelled', true]);
  check('a cancelled run can never succeed (even by the owner connection)', await refused(() => db.update(researchRuns).set({ status: 'SUCCEEDED', finishedAt: new Date() }).where(eq(researchRuns.id, probe.id))), true);
  check('… nor be un-cancelled', await refused(() => db.update(researchRuns).set({ cancelRequestedAt: null }).where(eq(researchRuns.id, probe.id))), true);
  check('a run cannot change project or owner', await refused(() => db.update(researchRuns).set({ projectId: theirs.id }).where(eq(researchRuns.id, probe.id))), true);
  check('a run cannot be created already running', await refused(() => db.insert(researchRuns).values({ projectId: P, userId: owner, intent: 'x', tier: 'free', limits: {}, status: 'RUNNING' })), true);
  check('run events are append-only', await refused(() => db.update(runEvents).set({ type: 'edited' }).where(eq(runEvents.runId, probe.id))), true);
  check('… and cannot be deleted', await refused(() => db.delete(runEvents).where(eq(runEvents.runId, probe.id))), true);
  check('run tables cannot be truncated', await refused(() => db.execute(sql`truncate run_events`)), true);
  check('an oversized intent is refused by the database', await refused(() => db.insert(researchRuns).values({ projectId: P, userId: owner, intent: 'x'.repeat(5000), tier: 'free', limits: {} })), true);

  /* ------------------------------------------------------------------ */
  section('A full run: plan → policy → approval → P1-C engine → graph');
  check('a viewer cannot start a run', await outcome(() => createRun({ userId: viewer }, P, { intent: 'x' })), 'FORBIDDEN');
  check('a stranger cannot start a run in the project', await outcome(() => createRun({ userId: stranger }, P, { intent: 'x' })), 'NOT_FOUND');
  check('a run cannot name another project’s dataset', await outcome(() => createRun(me, P, { intent: 'x', datasetVersionId: foreignVersion.id })), 'NOT_FOUND');
  planReply([
    { tool: 'inspectDataset', label: 'Inspect', input: { datasetVersionId: v2.id }, dependsOn: [] },
    { tool: 'createAnalysisSpec', label: 'Specify', input: { datasetVersionId: v2.id, spec: { analysisType: 'regression', outcome: 'y', predictors: ['x', 'm', 'bin'] } }, dependsOn: [] },
    { tool: 'runAnalysis', label: 'Run', input: { specId: { $step: 1, path: 'specId' } }, dependsOn: [1] },
    { tool: 'getAnalysisResult', label: 'Read', input: { runId: { $step: 2, path: 'runId' } }, dependsOn: [2] },
    { tool: 'createClaim', label: 'Claim', input: { runId: { $step: 2, path: 'runId' }, keys: ['coef:x'], text: 'X predicted Y ({{value:coef:x}}).' }, dependsOn: [2, 3] },
  ]);
  const created = await createRun(me, P, { intent: 'Does x predict y? Write the claim.', datasetVersionId: v2.id, idempotencyKey: `${RUN}-main` });
  const again = await createRun(me, P, { intent: 'Does x predict y? Write the claim.', datasetVersionId: v2.id, idempotencyKey: `${RUN}-main` });
  check('creating with the same idempotency key returns the same run', [again.run.id === created.run.id, again.created], [true, false]);
  const main = created.run.id;
  const parked = await drain(main);
  const view = await getRun(me, P, main);
  check('the run stops at the step that needs approval', [parked?.status, view.steps.map((step) => step.status)], ['WAITING_APPROVAL', ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'WAITING_APPROVAL']]);
  check('the plan was made through the Model Gateway and metered against the run', (await db.select().from(aiUsageEvents).where(and(eq(aiUsageEvents.runId, main), eq(aiUsageEvents.purpose, 'runs.plan')))).length, 1);
  const statRunId = (view.steps[2]!.outputRef as { id: string }).id;
  const [statRun] = await db.select().from(statRuns).where(eq(statRuns.id, statRunId));
  check('the analysis ran in the P1-C engine, keyed by the step', [statRun?.status, statRun?.idempotencyKey === view.steps[2]!.idempotencyKey, statRun?.engine], ['succeeded', true, 'academic-ai-ts-core']);
  check('a later step received the earlier output by reference', (view.steps[3]!.validatedInput as { runId: string }).runId, statRunId);
  check('each executed step records its policy decision, rule by rule', (view.steps[2]!.policy as { outcome: string; rules: unknown[] }).outcome === 'ALLOW' && (view.steps[2]!.policy as { rules: unknown[] }).rules.length === 10, true);
  const approval = view.approvals[0]!;
  check('the approval names exactly what will happen', [approval.status, approval.reason, (approval.action as { tool: string }).tool, /^[0-9a-f]{64}$/.test(approval.actionHash)], ['PENDING', 'manuscript_claim', 'createClaim', true]);
  check('no claim exists before approval', (await db.select().from(graphNodes).where(and(eq(graphNodes.projectId, P), eq(graphNodes.type, 'claim')))).length, 0);
  check('a forged approval (wrong hash) is refused', await outcome(() => decideApproval(me, P, main, approval.id, { decision: 'approve', actionHash: '0'.repeat(64) })), 'CONFLICT:action_hash_mismatch');
  check('a viewer cannot approve', await outcome(() => decideApproval({ userId: viewer }, P, main, approval.id, { decision: 'approve', actionHash: approval.actionHash })), 'FORBIDDEN');
  check('another editor cannot approve someone else’s run', await outcome(() => decideApproval({ userId: editor }, P, main, approval.id, { decision: 'approve', actionHash: approval.actionHash })), 'FORBIDDEN');
  check('a stranger cannot even see it', await outcome(() => decideApproval({ userId: stranger }, P, main, approval.id, { decision: 'approve', actionHash: approval.actionHash })), 'NOT_FOUND');
  check('the approval cannot be approved by editing the database as the restricted role of a viewer', (await asApp(viewer, (tx) => tx.update(runApprovals).set({ status: 'APPROVED', decidedBy: viewer, decidedAt: new Date() }).where(eq(runApprovals.id, approval.id)).returning({ id: runApprovals.id }))).length, 0);
  await decideApproval(me, P, main, approval.id, { decision: 'approve', actionHash: approval.actionHash });
  check('an approval cannot be decided twice', await outcome(() => decideApproval(me, P, main, approval.id, { decision: 'approve', actionHash: approval.actionHash })), 'CONFLICT:approval_not_pending');
  const done = await drain(main);
  const finalView = await getRun(me, P, main);
  check('after approval the run completes', [done?.status, done?.stopReason, finalView.steps.every((step) => step.status === 'SUCCEEDED')], ['SUCCEEDED', 'completed', true]);
  check('the approval was consumed (single use)', finalView.approvals[0]?.status, 'CONSUMED');
  const [claim] = await db.select().from(graphNodes).where(and(eq(graphNodes.projectId, P), eq(graphNodes.type, 'claim')));
  check('the claim is in the graph with the run and step as provenance', [claim?.origin, claim?.createdByRunId === main, claim?.createdByStepId === finalView.steps[4]!.id], ['agent', true, true]);
  check('its number was rendered from the stored estimate, not typed', String((claim?.data as { text?: string }).text ?? '').startsWith('X predicted Y (b = '), true);
  const types = new Set(finalView.events.map((event) => event.type));
  check('the run is diagnosable from its events', ['run.created', 'run.planned', 'step.validated', 'step.authorized', 'step.running', 'step.succeeded', 'approval.requested', 'approval.approved', 'approval.consumed', 'run.resumed', 'run.succeeded'].every((type) => types.has(type)), true);
  check('a completed step cannot be cancelled or re-run (trigger)', await refused(() => db.update(runSteps).set({ status: 'CANCELLED' }).where(eq(runSteps.id, finalView.steps[2]!.id))), true);
  check('a step cannot start without authorisation (trigger)', await refused(() => db.insert(runSteps).values({ runId: main, seq: 99, tool: 'runAnalysis', toolVersion: '1.0.0', label: 'x', input: {}, maxAttempts: 1, status: 'RUNNING' })), true);
  const tools = await listToolsFor({ userId: viewer }, P);
  check('a viewer is shown only the tools a viewer may use', tools.tools.every((tool) => tool.requiredRole === 'VIEWER'), true);

  /* ------------------------------------------------------------------ */
  section('Idempotency: retries never duplicate scientific records');
  const ctx = (stepId: string, key: string) => ({ userId: owner, projectId: P, tier: 'free' as const, execution: 'run' as const, runId: main, stepId, idempotencyKey: key, signal: new AbortController().signal });
  const specTool = toolByName('createAnalysisSpec')!;
  const specInput = { datasetVersionId: v2.id, spec: { analysisType: 'correlation', variables: ['x', 'y'] } };
  const specA = await specTool.execute(specInput, ctx('s-a', testKey('a')));
  const specB = await specTool.execute(specInput, ctx('s-a', testKey('a')));
  check('the same step key returns the same specification', (specA.output as { specId: string }).specId, (specB.output as { specId: string }).specId);
  check('… stored once', (await db.select().from(statSpecs).where(eq(statSpecs.idempotencyKey, testKey('a')))).length, 1);
  const runTool = toolByName('runAnalysis')!;
  const runA = await runTool.execute({ specId: (specA.output as { specId: string }).specId }, ctx('s-b', testKey('b')));
  const runB = await runTool.execute({ specId: (specA.output as { specId: string }).specId }, ctx('s-b', testKey('b')));
  check('the same step key returns the same statistics run (never run twice)', (runA.output as { runId: string }).runId, (runB.output as { runId: string }).runId);
  const versionTool = toolByName('createDatasetVersion')!;
  const versionInput = { datasetVersionId: v2.id, transformation: { operation: 'clean', actions: [{ kind: 'trim-whitespace', columns: ['group'] }] } };
  const verA = await versionTool.execute(versionInput, ctx('s-c', testKey('c')));
  const verB = await versionTool.execute(versionInput, ctx('s-c', testKey('c')));
  check('the same step key returns the same dataset version', (verA.output as { datasetVersionId: string }).datasetVersionId, (verB.output as { datasetVersionId: string }).datasetVersionId);
  const nodeTool = toolByName('createGraphNode')!;
  const nodeInput = { type: 'hypothesis', data: { statement: 'x predicts y', kind: 'direct', direction: 'positive' } };
  const nodeA = await nodeTool.execute(nodeInput, ctx(finalView.steps[0]!.id, testKey('d')));
  const nodeB = await nodeTool.execute(nodeInput, ctx(finalView.steps[0]!.id, testKey('d')));
  check('a step creates at most one graph node (the retry finds it)', [(nodeA.output as { nodeId: string }).nodeId === (nodeB.output as { nodeId: string }).nodeId, (nodeB.output as { created: boolean }).created], [true, false]);
  const claimTool = toolByName('createClaim')!;
  const claimAgain = await claimTool.execute({ runId: statRunId, keys: ['coef:x'] }, ctx(finalView.steps[4]!.id, finalView.steps[4]!.idempotencyKey!));
  check('re-executing the claim step returns the existing claim', [(claimAgain.output as { created: boolean }).created, (await db.select().from(graphNodes).where(and(eq(graphNodes.projectId, P), eq(graphNodes.type, 'claim')))).length], [false, 1]);

  /* A worker dies after the step's effect committed: the retry finds the effect. */
  planReply([{ tool: 'createGraphNode', label: 'Hypothesis', input: { type: 'hypothesis', data: { statement: 'm mediates x and y', kind: 'mediation', direction: 'positive' } }, dependsOn: [] }]);
  const crash = (await createRun(me, P, { intent: 'Record a hypothesis.' })).run.id;
  await store.transitionRun(owner, crash, ['QUEUED'], 'PLANNING', { startedAt: new Date() });
  const { planRun } = await import('@/server/runs/planner');
  const { limitsFor } = await import('@/server/runs/limits');
  const { runForUser } = await import('@/server/ai/request-scope');
  const planned = await runForUser(owner, () => planRun({ userId: owner, projectId: P, intent: 'Record a hypothesis.', context: {}, role: 'OWNER', tier: 'free', limits: limitsFor('free') }));
  if (!planned.ok) throw new Error('plan');
  await store.recordPlan(owner, crash, { summary: 'x' }, planned.plan.steps, planned.meta);
  const [crashStep] = await store.readSteps(owner, crash);
  const { inputHash, stepIdempotencyKey } = await import('@/server/runs/approvals');
  const hash = inputHash(crashStep!.input);
  const key = stepIdempotencyKey({ projectId: P, runId: crash, seq: 0, tool: 'createGraphNode', toolVersion: '1.0.0', inputHash: hash });
  await store.transitionStep(owner, crashStep!, ['QUEUED'], 'QUEUED', { validatedInput: crashStep!.input, inputHash: hash, idempotencyKey: key });
  await store.transitionStep(owner, crashStep!, ['QUEUED'], 'AUTHORIZED', { policy: { outcome: 'ALLOW' } });
  await store.transitionStep(owner, crashStep!, ['AUTHORIZED'], 'RUNNING', { claimToken: 'dead-worker', attempts: 1, startedAt: new Date() });
  await nodeTool.execute(crashStep!.input, ctx(crashStep!.id, key));
  const recovered = await drain(crash);
  const crashSteps = await store.readSteps(owner, crash);
  check('a run whose worker died mid-step recovers and completes', [recovered?.status, crashSteps[0]?.status, crashSteps[0]?.attempts], ['SUCCEEDED', 'SUCCEEDED', 2]);
  check('… and the step’s effect exists exactly once', (await db.select().from(graphNodes).where(eq(graphNodes.createdByStepId, crashStep!.id))).length, 1);

  /* ------------------------------------------------------------------ */
  section('Policy and limits stop runs, with the reason recorded');
  planReply([{ tool: 'runShellCommand', label: 'x', input: {}, dependsOn: [] }]);
  const invented = (await createRun(me, P, { intent: 'Use a tool that does not exist.' })).run.id;
  const inventedRun = await drain(invented);
  check('a plan naming an unregistered tool is refused (nothing runs)', [inventedRun?.status, inventedRun?.stopReason, (await store.readSteps(owner, invented)).length], ['FAILED', 'plan_invalid', 0]);
  planReply([{ tool: 'inspectDataset', label: 'x', input: { datasetVersionId: foreignVersion.id }, dependsOn: [] }]);
  const forged = (await createRun(me, P, { intent: 'Inspect their data.' })).run.id;
  const forgedRun = await drain(forged);
  const forgedSteps = await store.readSteps(owner, forged);
  check('a step naming another project’s dataset is denied by the policy (forged resource)', [forgedRun?.status, forgedRun?.stopReason, forgedSteps[0]?.status, (forgedSteps[0]?.policy as { reason?: string })?.reason], ['FAILED', 'policy_denied', 'SKIPPED', 'auth.resources']);
  planReply([{ tool: 'runAnalysis', label: 'x', input: { specId: 'x', extra: 'injected' }, dependsOn: [] }]);
  const injected = (await createRun(me, P, { intent: 'Inject a parameter.' })).run.id;
  const injectedRun = await drain(injected);
  check('an injected tool parameter fails validation before policy or execution', [injectedRun?.status, injectedRun?.stopReason, ((await store.readSteps(owner, injected))[0]?.error as { code?: string })?.code], ['FAILED', 'plan_invalid', 'invalid_input']);
  planReply(Array.from({ length: 11 }, () => ({ tool: 'listDatasets', label: 'x', input: {}, dependsOn: [] })));
  const tooLong = (await createRun(me, P, { intent: 'Do too much.' })).run.id;
  check('a plan longer than the tier allows is refused', [(await drain(tooLong))?.stopReason], ['plan_invalid']);
  check('a free user may have one active run at a time', await (async () => {
    planReply([{ tool: 'listDatasets', label: 'x', input: {}, dependsOn: [] }]);
    const first = (await createRun(me, P, { intent: 'first' })).run.id;
    const second = await outcome(() => createRun(me, P, { intent: 'second' }));
    await finish(first);
    return second;
  })(), 'VALIDATION:too_many_active_runs');
  process.env.RUN_LIMITS = JSON.stringify({ free: { maxRunTokens: 100 } });
  resetEnvCache();
  resetLimits();
  planReply([{ tool: 'listDatasets', label: 'x', input: {}, dependsOn: [] }]);
  const budget = (await createRun(me, P, { intent: 'Spend the budget.' })).run.id;
  const budgetRun = await drain(budget);
  check('a run past its metered token budget stops before the next step', [budgetRun?.status, budgetRun?.stopReason], ['FAILED', 'limit_tokens']);
  delete process.env.RUN_LIMITS;
  resetEnvCache();
  resetLimits();

  /* ------------------------------------------------------------------ */
  section('Cancellation is monotonic');
  const queued = (await createRun(me, P, { intent: 'Cancel me before planning.' })).run.id;
  const cancelled = await cancelRun(me, P, queued);
  check('a queued run is cancelled at once', [cancelled.status, cancelled.stopReason], ['CANCELLED', 'cancelled']);
  check('advancing a cancelled run does nothing', await advanceRun(queued), 'skipped');
  check('a viewer cannot cancel', await outcome(() => cancelRun({ userId: viewer }, P, main)), 'FORBIDDEN');
  const finished = await cancelRun(me, P, main);
  check('a finished run stays finished when "cancelled"', finished.status, 'SUCCEEDED');

  /* ------------------------------------------------------------------ */
  section('Approvals are bound to the exact action');
  const { version: v3 } = await transformVersion(me, v2.id, { operation: 'clean', actions: [{ kind: 'drop-rows-missing', columns: ['x'] }] }, P);
  await startRun(me, (await createSpec(me, { projectId: P, datasetVersionId: v2.id, spec: { analysisType: 'descriptives', variables: ['x'] } })).id, { projectId: P });
  planReply([{ tool: 'replaceDatasetVersion', label: 'Replace', input: { oldVersionId: v2.id, newVersionId: v3.id }, dependsOn: [] }]);
  const replace = (await createRun(me, P, { intent: 'Replace the data with the cleaned version.' })).run.id;
  await drain(replace);
  const first = (await getRun(me, P, replace)).approvals[0]!;
  check('replacing data always asks, with the Impact Report in the action', [first.reason, typeof (first.action as { impactHash?: string }).impactHash, ((first.action as { preview?: { items?: unknown[] } }).preview?.items ?? []).length > 0], ['replaces_data', 'string', true]);
  /* The impact changes after the request: another analysis now rests on the old data. */
  await startRun(me, (await createSpec(me, { projectId: P, datasetVersionId: v2.id, spec: { analysisType: 'descriptives', variables: ['y'] } })).id, { projectId: P });
  await decideApproval(me, P, replace, first.id, { decision: 'approve', actionHash: first.actionHash });
  await drain(replace);
  const afterChange = await getRun(me, P, replace);
  check('an approval of an action that has since changed is not used: a new one is asked', [afterChange.run.status, afterChange.approvals.map((a) => a.status)], ['WAITING_APPROVAL', ['EXPIRED', 'PENDING']]);
  check('… and nothing was replaced', (await db.select().from(graphNodes).where(and(eq(graphNodes.projectId, P), eq(graphNodes.type, 'dataset_version'), eq(graphNodes.status, 'superseded')))).length, 0);
  const second = afterChange.approvals[1]!;
  await decideApproval(me, P, replace, second.id, { decision: 'reject', actionHash: second.actionHash });
  const rejected = await store.readRun(owner, replace);
  check('a rejection ends the run with that reason', [rejected?.status, rejected?.stopReason], ['FAILED', 'approval_rejected']);
  /* A rejection whose settling stopped part-way (the approval is REJECTED, the run still waits) is finished by the executor. */
  planReply([{ tool: 'createClaim', label: 'Claim', input: { runId: statRunId, keys: ['coef:x'] }, dependsOn: [] }]);
  const halfRejected = (await createRun(me, P, { intent: 'Claim, then be rejected half-way.' })).run.id;
  await drain(halfRejected);
  const pendingClaim = (await getRun(me, P, halfRejected)).approvals[0]!;
  await store.decideApproval(owner, (await store.readApproval(owner, pendingClaim.id))!, 'REJECTED');
  await drain(halfRejected);
  const settledReject = await getRun(me, P, halfRejected);
  check('a rejected approval left half-settled still ends the run (never waits forever)', [settledReject.run.status, settledReject.run.stopReason, settledReject.steps[0]?.status], ['FAILED', 'approval_rejected', 'SKIPPED']);

  process.env.RUN_LIMITS = JSON.stringify({ free: { approvalTtlMs: 1 } });
  resetEnvCache();
  resetLimits();
  planReply([{ tool: 'createClaim', label: 'Claim', input: { runId: statRunId, keys: ['coef:x'] }, dependsOn: [] }]);
  const expiring = (await createRun(me, P, { intent: 'Claim, then wait too long.' })).run.id;
  await drain(expiring);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await reapRuns();
  const expired = await getRun(me, P, expiring);
  check('an approval left too long expires; the run stops with that reason', [expired.run.status, expired.run.stopReason, expired.approvals[0]?.status, expired.steps[0]?.status], ['FAILED', 'approval_expired', 'EXPIRED', 'SKIPPED']);
  delete process.env.RUN_LIMITS;
  resetEnvCache();
  resetLimits();

  /* ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ */
  section('WS1: waiting on an approval is not active time; authorise and claim are one transaction');
  const minutes = (n: number) => n * 60_000;
  /* Item 1: an approval decided after the free tier's 10 active minutes still runs, because the wait is not counted. */
  planReply([{ tool: 'createClaim', label: 'Claim', input: { runId: statRunId, keys: ['coef:x'] }, dependsOn: [] }]);
  const slow = (await createRun(me, P, { intent: 'Claim, approved after a long wait.' })).run.id;
  await drain(slow);
  const slowParked = await store.readRun(owner, slow);
  check('parking on an approval starts the approval clock', [slowParked?.status, typeof (slowParked?.spent as Record<string, number>).waitingSince], ['WAITING_APPROVAL', 'number']);
  await db
    .update(researchRuns)
    .set({ startedAt: new Date(Date.now() - minutes(11)), spent: sql`${researchRuns.spent} || jsonb_build_object('waitingSince', (extract(epoch from now()) * 1000)::bigint - ${minutes(11)})` })
    .where(eq(researchRuns.id, slow));
  const slowApproval = (await getRun(me, P, slow)).approvals[0]!;
  await decideApproval(me, P, slow, slowApproval.id, { decision: 'approve', actionHash: slowApproval.actionHash });
  const slowDone = await drain(slow);
  const slowSpent = slowDone?.spent as Record<string, number>;
  check('an approval decided after 11 minutes (free limit: 10 active) still runs the step', [slowDone?.status, slowDone?.stopReason], ['SUCCEEDED', 'completed']);
  check('… the wait is recorded and the clock is cleared on resume', [(slowSpent.waitedMs ?? 0) >= minutes(11), slowSpent.waitingSince === undefined], [true, true]);

  /* Item 1, negative: active time over the limit still stops the run. */
  planReply([{ tool: 'createGraphNode', label: 'Note', input: { type: 'note', data: { text: 'late' } }, dependsOn: [] }]);
  const late = (await createRun(me, P, { intent: 'Too slow while active.' })).run.id;
  await store.transitionRun(owner, late, ['QUEUED'], 'PLANNING', { startedAt: new Date(Date.now() - minutes(11)) });
  const latePlan = await runForUser(owner, () => planRun({ userId: owner, projectId: P, intent: 'Too slow while active.', context: {}, role: 'OWNER', tier: 'free', limits: limitsFor('free') }));
  if (!latePlan.ok) throw new Error('plan');
  await store.recordPlan(owner, late, { summary: 'x' }, latePlan.plan.steps, latePlan.meta);
  const lateDone = await drain(late);
  check('11 minutes of active time (free limit: 10) still stops the run with limit_time', [lateDone?.status, lateDone?.stopReason], ['FAILED', 'limit_time']);

  /* Item 3: the state an older runner could leave (approval consumed, step AUTHORIZED, never claimed) recovers. */
  planReply([{ tool: 'createClaim', label: 'Claim', input: { runId: statRunId, keys: ['coef:x'] }, dependsOn: [] }]);
  const halfClaimed = (await createRun(me, P, { intent: 'Claim; the runner dies after consuming the approval.' })).run.id;
  await drain(halfClaimed);
  const [hcStep] = await store.readSteps(owner, halfClaimed);
  const hcApproval = (await store.approvalsForStep(owner, hcStep!.id))[0]!;
  await store.decideApproval(owner, hcApproval, 'APPROVED');
  await store.transitionRun(owner, halfClaimed, ['WAITING_APPROVAL'], 'RUNNING', { wait: 'resume' });
  await withRunScope(owner, async (tx) => {
    await store.consumeApproval(owner, { ...hcApproval, status: 'APPROVED' }, hcApproval.actionHash, tx);
    await store.transitionStep(owner, hcStep!, ['WAITING_APPROVAL'], 'AUTHORIZED', { policy: { outcome: 'ALLOW' } }, { tx });
  });
  await drain(halfClaimed);
  const hcView = await getRun(me, P, halfClaimed);
  check('an authorised-but-unclaimed step whose approval was consumed asks again (not parked forever)', [hcView.run.status, hcView.steps[0]?.status, hcView.approvals.map((a) => a.status).sort()], ['WAITING_APPROVAL', 'WAITING_APPROVAL', ['CONSUMED', 'PENDING']]);
  check('… and says why it went back to the queue', hcView.events.some((event) => event.type === 'step.requeued'), true);
  const hcFresh = hcView.approvals.find((a) => a.status === 'PENDING')!;
  await decideApproval(me, P, halfClaimed, hcFresh.id, { decision: 'approve', actionHash: hcFresh.actionHash });
  const hcDone = await drain(halfClaimed);
  check('… approving again completes it, with the claim created once', [hcDone?.status, (await db.select().from(graphNodes).where(eq(graphNodes.createdByStepId, hcStep!.id))).length], ['SUCCEEDED', 1]);

  /* Item 3: an approval request that cannot park its step changes nothing (it used to park the run alone). */
  const [doneStep] = await store.readSteps(owner, main);
  const before = (await store.approvalsForStep(owner, doneStep!.id)).length;
  const refusedPark = await store.requestApproval(owner, doneStep!, { runId: main, stepId: doneStep!.id, projectId: P, actionHash: 'a'.repeat(64), reason: 'test', action: {}, expiresAt: new Date(Date.now() + minutes(5)) });
  check('an approval request for a step that cannot wait is rolled back entirely', [refusedPark, (await store.approvalsForStep(owner, doneStep!.id)).length - before, (await store.readRun(owner, main))?.status], [null, 0, 'SUCCEEDED']);

  /* Item 3: on the normal path, the approval's consumption and the claim commit together. */
  const approvedClaimSteps = (await getRun(me, P, slow)).events.filter((event) => ['approval.consumed', 'step.authorized', 'step.running'].includes(event.type)).map((event) => event.type);
  check('consume, authorise and claim are recorded together, in order', approvedClaimSteps, ['approval.consumed', 'step.authorized', 'step.running']);

  /* ------------------------------------------------------------------ */
  section('WS1: no run waits forever; RLS failure is recorded; claims are bounded');
  const parkOnClaim = async (intent: string) => {
    planReply([{ tool: 'createClaim', label: 'Claim', input: { runId: statRunId, keys: ['coef:x'] }, dependsOn: [] }]);
    const id = (await createRun(me, P, { intent })).run.id;
    await drain(id);
    const [waitingStep] = await store.readSteps(owner, id);
    const [openApproval] = await store.approvalsForStep(owner, waitingStep!.id);
    return { id, waitingStep: waitingStep!, openApproval: openApproval! };
  };
  /* The reaper considers a run only once it has been quiet (2 minutes) with no live lease. */
  const quiet = (id: string) => db.update(researchRuns).set({ updatedAt: sql`now() - interval '3 minutes'`, leaseOwner: null, leaseExpiresAt: null }).where(and(eq(researchRuns.id, id), sql`${researchRuns.status} not in ('SUCCEEDED', 'FAILED', 'CANCELLED')`)); /* a finished run is immutable (trigger) */
  const picked = async (id: string) => (await store.systemStrandedRuns(10_000)).some((run) => run.id === id);

  /* Item 2a: the reaper expired the approval, then died before stopping the run. */
  const e2 = await parkOnClaim('Expired, never settled.');
  check('claims are counted only while a run does not move (5 advances: 1 parked it, 4 found nothing to do)', (await store.readRun(owner, e2.id))?.attempts, 4);
  await store.expireApproval(owner, e2.openApproval, 'timed_out');
  await quiet(e2.id);
  check('an expired approval left unsettled: the reaper picks the run up', await picked(e2.id), true);
  const e2Done = await drain(e2.id);
  check('… and it ends with approval_expired (step skipped)', [e2Done?.status, e2Done?.stopReason, (await store.readSteps(owner, e2.id))[0]?.status], ['FAILED', 'approval_expired', 'SKIPPED']);
  await finish(e2.id);

  /* Item 2b: a rejection committed, then the process died before stopping the run. */
  const r2 = await parkOnClaim('Rejected, never settled.');
  await store.decideApproval(owner, r2.openApproval, 'REJECTED');
  await quiet(r2.id);
  check('a rejection left unsettled: the reaper picks the run up', await picked(r2.id), true);
  const r2Done = await drain(r2.id);
  check('… and it ends with approval_rejected', [r2Done?.status, r2Done?.stopReason], ['FAILED', 'approval_rejected']);
  await finish(r2.id);

  /* Item 2c: a cancellation recorded on a waiting run, but its settling failed part-way. */
  const c2 = await parkOnClaim('Cancelled, never settled.');
  await store.requestCancel(owner, c2.id, P);
  await quiet(c2.id);
  check('a cancellation left unsettled: the reaper picks the run up', await picked(c2.id), true);
  const c2Done = await drain(c2.id);
  check('… and it ends CANCELLED, its step cancelled and its approval expired', [c2Done?.status, (await store.readSteps(owner, c2.id))[0]?.status, (await store.approvalsForStep(owner, c2.waitingStep.id))[0]?.status], ['CANCELLED', 'CANCELLED', 'EXPIRED']);
  await finish(c2.id);

  /* Item 2d: approved, but the dispatch after the decision was lost. */
  const a2 = await parkOnClaim('Approved, never dispatched.');
  await store.decideApproval(owner, a2.openApproval, 'APPROVED');
  await quiet(a2.id);
  check('an approval that was never dispatched: the reaper picks the run up', await picked(a2.id), true);
  const a2Done = await drain(a2.id);
  check('… and the approved step runs to completion', [a2Done?.status, a2Done?.stopReason], ['SUCCEEDED', 'completed']);
  await finish(a2.id);

  /* Item 2e: the TTL is unchanged: a run waiting on a person, within the TTL, is left alone. */
  const w2 = await parkOnClaim('Waiting on a person.');
  await quiet(w2.id);
  check('a run waiting on an open request within its TTL is not picked up', await picked(w2.id), false);
  await drain(w2.id);
  check('… and advancing it keeps it waiting', [(await store.readRun(owner, w2.id))?.status, (await store.approvalsForStep(owner, w2.waitingStep.id))[0]?.status], ['WAITING_APPROVAL', 'PENDING']);
  await finish(w2.id);
  /* Past its TTL (without the reaper's own expiry sweep), advancing it settles it as expired. */
  process.env.RUN_LIMITS = JSON.stringify({ free: { approvalTtlMs: 1 } });
  resetEnvCache();
  resetLimits();
  planReply([{ tool: 'createClaim', label: 'Claim', input: { runId: statRunId, keys: ['coef:x'] }, dependsOn: [] }]);
  const t2Id = (await createRun(me, P, { intent: 'Waited past the TTL.' })).run.id;
  await advanceRun(t2Id); /* one advance: parked, not yet looked at again */
  const [t2Step] = await store.readSteps(owner, t2Id);
  const t2 = { id: t2Id, waitingStep: t2Step! };
  check('parked on a request with a 1 ms TTL', (await store.readRun(owner, t2Id))?.status, 'WAITING_APPROVAL');
  delete process.env.RUN_LIMITS;
  resetEnvCache();
  resetLimits();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await quiet(t2.id);
  check('once its request is past the TTL, the run is picked up', await picked(t2.id), true);
  const t2Done = await drain(t2.id);
  check('… and ends with approval_expired, its request expired', [t2Done?.status, t2Done?.stopReason, (await store.approvalsForStep(owner, t2.waitingStep.id))[0]?.status], ['FAILED', 'approval_expired', 'EXPIRED']);
  await finish(t2.id);

  /* Item 2f: parked with no waiting step (an older runner stopped part-way): resumed and re-decided. */
  const n2 = await parkOnClaim('Parked without its step.');
  await store.expireApproval(owner, n2.openApproval, 'test');
  await store.transitionStep(owner, n2.waitingStep, ['WAITING_APPROVAL'], 'QUEUED', {});
  await quiet(n2.id);
  check('a run parked without a waiting step: the reaper picks it up', await picked(n2.id), true);
  await drain(n2.id);
  const n2View = await getRun(me, P, n2.id);
  check('… it resumes and asks again properly (step and run both waiting, a fresh request)', [n2View.run.status, n2View.steps[0]?.status, n2View.approvals.filter((a) => a.status === 'PENDING').length], ['WAITING_APPROVAL', 'WAITING_APPROVAL', 1]);
  await finish(n2.id);
  check('the free user’s single active-run slot is free again after all of these', (await createRun(me, P, { intent: 'Slot check.' }).then(async ({ run }) => { await finish(run.id); return 'created'; }).catch((error: unknown) => (error instanceof AppError ? error.code : 'error'))), 'created');

  /* Item 4a: RLS can no longer be enforced for a queued run: it is stopped with that reason, once. */
  planReply([{ tool: 'listDatasets', label: 'List', input: {}, dependsOn: [] }]);
  const rlsRun = (await createRun(me, P, { intent: 'RLS breaks after creation.' })).run.id;
  await db.execute(sql`alter role academic_app bypassrls`);
  forgetRlsCheck();
  let rlsOutcome: string;
  try {
    rlsOutcome = await advanceRun(rlsRun);
  } catch (error) {
    rlsOutcome = `threw:${error instanceof AppError ? error.code : 'error'}`;
  }
  await db.execute(sql`alter role academic_app nobypassrls`);
  forgetRlsCheck();
  await assertRlsEnforced();
  const [rlsRow] = await db.select().from(researchRuns).where(eq(researchRuns.id, rlsRun));
  check('a run whose RLS cannot be enforced is not left QUEUED: FAILED with rls_unavailable', [rlsOutcome, rlsRow?.status, rlsRow?.stopReason], ['ran', 'FAILED', 'rls_unavailable']);
  check('… recorded as one run.failed event', (await db.select().from(runEvents).where(and(eq(runEvents.runId, rlsRun), eq(runEvents.type, 'run.failed')))).length, 1);
  check('… nothing executed (no step ran)', (await db.select().from(runSteps).where(eq(runSteps.runId, rlsRun))).length, 0);
  await quiet(rlsRun);
  check('… and it is never re-dispatched (no loop)', [await picked(rlsRun), await advanceRun(rlsRun), await advanceRun(rlsRun)], [false, 'skipped', 'skipped']);
  await finish(({ id: rlsRun }).id);

  /* Item 4b: picked up 20 times without moving: the 21st claim stops it as worker_lost. */
  planReply([{ tool: 'listDatasets', label: 'List', input: {}, dependsOn: [] }]);
  const loopRun = (await createRun(me, P, { intent: 'Never moves.' })).run.id;
  await db.update(researchRuns).set({ attempts: 20 }).where(eq(researchRuns.id, loopRun));
  const loopOutcome = await advanceRun(loopRun);
  const [loopRow] = await db.select().from(researchRuns).where(eq(researchRuns.id, loopRun));
  check('the 21st claim without progress stops the run as worker_lost', [loopOutcome, loopRow?.status, loopRow?.stopReason], ['ran', 'FAILED', 'worker_lost']);
  await quiet(loopRun);
  check('… and it is never re-dispatched', await picked(loopRun), false);
  await finish(({ id: loopRun }).id);
  check('a run that progresses is not stopped by the claim limit (claims reset on each state change)', a2Done?.attempts, 0);

  /* ------------------------------------------------------------------ */
  section('WS1: a replacement reports only its own effect, with its run and step; a lost lease stops a stale runner');
  /* The free test user has used this month's 20 model requests on earlier scenarios' plans: start this section with a fresh quota (test data only). */
  await db.delete(usageTracking).where(eq(usageTracking.userId, owner));
  const cleanOf = async (column: string) => (await transformVersion(me, v3.id, { operation: 'clean', actions: [{ kind: 'drop-rows-missing', columns: [column] }] }, P)).version;
  const replaceTool = toolByName('replaceDatasetVersion')!;
  const replaceCtx = async (oldId: string, newId: string, runId: string, stepId: string) => ({
    userId: owner,
    projectId: P,
    tier: 'free' as const,
    execution: 'run' as const,
    runId,
    stepId,
    idempotencyKey: testKey(`replace-${stepId}`),
    signal: new AbortController().signal,
    approvedImpactHash: (await previewVersionReplacement(me, P, oldId, newId)).hash,
  });

  /* Item 5: another actor replaced the version first: the tool must not report success. */
  const [vOld, vTheirs, vMine] = [await cleanOf('y'), await cleanOf('m'), await cleanOf('x')];
  await replaceVersion(me, P, vOld.id, vTheirs.id, (await previewVersionReplacement(me, P, vOld.id, vTheirs.id)).hash);
  const raceCtx = await replaceCtx(vOld.id, vMine.id, main, 'step-race');
  check('replacing a version someone else already replaced is a conflict, not a success', await outcome(() => replaceTool.execute({ oldVersionId: vOld.id, newVersionId: vMine.id }, raceCtx)), 'CONFLICT:already_replaced');
  check('… even for the same new version, when the replacement is not this step’s', await outcome(async () => replaceTool.execute({ oldVersionId: vOld.id, newVersionId: vTheirs.id }, { ...raceCtx, stepId: 'step-other' })), 'CONFLICT:already_replaced');
  check('… and the other actor’s replacement is left as it was', (await replacementOf(P, vOld.id))?.newVersionId, vTheirs.id);

  /* Item 5b + own effect: a replacement made by a run step records that run and step (origin agent). */
  const [vFrom, vTo] = [await cleanOf('bin'), await cleanOf('group')];
  planReply([{ tool: 'replaceDatasetVersion', label: 'Replace', input: { oldVersionId: vFrom.id, newVersionId: vTo.id }, dependsOn: [] }]);
  const replaceRun = (await createRun(me, P, { intent: 'Replace the data.' })).run.id;
  await drain(replaceRun);
  const replaceApproval = (await getRun(me, P, replaceRun)).approvals[0]!;
  await decideApproval(me, P, replaceRun, replaceApproval.id, { decision: 'approve', actionHash: replaceApproval.actionHash });
  const replaced = await drain(replaceRun);
  const [replaceStep] = await store.readSteps(owner, replaceRun);
  const recorded = await replacementOf(P, vFrom.id);
  check('an approved replacement run succeeds', [replaced?.status, replaceStep?.status, (replaceStep?.output as { output?: { replaced?: boolean } })?.output?.replaced], ['SUCCEEDED', 'SUCCEEDED', true]);
  check('… its supersedes edge records the executing run and step', [recorded?.newVersionId === vTo.id, recorded?.createdByRunId === replaceRun, recorded?.createdByStepId === replaceStep?.id], [true, true, true]);
  const [fromNode] = await db.select({ graphNodeId: datasetVersionsTable.graphNodeId }).from(datasetVersionsTable).where(eq(datasetVersionsTable.id, vFrom.id));
  const [edge] = await db.select().from(graphEdges).where(and(eq(graphEdges.dstId, fromNode!.graphNodeId!), eq(graphEdges.rel, 'supersedes')));
  check('… with origin agent (not user)', edge?.origin, 'agent');
  /* Already superseded: the graph refuses before it looks at the acknowledgement, so no impact hash is needed. */
  const replayCtx = (stepId: string) => ({ userId: owner, projectId: P, tier: 'free' as const, execution: 'run' as const, runId: replaceRun, stepId, idempotencyKey: testKey(`replay-${stepId}`), signal: new AbortController().signal, approvedImpactHash: null });
  const ownReplay = await replaceTool.execute({ oldVersionId: vFrom.id, newVersionId: vTo.id }, replayCtx(replaceStep!.id));
  check('re-executing the same step finds its own replacement (success, nothing new)', [(ownReplay.output as { replaced: boolean; affected: number }).replaced, (ownReplay.output as { affected: number }).affected], [true, 0]);
  check('… but another step replaying it gets a conflict', await outcome(async () => replaceTool.execute({ oldVersionId: vFrom.id, newVersionId: vTo.id }, replayCtx('step-impostor'))), 'CONFLICT:already_replaced');

  /* Item 6a: writes are fenced on the lease: a runner whose lease was taken cannot change the run. */
  const holder = (store as unknown as { asLeaseHolder?: <T>(runId: string, owner: string, work: () => Promise<T>) => Promise<T> }).asLeaseHolder ?? (<T>(_r: string, _o: string, work: () => Promise<T>) => work());
  planReply([{ tool: 'listDatasets', label: 'List', input: {}, dependsOn: [] }]);
  const fenced = (await createRun(me, P, { intent: 'Lease fencing.' })).run.id;
  await store.claimRunLease(owner, fenced, 'worker-A');
  await db.update(researchRuns).set({ leaseOwner: 'worker-B', leaseExpiresAt: sql`now() + interval '2 minutes'` }).where(eq(researchRuns.id, fenced));
  const staleMove = await holder(fenced, 'worker-A', () => store.transitionRun(owner, fenced, ['QUEUED'], 'PLANNING', { startedAt: new Date() }));
  await holder(fenced, 'worker-A', () => store.patchRun(owner, fenced, { spent: { steps: 99 } }));
  const afterStale = await store.readRun(owner, fenced);
  check('a stale runner (lease taken) cannot move the run', [staleMove, afterStale?.status], [false, 'QUEUED']);
  check('… nor change its counters', (afterStale?.spent as Record<string, number>).steps ?? null, null);
  check('… while the runner that holds the lease can', await holder(fenced, 'worker-B', () => store.transitionRun(owner, fenced, ['QUEUED'], 'PLANNING', { startedAt: new Date() })), true);
  await db.update(researchRuns).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(researchRuns.id, fenced));
  await finish(fenced);
  await drain(fenced); /* a PLANNING run's cancellation is settled by its next runner */
  check('… and the fenced run is then cancelled normally', (await store.readRun(owner, fenced))?.status, 'CANCELLED');

  /* Item 6b: the lease is taken while a step runs: the first runner stops, writes nothing, and does not displace the second. */
  const setHeartbeat = (executorModule as unknown as { setRunHeartbeatForTests?: (ms: number | null) => void }).setRunHeartbeatForTests ?? (() => undefined);
  setHeartbeat(150);
  planReply([{ tool: 'extractEvidence', label: 'Evidence', input: { question: 'What does the text say about x?', text: 'The study found that x predicts y in the survey data, with a modest effect.' }, dependsOn: [] }]);
  fake.push({ reply: { text: JSON.stringify({ evidence: [{ statement: 'x predicts y', quote: 'x predicts y' }] }) }, delayMs: 4_000 });
  const stolen = (await createRun(me, P, { intent: 'Lease stolen mid-step.' })).run.id;
  const firstRunner = advanceRun(stolen);
  let running = false;
  for (let i = 0; i < 60 && !running; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    running = (await store.readSteps(owner, stolen))[0]?.status === 'RUNNING';
  }
  await db.update(researchRuns).set({ leaseOwner: 'worker-B', leaseExpiresAt: sql`now() + interval '2 minutes'` }).where(eq(researchRuns.id, stolen));
  const startedWaiting = Date.now();
  const firstOutcome = await firstRunner;
  const stoppedAfter = Date.now() - startedWaiting;
  const [afterSteal] = await store.readSteps(owner, stolen);
  const [stolenRow] = await db.select().from(researchRuns).where(eq(researchRuns.id, stolen));
  check('the step was running when the lease was taken', running, true);
  check('the first runner stops soon after losing the lease (it does not wait for the tool)', [firstOutcome, stoppedAfter < 3_000], ['ran', true]);
  check('… it settles nothing: the step is still RUNNING, the run still RUNNING', [afterSteal?.status, stolenRow?.status], ['RUNNING', 'RUNNING']);
  check('… and it does not displace the runner that took over (the lease is still theirs)', stolenRow?.leaseOwner, 'worker-B');
  setHeartbeat(null);
  /* The second runner goes away too; the next one recovers the step (retried with the same key) and completes. */
  await db.update(researchRuns).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(researchRuns.id, stolen));
  fake.push({ reply: { text: JSON.stringify({ evidence: [{ statement: 'x predicts y', quote: 'x predicts y' }] }) } });
  const recoveredRun = await drain(stolen);
  await new Promise((resolve) => setTimeout(resolve, 4_500)); /* let the first runner's abandoned tool call finish: it must not write */
  check('a later runner completes it', recoveredRun?.status, 'SUCCEEDED');
  check('… with exactly one step.succeeded (the stale runner never settled it)', (await db.select().from(runEvents).where(and(eq(runEvents.runId, stolen), eq(runEvents.type, 'step.succeeded')))).length, 1);

  section('Flags');
  process.env.FF_RUNS = 'false';
  resetEnvCache();
  check('with FF_RUNS off the run API does not exist', await outcome(() => createRun(me, P, { intent: 'x' })), 'NOT_FOUND');
  process.env.FF_RUNS = 'true';
  process.env.JOB_RUNNER = 'direct';
  resetEnvCache();
  check('runs refuse to start without a queue (direct job mode)', await outcome(() => createRun(me, P, { intent: 'x' })), 'UNAVAILABLE:queue_required');
  process.env.JOB_RUNNER = 'inline';
  resetEnvCache();

  setGatewayForTests(null);
  forgetPlan();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
