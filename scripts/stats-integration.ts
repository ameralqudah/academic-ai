/**
 * The P1-C statistics chain against PostgreSQL, end to end:
 *
 *   upload → dataset version → transformation → specification → engine run
 *   → estimates / tables / figures → Research Graph → manuscript claim
 *
 * plus immutability (database triggers), idempotency, jobs, cancellation,
 * staleness on re-runs and replaced data, reproducibility, authorisation and
 * the LLM tool boundary (scripted provider, no network).
 *
 *   DATABASE_URL=…/academic_ai_test npm run db:migrate && npm run db:seed
 *   DATABASE_URL=…/academic_ai_test npm run test:stats:db
 */

import 'dotenv/config';

import { readFileSync } from 'node:fs';

import { and, eq, sql } from 'drizzle-orm';

import { execute } from '@/analysis/engine/run';
import { canonicalJson } from '@/analysis/engine/types';
import { resetEnvCache } from '@/config/env';
import { productionDeps, setGatewayForTests } from '@/server/ai/gateway';
import { FakeAdapter } from '@/server/ai/gateway/adapters/fake';
import { createGateway } from '@/server/ai/gateway/gateway';
import { runForUser } from '@/server/ai/request-scope';
import { db } from '@/server/db';
import { aiToolCalls, analysisJobs, datasetTransformations, datasetVersions, graphEdges, graphNodes, projectMembers, statEstimates, statRuns, statSpecs, statTables } from '@/server/db/schema';
import * as graph from '@/server/graph/service';
import { AppError } from '@/server/http/errors';
import * as projectsRepo from '@/server/repositories/projects.repository';
import { register } from '@/server/services/account.service';
import * as conversationsRepo from '@/server/repositories/conversations.repository';
import * as jobsRepo from '@/server/repositories/analysis-jobs.repository';
import { saveCleanedCopy, saveUpload } from '@/server/services/dataset.service';
import { runAnalysis } from '@/server/services/statistics.service';
import { hashOf } from '@/server/stats/access';
import { previewReplacement, recordRunInGraph, replaceVersion } from '@/server/stats/graph';
import { insertClaim, untracedStatistics } from '@/server/stats/manuscript';
import { cancelRun, createSpec, executeRun, getProvenance, getRun, startRun, validateSpecRecord } from '@/server/stats/runs';
import { executeStatsTool, explainRun, runAssistant, STATS_TOOL_NAMES } from '@/server/stats/tools';
import { listVersions, loadVersion, qualityReport, transformVersion } from '@/server/stats/versions';

const RUN = `st-${Date.now()}`;
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
    if (error instanceof AppError) return error.code;
    return `db:${String((error as { cause?: { message?: string } }).cause?.message ?? error).slice(0, 80)}`;
  }
}
/** Whether PostgreSQL itself refused the statement (not the service). */
async function databaseRefuses(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return false;
  } catch (error) {
    return !(error instanceof AppError);
  }
}
const section = (title: string) => console.log(`\n${title}`);

