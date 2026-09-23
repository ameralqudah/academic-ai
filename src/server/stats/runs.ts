/**
 * Specifications, runs and results (P1-C): the provenance layer.
 *
 *   createSpec  → an immutable, hashed specification pinned to a dataset version
 *   startRun    → a queued run (idempotent per spec + key), executed inline when
 *                 small or as a `stats.run` job on the existing queue otherwise
 *   executeRun  → loads the version (hashes re-checked), runs the engine, and
 *                 writes the outcome once: estimates, tables and figures in the
 *                 same transaction as the status change
 *   getRun / getProvenance → the result and exactly where every number came from
 *
 * Nothing here computes a statistic; `@/analysis/engine` does. Nothing here
 * lets a caller write a number: estimates come only from `execute()`.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { figuresFor } from '@/analysis/engine/figures';
import { execute } from '@/analysis/engine/run';
import { isRandomised, methodSpecSchema, type MethodSpec } from '@/analysis/engine/spec';
import { tablesFor } from '@/analysis/engine/tables';
import { ENGINE, type Issue } from '@/analysis/engine/types';
import { validateDataset, validateSpec } from '@/analysis/engine/validate';
import { logger } from '@/lib/logger';
import { db } from '@/server/db';
import { datasetVersions, graphNodes, statEstimates, statFigures, statRuns, statSpecs, statTables, type StatRun } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';

import { authorise, hashOf, sameProject, type StatsActor } from './access';
import { lineageOf, loadVersion, requireVersion } from './versions';

export const RUNTIME = `node ${process.version} ${process.platform}-${process.arch}`;
const TERMINAL = new Set(['succeeded', 'failed', 'refused', 'cancelled']);

/* -------------------------------------------------------------------------- */
/*                               Specifications                               */
/* -------------------------------------------------------------------------- */

/**
 * The seed a randomised specification gets when none was given: derived from
 * the specification and the data version, so it is fixed, recorded, and the
 * same request gets the same seed. Never `Math.random`.
 */
function assignedSeed(spec: Record<string, unknown>, versionHash: string): number {
  return (Number.parseInt(hashOf({ spec, versionHash }).slice(0, 8), 16) % 2_147_483_646) + 1;
}

function withSeed(input: Record<string, unknown>, versionHash: string): Record<string, unknown> {
  if (!isRandomised(input as never)) return input;
  const key = 'bootstrap';
  const bootstrap = (input[key] ?? {}) as Record<string, unknown>;
  if (bootstrap.seed !== undefined) return input;
  return { ...input, [key]: { ...bootstrap, seed: assignedSeed(input, versionHash) } };
}

export interface CreateSpecInput {
  projectId?: string | null;
  datasetVersionId: string;
  spec: unknown;
  label?: string | null;
  hypothesisIds?: string[];
  constructIds?: string[];
  origin?: 'user' | 'assistant';
}

export async function createSpec(actor: StatsActor, input: CreateSpecInput) {
  const version = await requireVersion(input.datasetVersionId, actor, 'EDITOR', input.projectId);
  const seeded = input.spec && typeof input.spec === 'object' ? withSeed(input.spec as Record<string, unknown>, version.contentHash) : input.spec;
  const parsed = methodSpecSchema.safeParse(seeded);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'The analysis specification is not valid.', 'مواصفة التحليل غير صالحة.', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  const spec = parsed.data;
  const hypothesisIds = input.hypothesisIds ?? [];
  const constructIds = input.constructIds ?? [];
  const linked = [...hypothesisIds, ...constructIds];
  if (linked.length) {
    /* Graph ids must belong to this project, and be of the right type: no cross-project references. */
    if (!version.projectId) throw new AppError('VALIDATION', 'Only a project analysis can test hypotheses.', 'فقط تحليلات المشروع يمكنها اختبار الفرضيات.');
    const nodes = await db.select({ id: graphNodes.id, type: graphNodes.type }).from(graphNodes).where(and(eq(graphNodes.projectId, version.projectId), inArray(graphNodes.id, linked)));
    const ok = (ids: string[], type: string) => ids.every((id) => nodes.some((node) => node.id === id && node.type === type));
    if (!ok(hypothesisIds, 'hypothesis') || !ok(constructIds, 'construct')) throw new AppError('NOT_FOUND', 'A linked hypothesis or construct was not found in this project.', 'لم يُعثر على فرضية أو متغير مرتبط في هذا المشروع.');
  }
  const [row] = await db
    .insert(statSpecs)
    .values({
      userId: actor.userId,
      projectId: version.projectId,
      datasetVersionId: version.id,
      analysisType: spec.analysisType,
      spec: spec as unknown as Record<string, unknown>,
      specHash: hashOf(spec),
      label: input.label?.slice(0, 200) ?? null,
      hypothesisIds,
      constructIds,
      origin: input.origin ?? 'user',
    })
    .returning();
  return row!;
}

