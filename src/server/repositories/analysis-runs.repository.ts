/**
 * Saved analyses.
 *
 * A row here is a finished statistical result: the test that was run, the
 * columns it was run on, and the full result envelope. Stored rather than
 * recomputed for three reasons that matter in this product specifically.
 *
 * **Reproducibility.** A thesis cites a number. Three months later a supervisor
 * asks where it came from. `spec` holds exactly which columns went into which
 * roles with which options, so the answer is on record rather than in someone's
 * memory of what they clicked.
 *
 * **Stability.** The file can be cleaned, or deleted, after the analysis was
 * run. If results were recomputed on demand they would change or vanish; a
 * number already written into a chapter must not do either.
 *
 * **Writing the results chapter.** `projectId` and `sectionKey` are how a
 * result reaches the AI context as a verified fact rather than something the
 * model is asked to produce. That link is what will let the fourth chapter be
 * written from the researcher's own numbers instead of a table shell.
 */

import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type { SectionKey } from '@/config/research';
import { db } from '@/server/db';
import { analysisRuns, datasets, type AnalysisRun, type NewAnalysisRun } from '@/server/db/schema';

/** The database, or a transaction on it: the deletion checks run inside the transaction that deletes (WS2 N9). */
export type Executor = Pick<typeof db, 'select' | 'delete' | 'execute'>;

export async function create(values: NewAnalysisRun): Promise<AnalysisRun> {
  const [row] = await db.insert(analysisRuns).values(values).returning();
  if (!row) throw new Error('Failed to record analysis run');
  return row;
}

export async function findOwned(id: string, userId: string): Promise<AnalysisRun | undefined> {
  const [row] = await db
    .select()
    .from(analysisRuns)
    .where(and(eq(analysisRuns.id, id), eq(analysisRuns.userId, userId)))
    .limit(1);
  return row;
}

export async function listByDataset(datasetId: string, userId: string): Promise<AnalysisRun[]> {
  return db
    .select()
    .from(analysisRuns)
    .where(and(eq(analysisRuns.datasetId, datasetId), eq(analysisRuns.userId, userId)))
    .orderBy(desc(analysisRuns.createdAt));
}

export async function listByConversation(
  conversationId: string,
  userId: string,
): Promise<AnalysisRun[]> {
  return db
    .select()
    .from(analysisRuns)
    .where(and(eq(analysisRuns.conversationId, conversationId), eq(analysisRuns.userId, userId)))
    .orderBy(desc(analysisRuns.createdAt));
}

export async function listByProject(projectId: string, userId: string): Promise<AnalysisRun[]> {
  return db
    .select()
    .from(analysisRuns)
    .where(and(eq(analysisRuns.projectId, projectId), eq(analysisRuns.userId, userId)))
    .orderBy(desc(analysisRuns.createdAt));
}

/**
 * The analyses attached to one section of a project.
 *
 * This is the query the results chapter will be written from: everything the
 * researcher deliberately attached, and nothing they merely tried.
 */
export async function listForSection(
  projectId: string,
  userId: string,
  sectionKey: SectionKey,
): Promise<AnalysisRun[]> {
  return db
    .select()
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.projectId, projectId),
        eq(analysisRuns.userId, userId),
        eq(analysisRuns.sectionKey, sectionKey),
      ),
    )
    .orderBy(analysisRuns.createdAt);
}

/** Everything the researcher has attached anywhere in a project. */
export async function listAttached(projectId: string, userId: string): Promise<AnalysisRun[]> {
  return db
    .select()
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.projectId, projectId),
        eq(analysisRuns.userId, userId),
        isNotNull(analysisRuns.sectionKey),
      ),
    )
    .orderBy(analysisRuns.createdAt);
}

/**
 * Attaches a result to a project section — the deliberate act that turns a
 * number the researcher was exploring into one they intend to report.
 */