async function main() {
  process.env.FF_GRAPH = 'true';
  process.env.JOB_RUNNER = 'direct';
  resetEnvCache();

  const user = async (name: string) => (await register({ name, email: `${RUN}-${name}@example.test`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123', locale: 'en' })).id;
  const owner = await user('owner');
  const viewer = await user('viewer');
  const stranger = await user('stranger');
  const me = { userId: owner };
  const project = await projectsRepo.create({ userId: owner, title: 'Stats', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  const other = await projectsRepo.create({ userId: stranger, title: 'Theirs', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  await db.insert(projectMembers).values({ projectId: project.id, userId: viewer, role: 'VIEWER' }).onConflictDoNothing();
  const P = project.id;

  const csv = readFileSync('evals/fixtures/datasets/engine_survey.csv');
  const upload = await saveUpload({ userId: owner, projectId: P, file: { name: 'survey.csv', bytes: csv.buffer.slice(csv.byteOffset, csv.byteOffset + csv.byteLength) as ArrayBuffer } });
  const datasetId = upload.dataset.id;

  /* ------------------------------------------------------------------ */
  section('Dataset versions');
  const { versions, transformations } = await listVersions(me, datasetId, P);
  const v1 = versions[0]!;
  check('the upload has version 1, pinned to the stored file', [versions.length, v1.versionNo, v1.storageKey === upload.dataset.storageKey, v1.fileChecksum === upload.dataset.checksum], [1, 1, true, true]);
  check('version 1 comes from a recorded import', [transformations[0]?.operation, transformations[0]?.outputVersionId === v1.id, (transformations[0]?.report as { rows?: number }).rows], ['import', true, 240]);
  const loaded = await loadVersion(v1);
  check('loading re-checks the content hash (and returns every row, no 5,000-row window)', [loaded.rows.length, hashOf({ columns: loaded.columns.map((c) => c.name), rows: loaded.rows }) === v1.contentHash], [240, true]);
  const again = await listVersions(me, datasetId, P);
  check('asking again does not create another version', again.versions.length, 1);
  const quality = await qualityReport(me, v1.id, P);
  check('the quality report counts missing values, never zero-fills them', quality.issues.some((i) => i.code === 'missing-values' && i.columns[0] === 'x' && i.details?.missing === 3), true);

  check('a version cannot be edited in the database', await databaseRefuses(() => db.update(datasetVersions).set({ contentHash: 'x'.repeat(64) }).where(eq(datasetVersions.id, v1.id))), true);
  check('… nor deleted', await databaseRefuses(() => db.delete(datasetVersions).where(eq(datasetVersions.id, v1.id))), true);
  check('… nor its import record changed', await databaseRefuses(() => db.update(datasetTransformations).set({ report: {} }).where(eq(datasetTransformations.outputVersionId, v1.id))), true);

  const items = ['T1', 'T2', 'T3', 'T4', 'S1', 'S2', 'S3', 'S4'];
  const { version: v2 } = await transformVersion(me, v1.id, {
    operation: 'set-schema',
    columns: [...items.map((name) => ({ name, type: 'ordinal' as const, scaleMin: 1, scaleMax: 5 })), { name: 'group', type: 'nominal' as const }, { name: 'bin', type: 'binary' as const }],
  }, P);
  check('declaring types is a new version: same cells, new schema', [v2.versionNo, v2.contentHash === v1.contentHash, v2.schemaHash !== v1.schemaHash, v2.parentVersionId === v1.id], [2, true, true, true]);
  const { version: v3, report: cleanReport } = await transformVersion(me, v2.id, { operation: 'clean', actions: [{ kind: 'drop-rows-missing', columns: ['x'] }] }, P);
  check('deleting rows is a recorded transformation that makes a new version', [v3.versionNo, v3.rowCount, (cleanReport as { rowsRemoved?: number }).rowsRemoved, v3.storageKey !== v2.storageKey], [3, 237, 3, true]);
  check('the input version is untouched and still loads', (await loadVersion(v1)).rows.length, 240);
  check('a transformation naming an unknown column is refused', await outcome(() => transformVersion(me, v2.id, { operation: 'clean', actions: [{ kind: 'impute-mean', columns: ['nope'] }] }, P)), 'VALIDATION');
  check('a stranger cannot see the versions', await outcome(() => listVersions({ userId: stranger }, datasetId, P)), 'NOT_FOUND');
  check('a viewer cannot transform', await outcome(() => transformVersion({ userId: viewer }, v2.id, { operation: 'set-schema', columns: [{ name: 'x', type: 'numeric' }] }, P)), 'FORBIDDEN');

  /* ------------------------------------------------------------------ */
  section('Specifications and runs');
  const hypothesis = await graph.createNode(P, me, { type: 'hypothesis', data: { statement: 'x predicts y', kind: 'direct', direction: 'positive' }, status: 'active' });
  const regressionSpec = await createSpec(me, { projectId: P, datasetVersionId: v2.id, spec: { analysisType: 'regression', outcome: 'y', predictors: ['x', 'm', 'bin'] }, label: 'H1 regression', hypothesisIds: [hypothesis.id] });
  check('a specification is stored parsed and hashed', [regressionSpec.analysisType, regressionSpec.specHash === hashOf(regressionSpec.spec), (regressionSpec.spec as { confidenceLevel?: number }).confidenceLevel], ['regression', true, 0.95]);
  check('a specification cannot be edited', await databaseRefuses(() => db.update(statSpecs).set({ spec: {} }).where(eq(statSpecs.id, regressionSpec.id))), true);
  const check1 = await validateSpecRecord(me, regressionSpec.id, P);
  check('validation reports issues without running', check1.runnable, true);

  const run = await startRun(me, regressionSpec.id, { projectId: P, idempotencyKey: 'first' });
  check('a small run executes inline and succeeds', run.status, 'succeeded');
  check('the run is pinned: version, content hash, engine, runtime', [run.datasetVersionId === v2.id, run.datasetContentHash === v2.contentHash, run.engine, run.engineVersion, run.runtime.startsWith('node ')], [true, true, 'academic-ai-ts-core', '1.0.0', true]);
  const same = await startRun(me, regressionSpec.id, { projectId: P, idempotencyKey: 'first' });
  check('the same idempotency key returns the same run (never run twice)', same.id, run.id);
  const detail = await getRun(me, run.id, P);
  const direct = execute(regressionSpec.spec, await loadVersion(v2));
  const directResult = direct.status === 'succeeded' ? direct.result : null;
  const stored = detail.estimates.find((e) => e.key === 'coef:x');
  check('stored estimates are exactly the engine’s', [stored?.estimate === directResult?.estimates.find((e) => e.key === 'coef:x')?.estimate, detail.estimates.length === directResult?.estimates.length], [true, true]);
  check('the result hash reproduces from (version, specification, engine)', run.resultHash === hashOf(directResult), true);
  check('tables and figures were generated from the estimates', [detail.tables.length > 0, detail.figures.some((f) => f.kind === 'coefficient-plot'), (detail.tables[0]!.keys as string[]).every((k) => detail.estimates.some((e) => e.key === k))], [true, true, true]);

  const rerun = await startRun(me, regressionSpec.id, { projectId: P });
  check('re-running the same specification on the same version gives the identical result hash', rerun.resultHash, run.resultHash);

  /* ------------------------------------------------------------------ */
  section('Results are immutable, and cannot be injected');
  check('an estimate cannot be edited', await databaseRefuses(() => db.update(statEstimates).set({ estimate: 42 }).where(eq(statEstimates.id, stored!.id))), true);
  check('an estimate cannot be added to a finished run (no manual injection)', await databaseRefuses(() => db.insert(statEstimates).values({ runId: run.id, key: 'fake', label: 'fake', family: 'coefficient', stat: 'b', estimate: 0.99 })), true);
  check('a table cannot be edited', await databaseRefuses(() => db.update(statTables).set({ title: 'x' }).where(eq(statTables.runId, run.id))), true);
  check('a finished run cannot be edited', await databaseRefuses(() => db.update(statRuns).set({ resultHash: 'x' }).where(eq(statRuns.id, run.id))), true);
  check('… nor sent back to running', await databaseRefuses(() => db.update(statRuns).set({ status: 'running' }).where(eq(statRuns.id, run.id))), true);
  check('… nor deleted', await databaseRefuses(() => db.delete(statRuns).where(eq(statRuns.id, run.id))), true);
  const phantomSpec = await createSpec(me, { projectId: P, datasetVersionId: v2.id, spec: { analysisType: 'descriptives', variables: ['x'] } });
  check('a run cannot be created already succeeded', await databaseRefuses(async () => {
    await db.insert(statRuns).values({ specId: phantomSpec.id, userId: owner, projectId: P, datasetVersionId: v2.id, datasetContentHash: v2.contentHash, specHash: phantomSpec.specHash, analysisType: 'descriptives', engine: 'x', engineVersion: '1', runtime: 'x', status: 'queued' });
    await db.update(statRuns).set({ status: 'succeeded', resultHash: 'x', finishedAt: new Date() }).where(and(eq(statRuns.specId, phantomSpec.id), eq(statRuns.status, 'queued')));
  }), true);

  /* ------------------------------------------------------------------ */
  section('Research Graph');
  const [runNode] = await db.select().from(graphNodes).where(eq(graphNodes.id, run.graphRunNodeId ?? ''));
  check('the run is recorded in the graph as computed, with its reproducibility record', [runNode?.type, runNode?.provenance, (runNode?.data as { legacyRunId?: string }).legacyRunId === run.id, (runNode?.data as { resultHash?: string }).resultHash === run.resultHash], ['analysis_run', 'computed', true, true]);
  check('recording again is a no-op (idempotent)', await recordRunInGraph(run.id), run.graphRunNodeId);
  const valueNode = detail.estimates.find((e) => e.key === 'coef:x')!.graphNodeId!;
  const [value] = await db.select().from(graphNodes).where(eq(graphNodes.id, valueNode));
  check('each estimate is a computed result_value with its key and inference', [value?.type, value?.provenance, (value?.data as { key?: string }).key, typeof (value?.data as { se?: number }).se], ['result_value', 'computed', 'coef:x', 'number']);
  const tests = await db.select().from(graphEdges).where(and(eq(graphEdges.srcId, valueNode), eq(graphEdges.rel, 'tests')));
  check('the primary estimate tests the linked hypothesis', tests[0]?.dstId, hypothesis.id);
  const up = await graph.trace(P, me, valueNode, 'up');
  const upNodes = new Map(up.nodes.map((n: { id: string; type: string; data: unknown }) => [n.id, n]));
  const versionNode = [...upNodes.values()].find((n) => n.type === 'dataset_version');
  check('"where did this number come from?": value → run → dataset version (with its content hash) and analysis', [Boolean(versionNode), (versionNode?.data as { contentHash?: string })?.contentHash === v2.contentHash, [...upNodes.values()].some((n) => n.type === 'analysis')], [true, true, true]);
  const [vNode] = await db.select().from(datasetVersions).where(eq(datasetVersions.id, v2.id));
  const derived = await db.select().from(graphEdges).where(and(eq(graphEdges.srcId, vNode!.graphNodeId!), eq(graphEdges.rel, 'derived_from')));
  check('the version node records the version it derives from', derived.length, 1);
  check('a graph result cannot be edited by hand', await outcome(() => graph.updateNode(P, me, valueNode, { data: { stat: 'b', value: 1 }, expectedVersion: 1 })), 'CONFLICT');
  const provenance = await getProvenance(me, run.id, P);
  check('the provenance chain reaches the upload', [provenance.dataset.map((d) => d.transformation?.operation), provenance.run.seed, provenance.specification.hash === regressionSpec.specHash], [['import', 'set-schema'], null, true]);

  /* ------------------------------------------------------------------ */
  section('Manuscript');
  const claim = await insertClaim(me, P, run.id, { keys: ['coef:x'], text: 'X predicted Y ({{value:coef:x}}).' });
  check('a claim is written from the stored estimate, never retyped', [claim.text.startsWith('X predicted Y (b = '), claim.text.includes('p ')], [true, true]);
  const reports = await db.select().from(graphEdges).where(and(eq(graphEdges.srcId, claim.claim.id), eq(graphEdges.rel, 'reports')));
  check('the claim reports the value in the graph', reports[0]?.dstId, valueNode);
  check('a typed number is refused', await outcome(() => insertClaim(me, P, run.id, { keys: ['coef:x'], text: 'X predicted Y (b = 0.31, p < .001).' })), 'VALIDATION');
  check('the untraced-statistics detector catches typed statistics', untracedStatistics('as shown, r = .45 and 12.5% of cases').length > 0, true);
  check('… and accepts tokens', untracedStatistics('as shown by {{value:coef:x}}').length, 0);
  check('the claim is current while its run is', (await graph.assess(P, me, claim.claim.id)).effective, 'current');

  /* ------------------------------------------------------------------ */
  section('Replacing a run: the old result stays; what cited it becomes stale');
  check('replacing a cited run without acknowledging the impact is refused before computing', await outcome(() => startRun(me, regressionSpec.id, { projectId: P, supersedesRunId: run.id })), 'IMPACT_ACK_REQUIRED');
  const preview = await previewReplacement(me, run.id, P);
  const replacement = await startRun(me, regressionSpec.id, { projectId: P, supersedesRunId: run.id, impactAcknowledged: preview?.hash });
  check('with the Impact Report acknowledged, the new run replaces the old', [replacement.status, Boolean(replacement.graphRunNodeId)], ['succeeded', true]);
  const [oldRunNode] = await db.select().from(graphNodes).where(eq(graphNodes.id, run.graphRunNodeId!));
  check('the old run is superseded in the graph, not deleted or changed', [oldRunNode?.status, oldRunNode?.provenance], ['superseded', 'computed']);
  check('the old result is still there, unchanged', (await getRun(me, run.id, P)).estimates.find((e) => e.key === 'coef:x')?.estimate, stored?.estimate);
  check('the old run is no longer "verified" (it has been replaced)', (await getRun(me, run.id, P)).verified, false);
  check('the claim citing the old run is no longer current', (await graph.assess(P, me, claim.claim.id)).effective !== 'current', true);
  check('citing the replaced run is refused', await outcome(() => insertClaim(me, P, run.id, { keys: ['coef:x'] })), 'CONFLICT');

  /* ------------------------------------------------------------------ */
  section('Replacing the data: every run on the old version becomes stale');
  const freshClaim = await insertClaim(me, P, replacement.id, { keys: ['coef:x'] });
  check('replacing a version with dependents needs the Impact Report acknowledged', await outcome(() => replaceVersion(me, P, v2.id, v3.id)), 'IMPACT_ACK_REQUIRED');
  let report: graph.ImpactReport | null = null;
  try {
    await replaceVersion(me, P, v2.id, v3.id);
  } catch (error) {
    report = (error as AppError & { details: { report: graph.ImpactReport } }).details.report;
  }
  await replaceVersion(me, P, v2.id, v3.id, report?.hash);
  check('after the data is replaced, a claim on a run over the old data is not current', (await graph.assess(P, me, freshClaim.claim.id)).effective !== 'current', true);
  const onNewData = await createSpec(me, { projectId: P, datasetVersionId: v3.id, spec: { analysisType: 'regression', outcome: 'y', predictors: ['x', 'm', 'bin'] } });
  const rerunNew = await startRun(me, onNewData.id, { projectId: P });
  check('a run on the new version is current evidence', [rerunNew.status, rerunNew.datasetVersionId === v3.id], ['succeeded', true]);

  /* ------------------------------------------------------------------ */
  section('Guardrails, jobs and cancellation');
  const constant = await createSpec(me, { projectId: P, datasetVersionId: v3.id, spec: { analysisType: 'cfa', constructs: [{ name: 'T', indicators: ['T1', 'T2'] }] } });
  const tiny = await transformVersion(me, v3.id, { operation: 'clean', actions: [{ kind: 'drop-rows-missing', columns: ['score'] }] }, P);
  check('a transformation chain can continue', tiny.version.versionNo, 4);
  const refused = await startRun(me, constant.id, { projectId: P });
  const refusedDetail = await getRun(me, refused.id, P);
  check('an under-identified CFA is refused with an ERROR, before any number is computed', [refused.status, (refused.issues as { code: string }[]).some((i) => i.code === 'under-identified')], ['refused', true]);
  check('a refused run has no estimates, tables or figures', [refusedDetail.estimates.length, refusedDetail.tables.length, refusedDetail.figures.length, refused.resultHash], [0, 0, 0, null]);
  const mediationSpec = await createSpec(me, { projectId: P, datasetVersionId: v3.id, spec: { analysisType: 'mediation', x: 'x', m: 'm', y: 'y', bootstrap: { resamples: 1000 } } });
  const seed = (mediationSpec.spec as { bootstrap: { seed: number } }).bootstrap.seed;
  const mediationAgain = await createSpec(me, { projectId: P, datasetVersionId: v3.id, spec: { analysisType: 'mediation', x: 'x', m: 'm', y: 'y', bootstrap: { resamples: 1000 } } });
  check('a randomised specification without a seed gets a recorded, deterministic one', [Number.isInteger(seed) && seed > 0, (mediationAgain.spec as { bootstrap: { seed: number } }).bootstrap.seed === seed], [true, true]);
  const queued = await startRun(me, mediationSpec.id, { projectId: P, execution: 'job' });
  let final = queued.status;
  for (let i = 0; i < 100 && !['succeeded', 'failed', 'refused', 'cancelled'].includes(final); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    final = (await db.select({ status: statRuns.status }).from(statRuns).where(eq(statRuns.id, queued.id)))[0]!.status;
  }
  const [job] = await db.select().from(analysisJobs).where(eq(analysisJobs.id, queued.jobId ?? ''));
  check('a heavy run goes through the existing job queue and completes', [Boolean(queued.jobId), final, job?.kind, job?.status], [true, 'succeeded', 'stats.run', 'COMPLETED']);
  const done = await getRun(me, queued.id, P);
  check('the seed is on the run record', done.run.seed, seed);
  const [cancelMe] = await db.insert(statRuns).values({ specId: mediationSpec.id, userId: owner, projectId: P, datasetVersionId: v3.id, datasetContentHash: v3.contentHash, specHash: mediationSpec.specHash, analysisType: 'mediation', engine: 'academic-ai-ts-core', engineVersion: '1.0.0', runtime: 'test', status: 'queued' }).returning();
  check('a queued run can be cancelled', await cancelRun(me, cancelMe!.id, P), true);
  check('a cancelled run never executes', [await executeRun(cancelMe!.id), (await getRun(me, cancelMe!.id, P)).estimates.length], ['cancelled', 0]);

  /* ------------------------------------------------------------------ */
  section('Authorisation and isolation');
  check('a stranger cannot read a run', await outcome(() => getRun({ userId: stranger }, run.id, P)), 'NOT_FOUND');
  check('… or its provenance', await outcome(() => getProvenance({ userId: stranger }, run.id)), 'NOT_FOUND');
  check('a viewer can read', await outcome(() => getRun({ userId: viewer }, run.id, P)), 'ok');
  check('a viewer cannot run', await outcome(() => startRun({ userId: viewer }, regressionSpec.id, { projectId: P })), 'FORBIDDEN');
  check('a run cannot be read through another project', await outcome(() => getRun(me, run.id, other.id)), 'NOT_FOUND');
  const foreignHypothesis = await graph.createNode(other.id, { userId: stranger }, { type: 'hypothesis', data: { statement: 'theirs', kind: 'direct', direction: 'positive' } });
  check('a specification cannot test another project’s hypothesis', await outcome(() => createSpec(me, { projectId: P, datasetVersionId: v3.id, spec: { analysisType: 'descriptives', variables: ['x'] }, hypothesisIds: [foreignHypothesis.id] })), 'NOT_FOUND');
  check('a stranger cannot create a specification on this data', await outcome(() => createSpec({ userId: stranger }, { projectId: other.id, datasetVersionId: v3.id, spec: { analysisType: 'descriptives', variables: ['x'] } })), 'NOT_FOUND');

  /* ------------------------------------------------------------------ */
  section('LLM tool boundary (scripted provider)');
  check('the tools can propose, validate, run and read — none can write a number', STATS_TOOL_NAMES, ['createAnalysisSpec', 'validateAnalysisSpec', 'runAnalysis', 'getAnalysisResult', 'getAnalysisProvenance', 'generateTableFromResult', 'generateFigureFromResult']);
  check('no tool name even suggests writing results', STATS_TOOL_NAMES.some((name) => /write|update|overwrite|fake|set|edit|insert|delete/i.test(name)), false);
  check('an unknown tool is refused', await outcome(() => executeStatsTool(me, P, 'updateResultNumbers', {})), 'FORBIDDEN');

  const fake = new FakeAdapter('openai');
  setGatewayForTests(createGateway({ ...productionDeps, adapters: () => ({ openai: fake }), models: async () => ({ configured: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai', siblings: {} }) }));
  fake.push(
    { reply: { toolCalls: [{ id: 'c1', name: 'createAnalysisSpec', arguments: { datasetVersionId: v3.id, label: 'assistant', spec: { analysisType: 'correlation', variables: ['x', 'y'] } } }], finishReason: 'tool_calls' } },
    { reply: { text: 'The correlation is r = 0.52, p < .001.' } },
  );
  const assisted = await runForUser(owner, () => runAssistant(me, P, v3.id, 'Is x related to y?'));
  check('the model proposed a specification through the tool; the server validated it', [assisted.steps[0]?.tool, assisted.steps[0]?.ok, (assisted.steps[0]?.summary as { runnable?: boolean }).runnable], ['createAnalysisSpec', true, true]);
  const [proposed] = await db.select().from(statSpecs).where(eq(statSpecs.id, String((assisted.steps[0]?.summary as { specId?: string }).specId)));
  check('an assistant specification is marked as such', proposed?.origin, 'assistant');
  check('the model’s own typed numbers are withheld, not shown', [assisted.text, assisted.withheld?.reason], [null, 'untraced_statistics']);
  const toolRows = await db.select().from(aiToolCalls).where(eq(aiToolCalls.userId, owner));
  check('the tool call is recorded durably, with its outcome', toolRows.some((row) => row.toolName === 'createAnalysisSpec' && row.status === 'succeeded'), true);

  fake.push({ reply: { text: 'Higher x goes with higher y ({{value:coef:x}}).' } });
  const explained = await runForUser(owner, () => explainRun(me, P, rerunNew.id));
  check('an explanation uses tokens; the numbers are rendered from the stored estimates', [explained.text.startsWith('Higher x goes with higher y (b = '), explained.keys], [true, ['coef:x']]);
  fake.push({ reply: { text: 'The effect is b = 0.25.' } }, { reply: { text: 'Still b = 0.25.' } });
  check('an explanation that keeps typing numbers is refused', await runForUser(owner, () => outcome(() => explainRun(me, P, rerunNew.id))), 'CONFLICT');
  setGatewayForTests(null);

  /* ------------------------------------------------------------------ */
  section('Legacy paths: ownership, pinning, counts, cleaning, job races');
  const bytes = (text: string) => { const b = Buffer.from(text); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
  check('an upload cannot be filed under someone else’s project', await outcome(() => saveUpload({ userId: owner, projectId: other.id, file: { name: 'a.csv', bytes: bytes('a\n1\n2\n') } })), 'NOT_FOUND');
  const theirConversation = await conversationsRepo.findOrCreate({ userId: stranger, projectId: null, scope: 'TOOL', toolKey: 'rewriter' as never });
  check('… nor into someone else’s conversation', await outcome(() => saveUpload({ userId: owner, conversationId: theirConversation.id, file: { name: 'a.csv', bytes: bytes('a\n1\n2\n') } })), 'NOT_FOUND');
  const ragged = await saveUpload({ userId: owner, projectId: P, file: { name: 'r.csv', bytes: bytes('a,b\n1,2\n3,4,EXTRA\nNA,5\n6,7\n') } });
  const [raggedV1] = await db.select().from(datasetVersions).where(eq(datasetVersions.datasetId, ragged.dataset.id));
  const [raggedImport] = await db.select().from(datasetTransformations).where(eq(datasetTransformations.outputVersionId, raggedV1?.id ?? ''));
  check('an upload gets version 1 at once, recording rows with extra fields and cells read as missing', [(raggedImport?.report as { rowsWithExtraFields?: number }).rowsWithExtraFields, (raggedImport?.report as { cellsReadAsMissing?: Record<string, number> }).cellsReadAsMissing?.NA], [1, 1]);
  check('a legacy analysis cannot be filed under someone else’s project', await outcome(() => runAnalysis({ datasetId, userId: owner, test: 't.oneSample', columns: { dependent: 'x' }, projectId: other.id })), 'NOT_FOUND');
  const legacy = await runAnalysis({ datasetId, userId: owner, test: 't.oneSample', columns: { dependent: 'x' }, options: { mu: 50 } });
  const legacyResult = legacy.result as { rowsSupplied: number; rowsDropped: number; n: number };
  check('a legacy run is pinned to the dataset version, its content hash and the engine version', [legacy.run.datasetVersionId === v1.id, legacy.run.datasetContentHash === v1.contentHash, legacy.run.engineVersion], [true, true, '1.0.0']);
  check('rows the service drops before the test are counted (was always 0)', [legacyResult.rowsSupplied, legacyResult.rowsDropped, legacyResult.n], [240, 3, 237]);
  const cleanedCopy = await saveCleanedCopy({ datasetId, userId: owner, actions: [{ kind: 'drop-rows-missing', columns: ['m'], reasonKey: 'x', recommended: true, destructive: true }] });
  const [copyV1] = await db.select().from(datasetVersions).where(eq(datasetVersions.datasetId, cleanedCopy.dataset.id));
  const [copyTransformation] = await db.select().from(datasetTransformations).where(eq(datasetTransformations.outputVersionId, copyV1?.id ?? ''));
  check('a legacy cleaned copy records its actions as a clean transformation from the parent’s version', [copyTransformation?.operation, copyTransformation?.inputVersionId === v1.id, JSON.stringify(copyTransformation?.parameters).includes('drop-rows-missing')], ['clean', true, true]);
  const [raceJob] = await db.insert(analysisJobs).values({ userId: owner, kind: 'pls.bootstrap', status: 'QUEUED', spec: {} }).returning();
  await jobsRepo.markRunning(raceJob!.id);
  await jobsRepo.cancel(raceJob!.id, owner);
  const completed = await jobsRepo.complete(raceJob!.id, { late: true }, 10);
  const [afterRace] = await db.select({ status: analysisJobs.status }).from(analysisJobs).where(eq(analysisJobs.id, raceJob!.id));
  check('a job finishing after it was cancelled cannot overwrite the cancel', [completed, afterRace?.status], [false, 'CANCELLED']);
  check('a cancelled job cannot be claimed again', await jobsRepo.markRunning(raceJob!.id), false);

  /* ------------------------------------------------------------------ */
  section('Reproducibility');
  const reproduced = execute(proposed!.spec, await loadVersion((await db.select().from(datasetVersions).where(eq(datasetVersions.id, proposed!.datasetVersionId)))[0]!));
  const proposedRun = await startRun(me, proposed!.id, { projectId: P });
  check('(version, specification, engine version, seed) → the same result hash, outside the service', proposedRun.resultHash === hashOf(reproduced.status === 'succeeded' ? reproduced.result : null), true);
  check('canonical serialisation is stable', canonicalJson({ b: [1, 2], a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1},"b":[1,2]}');

  await db.execute(sql`select 1`);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
