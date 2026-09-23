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
import { aiUsageEvents, graphNodes, projectMembers, researchRuns, runApprovals, runEvents, runSteps, statRuns, statSpecs } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as projectsRepo from '@/server/repositories/projects.repository';
import { register } from '@/server/services/account.service';
import { saveUpload } from '@/server/services/dataset.service';
import { assertRlsEnforced, forgetRlsCheck, withRunScope } from '@/server/runs/db-scope';
import { advanceRun } from '@/server/runs/executor';
import { resetLimits } from '@/server/runs/limits';
import { toolByName } from '@/server/runs/registry';
import { cancelRun, createRun, decideApproval, getRun, listToolsFor, reapRuns } from '@/server/runs/service';
import * as store from '@/server/runs/store';
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
