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
