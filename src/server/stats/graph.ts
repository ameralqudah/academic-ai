/**
 * Recording statistics in the Research Graph (P1-C).
 *
 *   dataset_version ─derived_from→ dataset_version        (one node per version)
 *   analysis ─specifies→ hypothesis                        (one node per specification)
 *   analysis_run ─executes→ analysis, ─uses_data→ dataset_version   (via recordRun)
 *   result_value / result_table / figure ─produced_by→ analysis_run
 *   result_table / figure ─contains_value→ result_value
 *   result_value ─tests→ hypothesis
 *
 * Written only through `recordRun` with an engine actor, so results are
 * `computed` and immutable in the graph as well. Idempotent: a run already
 * recorded is not recorded again. Behind `FF_GRAPH`: with the flag off the
 * relational record stands alone and can be recorded later.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { logger } from '@/lib/logger';
import { db } from '@/server/db';
import { datasets, datasetVersions, statEstimates, statFigures, statRuns, statSpecs, statTables, type StatEstimate } from '@/server/db/schema';
import { graphEnabled } from '@/server/graph/access';
import * as graph from '@/server/graph/service';
import { AppError } from '@/server/http/errors';

import { requireRun } from './runs';
import type { StatsActor } from './access';

type EngineActor = graph.Actor & { origin: 'engine' };

/** Results that decide a hypothesis the specification names. Everything else is recorded but tests nothing. */
const PRIMARY: Record<string, (e: StatEstimate) => boolean> = {
  regression: (e) => e.family === 'coefficient' && e.stat === 'b' && e.term !== '(intercept)',
  correlation: (e) => e.family === 'correlation',
  anova: (e) => e.key === 'anova:F' || e.key === 'anova:welch_F',
  mediation: (e) => e.key === 'effect:indirect',
  moderation: (e) => e.key === 'coef:interaction',
  pls: (e) => e.family === 'path',
};

/** Up to this many values per run become graph nodes; tables and figures still reference theirs. */
const MAX_VALUE_NODES = 600;

async function lockAnd<T>(key: string, work: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    return work();
  });
}

/** The dataset_version node for a version (and, first, for its parent chain). */
export async function ensureVersionNode(versionId: string, actor: EngineActor, projectId: string): Promise<string> {
  const [version] = await db.select().from(datasetVersions).where(eq(datasetVersions.id, versionId)).limit(1);
  if (!version) throw new AppError('NOT_FOUND', 'The dataset version was not found.', 'لم يُعثر على الإصدار.');
  if (version.graphNodeId) return version.graphNodeId;
  if (version.projectId !== projectId) throw new AppError('NOT_FOUND', 'The dataset version was not found.', 'لم يُعثر على الإصدار.');
  const parentNode = version.parentVersionId ? await ensureVersionNode(version.parentVersionId, actor, projectId) : null;
  const [dataset] = version.datasetId ? await db.select({ name: datasets.originalName }).from(datasets).where(eq(datasets.id, version.datasetId)).limit(1) : [];
  return lockAnd(`graph-version:${versionId}`, async () => {
    const [fresh] = await db.select({ graphNodeId: datasetVersions.graphNodeId }).from(datasetVersions).where(eq(datasetVersions.id, versionId)).limit(1);
    if (fresh?.graphNodeId) return fresh.graphNodeId;
    const node = await graph.createNode(projectId, actor, {
      type: 'dataset_version',
      label: `${dataset?.name ?? 'Dataset'} · v${version.versionNo}`.slice(0, 200),
      data: {
        version: version.versionNo,
        contentHash: version.contentHash,
        rows: version.rowCount,
        datasetVersionId: version.id,
        schemaHash: version.schemaHash,
        fileChecksum: version.fileChecksum,
      },
      status: 'active',
    });
    if (parentNode) await graph.link(projectId, actor, { srcId: node.id, rel: 'derived_from', dstId: parentNode });
    await db.update(datasetVersions).set({ graphNodeId: node.id }).where(and(eq(datasetVersions.id, versionId), isNull(datasetVersions.graphNodeId)));
    return node.id;
  });
}

/** The analysis node for a specification, linked to the hypotheses it tests. */
export async function ensureSpecNode(specId: string, actor: EngineActor, projectId: string): Promise<string> {
  const [spec] = await db.select().from(statSpecs).where(eq(statSpecs.id, specId)).limit(1);
  if (!spec) throw new AppError('NOT_FOUND', 'The specification was not found.', 'لم يُعثر على المواصفة.');
  if (spec.graphNodeId) return spec.graphNodeId;
  return lockAnd(`graph-spec:${specId}`, async () => {
    const [fresh] = await db.select({ graphNodeId: statSpecs.graphNodeId }).from(statSpecs).where(eq(statSpecs.id, specId)).limit(1);
    if (fresh?.graphNodeId) return fresh.graphNodeId;
    const node = await graph.createNode(projectId, actor, {
      type: 'analysis',
      label: (spec.label ?? spec.analysisType).slice(0, 200),
      data: { name: (spec.label ?? spec.analysisType).slice(0, 200), method: spec.analysisType, spec: { ...spec.spec, specHash: spec.specHash, statSpecId: spec.id } },
      status: 'active',
    });
    for (const hypothesisId of spec.hypothesisIds) await graph.link(projectId, actor, { srcId: node.id, rel: 'specifies', dstId: hypothesisId });
    await db.update(statSpecs).set({ graphNodeId: node.id }).where(and(eq(statSpecs.id, specId), isNull(statSpecs.graphNodeId)));
    return node.id;
  });
}

