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

import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { SectionKey } from '@/config/research';
import { db } from '@/server/db';
import { analysisRuns, type AnalysisRun, type NewAnalysisRun } from '@/server/db/schema';

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