export async function requireSpec(specId: string, actor: StatsActor, need: 'VIEWER' | 'EDITOR', projectId?: string | null) {
  const [row] = await db.select().from(statSpecs).where(eq(statSpecs.id, specId)).limit(1);
  await authorise(row, actor, need, 'analysis specification');
  sameProject(row!, projectId, 'analysis specification');
  return row!;
}

/** The pre-run check: dataset quality plus whether this specification can run on this version. */
export async function validateSpecRecord(actor: StatsActor, specId: string, projectId?: string | null): Promise<{ dataset: Issue[]; specification: Issue[]; runnable: boolean }> {
  const spec = await requireSpec(specId, actor, 'VIEWER', projectId);
  const [version] = await db.select().from(datasetVersions).where(eq(datasetVersions.id, spec.datasetVersionId)).limit(1);
  const data = await loadVersion(version!);
  const specification = validateSpec(spec.spec as unknown as MethodSpec, data);
  return { dataset: validateDataset(data), specification, runnable: !specification.some((issue) => issue.severity === 'ERROR' || issue.severity === 'BLOCKING') };
}

/* -------------------------------------------------------------------------- */
/*                                    Runs                                    */
/* -------------------------------------------------------------------------- */

export async function requireRun(runId: string, actor: StatsActor, need: 'VIEWER' | 'EDITOR', projectId?: string | null): Promise<StatRun> {
  const [row] = await db.select().from(statRuns).where(eq(statRuns.id, runId)).limit(1);
  await authorise(row, actor, need, 'analysis run');
  sameProject(row!, projectId, 'analysis run');
  return row!;
}

/** Rough work estimate: cells touched times resamples. Above the line, the run goes to the job queue. */
function cost(spec: MethodSpec, rows: number): number {
  const columns = JSON.stringify(spec).length / 20;
  const resamples = spec.analysisType === 'mediation' ? spec.bootstrap.resamples : spec.analysisType === 'pls' && spec.bootstrap ? spec.bootstrap.resamples * 10 : 1;
  const heavy = spec.analysisType === 'cfa' || spec.analysisType === 'efa' ? 50 : 1;
  return rows * columns * resamples * heavy;
}
export const INLINE_COST_LIMIT = 8_000_000;

export interface StartRunInput {
  projectId?: string | null;
  idempotencyKey?: string | null;
  supersedesRunId?: string | null;
  /** The Impact Report hash (from `previewReplacement`) the user confirmed for replacing that run. */
  impactAcknowledged?: string | null;
  execution?: 'auto' | 'inline' | 'job';
}