/**
 * Records a succeeded run in the graph. Idempotent (the relational run keeps
 * its graph node id, and `recordRun` itself refuses to record an engine run
 * twice). Returns null when the graph is off or the run has no project.
 */
export async function recordRunInGraph(runId: string): Promise<string | null> {
  const [run] = await db.select().from(statRuns).where(eq(statRuns.id, runId)).limit(1);
  if (!run || run.status !== 'succeeded' || !run.projectId) return null;
  if (run.graphRunNodeId) return run.graphRunNodeId;
  if (!graphEnabled()) return null;

  const projectId = run.projectId;
  const actor: EngineActor = { userId: run.userId, origin: 'engine', runId: run.id };
  const versionNode = await ensureVersionNode(run.datasetVersionId, actor, projectId);
  const analysisNode = await ensureSpecNode(run.specId, actor, projectId);
  const [spec] = await db.select().from(statSpecs).where(eq(statSpecs.id, run.specId)).limit(1);

  let previousNode: string | undefined;
  if (run.supersedesRunId) {
    const [previous] = await db.select({ graphRunNodeId: statRuns.graphRunNodeId }).from(statRuns).where(eq(statRuns.id, run.supersedesRunId)).limit(1);
    previousNode = previous?.graphRunNodeId ?? undefined;
  }

  const estimates = await db.select().from(statEstimates).where(eq(statEstimates.runId, runId));
  const tables = await db.select().from(statTables).where(eq(statTables.runId, runId));
  const figures = await db.select().from(statFigures).where(eq(statFigures.runId, runId));
  const primary = PRIMARY[run.analysisType];
  const kept = estimates.slice(0, MAX_VALUE_NODES);
  const keptKeys = new Set(kept.map((e) => e.key));
  const finite = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? undefined : value);

  const results: graph.RecordRunInput['results'] = kept.map((e) => ({
    key: e.key,
    type: 'result_value' as const,
    label: e.label.slice(0, 200),
    data: {
      stat: e.stat.slice(0, 40),
      value: e.estimate,
      key: e.key,
      estimateId: e.id,
      ...(finite(e.df) !== undefined ? { df: [e.df as number, ...(finite(e.df2) !== undefined ? [e.df2 as number] : [])] } : {}),
      ...(finite(e.p) !== undefined ? { p: Math.min(1, Math.max(0, e.p as number)) } : {}),
      ...(finite(e.ciLow) !== undefined && finite(e.ciHigh) !== undefined ? { ci: [e.ciLow as number, e.ciHigh as number] as [number, number] } : {}),
      ...(finite(e.se) !== undefined ? { se: e.se as number } : {}),
      ...(finite(e.statistic) !== undefined ? { statistic: e.statistic as number, statisticName: e.statisticName ?? undefined } : {}),
      ...(e.n !== null ? { n: e.n } : {}),
      ...(finite(e.ciLevel) !== undefined ? { ciLevel: e.ciLevel as number, ciMethod: e.ciMethod ?? undefined } : {}),
    },
    ...(spec && spec.hypothesisIds.length && primary?.(e) ? { tests: spec.hypothesisIds } : {}),
  }));
  tables.forEach((table) =>
    results.push({ key: `table:${table.position}`, type: 'result_table', label: table.title.slice(0, 200), data: { key: `table:${table.position}`, title: table.title, kind: table.kind, tableId: table.id, keys: table.keys }, showsValues: table.keys.filter((key) => keptKeys.has(key)) }),
  );
  figures.forEach((figure) =>
    results.push({ key: `figure:${figure.position}`, type: 'figure', label: figure.title.slice(0, 200), data: { key: `figure:${figure.position}`, title: figure.title, kind: figure.kind, figureId: figure.id, keys: figure.keys }, showsValues: figure.keys.filter((key) => keptKeys.has(key)) }),
  );

  const recorded = await graph.recordRun(projectId, actor, {
    analysisId: analysisNode,
    datasetVersionIds: [versionNode],
    label: `${spec?.label ?? run.analysisType} · ${run.id.slice(0, 8)}`,
    run: {
      engine: run.engine,
      engineVersion: run.engineVersion,
      status: 'succeeded',
      ...(run.seed !== null ? { seed: run.seed } : {}),
      legacyRunId: run.id,
      method: run.method ?? undefined,
      runtime: run.runtime,
      specHash: run.specHash,
      resultHash: run.resultHash ?? undefined,
      datasetContentHash: run.datasetContentHash,
    },
    results,
    ...(previousNode ? { supersedesRunId: previousNode, impactAcknowledged: run.impactAcknowledged ?? undefined } : {}),
  });

  /* Fill in the graph ids, once. */
  await db.transaction(async (tx) => {
    await tx.update(statRuns).set({ graphRunNodeId: recorded.run.id }).where(and(eq(statRuns.id, runId), isNull(statRuns.graphRunNodeId)));
    for (const e of kept) {
      const node = recorded.outputs[e.key];
      if (node) await tx.update(statEstimates).set({ graphNodeId: node.id }).where(and(eq(statEstimates.id, e.id), isNull(statEstimates.graphNodeId)));
    }
    for (const table of tables) {
      const node = recorded.outputs[`table:${table.position}`];
      if (node) await tx.update(statTables).set({ graphNodeId: node.id }).where(and(eq(statTables.id, table.id), isNull(statTables.graphNodeId)));
    }
    for (const figure of figures) {
      const node = recorded.outputs[`figure:${figure.position}`];
      if (node) await tx.update(statFigures).set({ graphNodeId: node.id }).where(and(eq(statFigures.id, figure.id), isNull(statFigures.graphNodeId)));
    }
  });
  logger.info('stats.graph.recorded', { runId, graphRunId: recorded.run.id, values: kept.length, truncated: estimates.length - kept.length });
  return recorded.run.id;
}

