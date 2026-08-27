import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/server/db';
import { references, type ReferenceRow } from '@/server/db/schema';

export async function listForProject(projectId: string): Promise<ReferenceRow[]> {
  return db
    .select()
    .from(references)
    .where(eq(references.projectId, projectId))
    .orderBy(desc(references.createdAt));
}

export async function create(values: typeof references.$inferInsert): Promise<ReferenceRow> {
  const [row] = await db.insert(references).values(values).returning();
  if (!row) throw new Error('Failed to create reference');
  return row;
}

export async function update(
  id: string,
  projectId: string,
  values: Partial<typeof references.$inferInsert>,
): Promise<ReferenceRow | undefined> {
  const [row] = await db
    .update(references)
    .set(values)
    .where(and(eq(references.id, id), eq(references.projectId, projectId)))
    .returning();
  return row;
}

export async function remove(id: string, projectId: string): Promise<void> {
  await db.delete(references).where(and(eq(references.id, id), eq(references.projectId, projectId)));
}