export async function startRun(actor: StatsActor, specId: string, input: StartRunInput = {}): Promise<StatRun> {
  const spec = await requireSpec(specId, actor, 'EDITOR', input.projectId);
  const [version] = await db.select().from(datasetVersions).where(eq(datasetVersions.id, spec.datasetVersionId)).limit(1);
  if (input.supersedesRunId) {
    const previous = await requireRun(input.supersedesRunId, actor, 'EDITOR', spec.projectId);
    if (previous.status !== 'succeeded') throw new AppError('CONFLICT', 'Only a succeeded run can be superseded.', 'يمكن استبدال تشغيل ناجح فقط.');
    /*
     * Replacing a recorded run invalidates what reported it. The Impact Report is
     * checked before anything is computed, so the user confirms first and a run
     * never exists that the graph then refuses to record.
     */
    if (previous.graphRunNodeId && spec.projectId) {
      const { previewRerun } = await import('@/server/graph/service');
      const report = await previewRerun(spec.projectId, { userId: actor.userId }, previous.graphRunNodeId);
      if (report.requiresAcknowledgement && input.impactAcknowledged !== report.hash) {
        throw new AppError('IMPACT_ACK_REQUIRED', 'Replacing this run affects other parts of the research. Review the Impact Report, then confirm.', 'استبدال هذا التشغيل يؤثّر في أجزاء أخرى من البحث. راجع تقرير الأثر ثم أكّد.', { report });
      }
    }
  }
  const key = input.idempotencyKey?.slice(0, 200) ?? null;
  if (key) {
    const [existing] = await db.select().from(statRuns).where(and(eq(statRuns.specId, specId), eq(statRuns.idempotencyKey, key))).limit(1);
    if (existing) return existing;
  }
  let run: StatRun;
  try {
    [run] = (await db
      .insert(statRuns)
      .values({
        specId,
        userId: actor.userId,
        projectId: spec.projectId,
        datasetVersionId: spec.datasetVersionId,
        datasetContentHash: version!.contentHash,
        specHash: spec.specHash,
        analysisType: spec.analysisType,
        engine: ENGINE.id,
        engineVersion: ENGINE.version,
        runtime: RUNTIME,
        status: 'queued',
        supersedesRunId: input.supersedesRunId ?? null,
        impactAcknowledged: input.impactAcknowledged?.slice(0, 128) ?? null,
        idempotencyKey: key,
      })
      .returning()) as [StatRun];
  } catch (error) {
    if (key) {
      const [existing] = await db.select().from(statRuns).where(and(eq(statRuns.specId, specId), eq(statRuns.idempotencyKey, key))).limit(1);
      if (existing) return existing;
    }
    throw error;
  }

  const execution = input.execution ?? 'auto';
  const heavy = cost(spec.spec as unknown as MethodSpec, version!.rowCount) > INLINE_COST_LIMIT;
  if (execution === 'job' || (execution === 'auto' && heavy)) {
    const jobs = await import('@/server/repositories/analysis-jobs.repository');
    const job = await jobs.create({ userId: actor.userId, datasetId: version!.datasetId, projectId: spec.projectId, kind: 'stats.run', status: 'QUEUED', spec: { runId: run.id } });
    await db.update(statRuns).set({ jobId: job.id }).where(eq(statRuns.id, run.id));
    const { dispatchAnalysisJob } = await import('@/server/jobs/dispatch');
    await dispatchAnalysisJob(job.id, 'stats.run');
    return { ...run, jobId: job.id };
  }
  await executeRun(run.id);
  return (await db.select().from(statRuns).where(eq(statRuns.id, run.id)).limit(1))[0]!;
}

/**
 * Executes a queued run. Idempotent: a run that is not queued is left alone,
 * except that a job holding the row's lease may re-take a run whose previous
 * worker died mid-way (nothing of its result was written: results and the
 * status change commit together or not at all).
 */