/** Records a run the user can edit (for example after turning the graph on). */
export async function syncRunToGraph(actor: StatsActor, runId: string, projectId: string): Promise<string | null> {
  await requireRun(runId, actor, 'EDITOR', projectId);
  return recordRunInGraph(runId);
}

/** The Impact Report of replacing a recorded run, for the user to acknowledge before re-running. */
export async function previewReplacement(actor: StatsActor, runId: string, projectId: string) {
  const run = await requireRun(runId, actor, 'VIEWER', projectId);
  if (!run.graphRunNodeId) return null;
  return graph.previewRerun(projectId, { userId: actor.userId }, run.graphRunNodeId);
}

/**
 * Declares that a newer dataset version replaces an older one. In the graph the
 * old version is superseded, so every run on it — and every table, figure and
 * manuscript claim built on those runs — becomes not current until re-run.
 * Follows the graph's Impact Report protocol (preview, then acknowledge).
 */
export async function replaceVersion(actor: StatsActor, projectId: string, oldVersionId: string, newVersionId: string, impactAcknowledged?: string) {
  const [older, newer] = await db.select().from(datasetVersions).where(inArray(datasetVersions.id, [oldVersionId, newVersionId]));
  const oldRow = [older, newer].find((row) => row?.id === oldVersionId);
  const newRow = [older, newer].find((row) => row?.id === newVersionId);
  if (!oldRow || !newRow || oldRow.projectId !== projectId || newRow.projectId !== projectId || oldRow.datasetId !== newRow.datasetId) {
    throw new AppError('NOT_FOUND', 'The dataset version was not found.', 'لم يُعثر على الإصدار.');
  }
  await graph.requireProjectRole(projectId, actor.userId, 'EDITOR');
  const engine: EngineActor = { userId: actor.userId, origin: 'engine' };
  const oldNode = await ensureVersionNode(oldVersionId, engine, projectId);
  const newNode = await ensureVersionNode(newVersionId, engine, projectId);
  return graph.supersede(projectId, { userId: actor.userId }, oldNode, newNode, impactAcknowledged);
}

/**
 * The Impact Report of replacing one version with another, without replacing
 * anything (P1-D approvals bind to its hash). Creates the versions' graph
 * nodes if they do not exist yet, which is idempotent and changes no result.
 */
export async function previewVersionReplacement(actor: StatsActor, projectId: string, oldVersionId: string, newVersionId: string) {
  const [older, newer] = await db.select().from(datasetVersions).where(inArray(datasetVersions.id, [oldVersionId, newVersionId]));
  const oldRow = [older, newer].find((row) => row?.id === oldVersionId);
  const newRow = [older, newer].find((row) => row?.id === newVersionId);
  if (!oldRow || !newRow || oldRow.projectId !== projectId || newRow.projectId !== projectId || oldRow.datasetId !== newRow.datasetId) {
    throw new AppError('NOT_FOUND', 'The dataset version was not found.', 'لم يُعثر على الإصدار.');
  }
  await graph.requireProjectRole(projectId, actor.userId, 'EDITOR');
  const engine: EngineActor = { userId: actor.userId, origin: 'engine' };
  const oldNode = await ensureVersionNode(oldVersionId, engine, projectId);
  const newNode = await ensureVersionNode(newVersionId, engine, projectId);
  return graph.previewSupersede(projectId, { userId: actor.userId }, oldNode, newNode);
}