export async function attachToSection(
  id: string,
  userId: string,
  projectId: string,
  sectionKey: SectionKey,
): Promise<AnalysisRun | undefined> {
  const [row] = await db
    .update(analysisRuns)
    .set({ projectId, sectionKey })
    .where(and(eq(analysisRuns.id, id), eq(analysisRuns.userId, userId)))
    .returning();
  return row;
}

export async function detach(id: string, userId: string): Promise<AnalysisRun | undefined> {
  const [row] = await db
    .update(analysisRuns)
    .set({ sectionKey: null })
    .where(and(eq(analysisRuns.id, id), eq(analysisRuns.userId, userId)))
    .returning();
  return row;
}

export async function remove(id: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(analysisRuns)
    .where(and(eq(analysisRuns.id, id), eq(analysisRuns.userId, userId)))
    .returning({ id: analysisRuns.id });
  return rows.length > 0;
}

/** Bulk fetch for rendering a conversation, avoiding one query per message. */
export async function findManyOwned(ids: string[], userId: string): Promise<AnalysisRun[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(analysisRuns)
    .where(and(inArray(analysisRuns.id, ids), eq(analysisRuns.userId, userId)));
}

/* -------------------------------------------------------------------------- */
/*                     Deletion protection (WS2 B3, N9)                       */
/* -------------------------------------------------------------------------- */

/**
 * The runs among `ids` that a recorded section version cites as a source
 * (`section_versions.integrity.sources`, WS2 B1), in any project — a run can be
 * attached to a project its owner edits but does not own. Runs listed only
 * under `excluded` (windowed: their numbers were never used) are not cited.
 */
export async function citedRunIds(ids: readonly string[], executor: Executor = db): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = (await executor.execute(sql`
    select distinct source ->> 'id' as id
    from section_versions version, jsonb_array_elements(version.integrity -> 'sources') source
    where version.integrity is not null
      and jsonb_typeof(version.integrity -> 'sources') = 'array'
      and source ->> 'id' in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `)) as unknown as { id: string }[];
  return new Set(rows.map((row) => row.id));
}

/**
 * One owned run, locked until the transaction ends: an attach (which updates
 * this row) waits, so the check and the delete see the same state.
 */
export async function lockOwned(executor: Executor, id: string, userId: string): Promise<AnalysisRun | undefined> {
  const [row] = await executor
    .select()
    .from(analysisRuns)
    .where(and(eq(analysisRuns.id, id), eq(analysisRuns.userId, userId)))
    .for('update');
  return row;
}

/**
 * Every run of these datasets (whoever ran them: the delete cascades to all of
 * them), locked until the transaction ends.
 */
export async function lockByDatasets(executor: Executor, datasetIds: readonly string[]): Promise<Pick<AnalysisRun, 'id' | 'sectionKey'>[]> {
  if (datasetIds.length === 0) return [];
  return executor
    .select({ id: analysisRuns.id, sectionKey: analysisRuns.sectionKey })
    .from(analysisRuns)
    .where(inArray(analysisRuns.datasetId, [...datasetIds]))
    .for('update');
}

/** The runs of a dataset and all its cleaned copies (deleted ones included: the cascade removes them too). */
export async function listByDatasetTree(datasetId: string, executor: Executor = db): Promise<Pick<AnalysisRun, 'id' | 'sectionKey'>[]> {
  const children = await executor.select({ id: datasets.id }).from(datasets).where(eq(datasets.parentDatasetId, datasetId));
  return executor
    .select({ id: analysisRuns.id, sectionKey: analysisRuns.sectionKey })
    .from(analysisRuns)
    .where(inArray(analysisRuns.datasetId, [datasetId, ...children.map((child) => child.id)]));
}

/** Removes a run inside the caller's transaction. */
export async function removeIn(executor: Executor, id: string, userId: string): Promise<boolean> {
  const rows = await executor
    .delete(analysisRuns)
    .where(and(eq(analysisRuns.id, id), eq(analysisRuns.userId, userId)))
    .returning({ id: analysisRuns.id });
  return rows.length > 0;
}