export async function executeRun(runId: string, options: { reclaim?: boolean } = {}): Promise<StatRun['status']> {
  const claimable = options.reclaim ? ['queued', 'running'] : ['queued'];
  const [claimed] = await db
    .update(statRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(statRuns.id, runId), inArray(statRuns.status, claimable)))
    .returning();
  if (!claimed) {
    const [current] = await db.select({ status: statRuns.status }).from(statRuns).where(eq(statRuns.id, runId)).limit(1);
    return (current?.status ?? 'failed') as StatRun['status'];
  }

  const [spec] = await db.select().from(statSpecs).where(eq(statSpecs.id, claimed.specId)).limit(1);
  const [version] = await db.select().from(datasetVersions).where(eq(datasetVersions.id, claimed.datasetVersionId)).limit(1);

  const finish = async (values: Partial<typeof statRuns.$inferInsert>) => {
    const rows = await db
      .update(statRuns)
      .set({ ...values, finishedAt: new Date() })
      .where(and(eq(statRuns.id, runId), eq(statRuns.status, 'running')))
      .returning({ status: statRuns.status });
    return rows[0]?.status;
  };

  let outcome: ReturnType<typeof execute>;
  try {
    if (version!.contentHash !== claimed.datasetContentHash) throw new AppError('CONFLICT', 'The dataset version does not match the run record.', 'إصدار البيانات لا يطابق سجل التشغيل.');
    const data = await loadVersion(version!);
    outcome = execute(spec!.spec, data);
  } catch (error) {
    const reason = error instanceof AppError ? ((error.details as { reason?: string } | undefined)?.reason ?? error.code) : 'engine-error';
    logger.error('stats.run.failed', { runId, reason, error: error instanceof Error ? error.message : String(error) });
    await finish({ status: 'failed', error: { code: reason, message: error instanceof Error ? error.message.slice(0, 500) : 'failed' } });
    return 'failed';
  }

  if (outcome.status === 'refused') {
    await finish({ status: 'refused', issues: outcome.issues as unknown as Record<string, unknown>[] });
    return 'refused';
  }
  if (outcome.status === 'failed') {
    await finish({ status: 'failed', issues: outcome.issues as unknown as Record<string, unknown>[], error: outcome.error });
    return 'failed';
  }

  const result = outcome.result;
  const tables = tablesFor(result);
  const figures = figuresFor(result);
  try {
    await db.transaction(async (tx) => {
      if (result.estimates.length) {
        await tx.insert(statEstimates).values(
          result.estimates.map((e) => ({
            runId,
            key: e.key.slice(0, 300),
            label: e.label.slice(0, 400),
            family: e.family,
            term: e.term?.slice(0, 300) ?? null,
            stat: e.stat,
            estimate: e.estimate,
            se: e.se ?? null,
            statistic: e.statistic ?? null,
            statisticName: e.statisticName ?? null,
            df: e.df ?? null,
            df2: e.df2 ?? null,
            p: e.p ?? null,
            ciLow: e.ciLow ?? null,
            ciHigh: e.ciHigh ?? null,
            ciLevel: e.ciLevel ?? null,
            ciMethod: e.ciMethod ?? null,
            n: e.n ?? null,
          })),
        );
      }
      if (tables.length) await tx.insert(statTables).values(tables.map((t, position) => ({ runId, position, kind: t.kind, title: t.title, content: t as unknown as Record<string, unknown>, keys: t.keys })));
      if (figures.length) await tx.insert(statFigures).values(figures.map((f, position) => ({ runId, position, kind: f.kind, title: f.title, svg: f.svg, keys: f.keys })));
      const updated = await tx
        .update(statRuns)
        .set({
          status: 'succeeded',
          method: result.method,
          seed: result.seed,
          parameters: result.parameters,
          missingStrategy: result.sample.missingStrategy,
          nSupplied: result.sample.supplied,
          nUsed: result.sample.used,
          nExcluded: result.sample.excluded,
          issues: result.issues as unknown as Record<string, unknown>[],
          assumptions: result.assumptions as unknown as Record<string, unknown>[],
          payload: result.payload,
          resultHash: hashOf(result),
          finishedAt: new Date(),
        })
        .where(and(eq(statRuns.id, runId), eq(statRuns.status, 'running')))
        .returning({ id: statRuns.id });
      /* Cancelled while computing: nothing is kept. */
      if (updated.length === 0) throw new RunCancelled();
    });
  } catch (error) {
    if (error instanceof RunCancelled) return 'cancelled';
    throw error;
  }

  if (claimed.projectId) {
    try {
      const { recordRunInGraph } = await import('./graph');
      await recordRunInGraph(runId);
    } catch (error) {
      /* The run and its results stand; the graph record can be retried (`recordRunInGraph` is idempotent). */
      logger.error('stats.graph.recordFailed', { runId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return 'succeeded';
}

class RunCancelled extends Error {}

export async function cancelRun(actor: StatsActor, runId: string, projectId?: string | null): Promise<boolean> {
  const run = await requireRun(runId, actor, 'EDITOR', projectId);
  if (TERMINAL.has(run.status)) return false;
  const rows = await db
    .update(statRuns)
    .set({ status: 'cancelled', finishedAt: new Date(), error: { code: 'cancelled', message: 'Cancelled by the user.' } })
    .where(and(eq(statRuns.id, runId), inArray(statRuns.status, ['queued', 'running'])))
    .returning({ id: statRuns.id });
  if (rows.length && run.jobId) {
    const jobs = await import('@/server/repositories/analysis-jobs.repository');
    await jobs.cancel(run.jobId, run.userId).catch(() => false);
  }
  return rows.length > 0;
}

/** A job of kind `stats.run`, run by a worker under the job's lease. */
export async function runStatsJob(jobId: string): Promise<void> {
  const jobs = await import('@/server/repositories/analysis-jobs.repository');
  const job = await jobs.findOwnedAny(jobId);
  if (!job || job.status !== 'QUEUED') return;
  if (!(await jobs.markRunning(jobId))) return;
  const started = Date.now();
  const runId = String((job.spec as { runId?: string }).runId ?? '');
  try {
    const status = await executeRun(runId, { reclaim: true });
    if (status === 'succeeded') await jobs.complete(jobId, { runId, status }, Date.now() - started);
    else await jobs.fail(jobId, `stats.run.${status}`, Date.now() - started);
  } catch (error) {
    logger.error('stats.job.crashed', { jobId, runId, error: String(error) });
    await jobs.fail(jobId, 'analysis.job.error.failed', Date.now() - started);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Reading                                  */
/* -------------------------------------------------------------------------- */

export async function getRun(actor: StatsActor, runId: string, projectId?: string | null) {
  const run = await requireRun(runId, actor, 'VIEWER', projectId);
  const [spec] = await db.select().from(statSpecs).where(eq(statSpecs.id, run.specId)).limit(1);
  const estimates = await db.select().from(statEstimates).where(eq(statEstimates.runId, runId));
  const tables = await db.select().from(statTables).where(eq(statTables.runId, runId)).orderBy(asc(statTables.position));
  const figures = await db.select().from(statFigures).where(eq(statFigures.runId, runId)).orderBy(asc(statFigures.position));
  const [superseded] = await db.select({ id: statRuns.id }).from(statRuns).where(and(eq(statRuns.supersedesRunId, runId), eq(statRuns.status, 'succeeded'))).limit(1);
  return { run, spec: spec!, estimates, tables, figures, supersededBy: superseded?.id ?? null, verified: run.status === 'succeeded' && !superseded };
}

export async function listRuns(actor: StatsActor, projectId: string) {
  const { requireProjectRole } = await import('@/server/graph/service');
  await requireProjectRole(projectId, actor.userId, 'VIEWER');
  return db.select().from(statRuns).where(eq(statRuns.projectId, projectId)).orderBy(desc(statRuns.queuedAt)).limit(100);
}

/**
 * "Where did this number come from?" — the full chain for a run: the engine
 * and its version, the specification (and its hash), the dataset version (and
 * its hashes), every transformation back to the uploaded file, the seed, and
 * the Research Graph ids that record it.
 */
export async function getProvenance(actor: StatsActor, runId: string, projectId?: string | null) {
  const { run, spec, estimates, supersededBy } = await getRun(actor, runId, projectId);
  const lineage = await lineageOf(run.datasetVersionId);
  return {
    run: {
      id: run.id,
      status: run.status,
      engine: run.engine,
      engineVersion: run.engineVersion,
      runtime: run.runtime,
      method: run.method,
      seed: run.seed,
      parameters: run.parameters,
      missingStrategy: run.missingStrategy,
      sample: { supplied: run.nSupplied, used: run.nUsed, excluded: run.nExcluded },
      resultHash: run.resultHash,
      queuedAt: run.queuedAt,
      finishedAt: run.finishedAt,
      supersedes: run.supersedesRunId,
      supersededBy,
      graphRunNodeId: run.graphRunNodeId,
    },
    specification: { id: spec.id, hash: spec.specHash, origin: spec.origin, spec: spec.spec, hypothesisIds: spec.hypothesisIds, graphNodeId: spec.graphNodeId },
    dataset: lineage.map(({ version, transformation }) => ({
      versionId: version.id,
      versionNo: version.versionNo,
      contentHash: version.contentHash,
      schemaHash: version.schemaHash,
      fileChecksum: version.fileChecksum,
      rows: version.rowCount,
      columns: version.columnCount,
      graphNodeId: version.graphNodeId,
      transformation: transformation ? { id: transformation.id, operation: transformation.operation, parameters: transformation.parameters, report: transformation.report, engineVersion: transformation.engineVersion, at: transformation.createdAt } : null,
    })),
    estimates: estimates.map((e) => ({ key: e.key, graphNodeId: e.graphNodeId })),
    reproducible: { from: ['dataset version content hash', 'specification hash', 'engine version', 'seed'], resultHash: run.resultHash },
  };
}
