import { and, desc, eq, max } from 'drizzle-orm';

import { db } from '@/server/db';
import { titleCandidates, type TitleCandidate } from '@/server/db/schema';

export async function listForProject(projectId: string): Promise<TitleCandidate[]> {
  return db
    .select()
    .from(titleCandidates)
    .where(eq(titleCandidates.projectId, projectId))
    .orderBy(desc(titleCandidates.batch), desc(titleCandidates.fitScore));
}

export async function nextBatch(projectId: string): Promise<number> {
  const [row] = await db
    .select({ value: max(titleCandidates.batch) })
    .from(titleCandidates)
    .where(eq(titleCandidates.projectId, projectId));
  return (row?.value ?? 0) + 1;
}

export async function insertMany(
  rows: (typeof titleCandidates.$inferInsert)[],
): Promise<TitleCandidate[]> {
  if (rows.length === 0) return [];
  return db.insert(titleCandidates).values(rows).returning();
}

/**
 * Removes one title candidate.
 *
 * There was no way to remove one. A researcher generating three batches of five
 * accumulated fifteen suggestions, most of them rejected on sight, with no way
 * to clear any of them — so the list grew until the useful ones were buried.
 *
 * Scoped to the project as well as the id, so a candidate id alone cannot
 * delete from someone else's project. Ownership of the project itself is
 * checked by the caller.
 */
export async function remove(projectId: string, candidateId: string): Promise<boolean> {
  const rows = await db
    .delete(titleCandidates)
    .where(and(eq(titleCandidates.id, candidateId), eq(titleCandidates.projectId, projectId)))
    .returning({ id: titleCandidates.id });

  return rows.length > 0;
}

/**
 * Removes every candidate that has not been chosen.
 *
 * The bulk case, for a researcher who has settled on a title and wants the
 * rejected suggestions gone. The selected one is kept deliberately: it is the
 * project's working title, and deleting it would leave the project without one.
 */
export async function removeUnselected(projectId: string): Promise<number> {
  const rows = await db
    .delete(titleCandidates)
    .where(and(eq(titleCandidates.projectId, projectId), eq(titleCandidates.selected, false)))
    .returning({ id: titleCandidates.id });

  return rows.length;
}

export async function select(projectId: string, candidateId: string): Promise<TitleCandidate> {
  await db
    .update(titleCandidates)
    .set({ selected: false })
    .where(eq(titleCandidates.projectId, projectId));

  const [row] = await db
    .update(titleCandidates)
    .set({ selected: true })
    .where(and(eq(titleCandidates.id, candidateId), eq(titleCandidates.projectId, projectId)))
    .returning();

  if (!row) throw new Error('Title candidate not found');
  return row;
}
