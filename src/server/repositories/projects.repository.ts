import { and, count, desc, eq } from 'drizzle-orm';

import type { SectionKey } from '@/config/research';
import { db } from '@/server/db';
import {
  researchProjects,
  researchSections,
  sectionVersions,
  type NewResearchProject,
  type ResearchProject,
  type ResearchSection,
  type SectionVersion,
} from '@/server/db/schema';

export async function listByUser(userId: string, limit?: number): Promise<ResearchProject[]> {
  const query = db
    .select()
    .from(researchProjects)
    .where(and(eq(researchProjects.userId, userId), eq(researchProjects.isArchived, false)))
    .orderBy(desc(researchProjects.lastEditedAt));

  return limit ? query.limit(limit) : query;
}

export async function countByUser(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(researchProjects)
    .where(and(eq(researchProjects.userId, userId), eq(researchProjects.isArchived, false)));
  return row?.value ?? 0;
}

export async function findById(id: string): Promise<ResearchProject | undefined> {
  const [row] = await db.select().from(researchProjects).where(eq(researchProjects.id, id)).limit(1);
  return row;
}

export async function findOwned(
  id: string,
  userId: string,
): Promise<ResearchProject | undefined> {
  const [row] = await db
    .select()
    .from(researchProjects)
    .where(and(eq(researchProjects.id, id), eq(researchProjects.userId, userId)))
    .limit(1);
  return row;
}

export async function create(values: NewResearchProject): Promise<ResearchProject> {
  const [row] = await db.insert(researchProjects).values(values).returning();
  if (!row) throw new Error('Failed to create project');
  return row;
}

export async function update(
  id: string,
  values: Partial<NewResearchProject>,
): Promise<ResearchProject | undefined> {
  const [row] = await db
    .update(researchProjects)
    .set({ ...values, lastEditedAt: new Date() })
    .where(eq(researchProjects.id, id))
    .returning();
  return row;
}

export async function remove(id: string): Promise<void> {
  await db.delete(researchProjects).where(eq(researchProjects.id, id));
}

/* ----------------------------- sections ---------------------------------- */

export async function listSections(projectId: string): Promise<ResearchSection[]> {
  return db
    .select()
    .from(researchSections)
    .where(eq(researchSections.projectId, projectId))
    .orderBy(researchSections.orderIndex);
}

export async function findSection(
  projectId: string,
  sectionKey: SectionKey,
): Promise<ResearchSection | undefined> {
  const [row] = await db
    .select()
    .from(researchSections)
    .where(
      and(eq(researchSections.projectId, projectId), eq(researchSections.sectionKey, sectionKey)),
    )
    .limit(1);
  return row;
}

export async function insertSections(
  rows: (typeof researchSections.$inferInsert)[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(researchSections).values(rows).onConflictDoNothing();
}

export async function updateSection(
  id: string,
  values: Partial<typeof researchSections.$inferInsert>,
): Promise<ResearchSection | undefined> {
  const [row] = await db
    .update(researchSections)
    .set(values)
    .where(eq(researchSections.id, id))
    .returning();
  return row;
}

export async function upsertSection(
  values: typeof researchSections.$inferInsert,
): Promise<ResearchSection> {
  const [row] = await db
    .insert(researchSections)
    .values(values)
    .onConflictDoUpdate({
      target: [researchSections.projectId, researchSections.sectionKey],
      set: {
        content: values.content ?? '',
        status: values.status ?? 'DRAFT',
        wordCount: values.wordCount ?? 0,
        heading: values.heading ?? null,
        // Sections are pre-created with the project, so the conflict branch is
        // the normal path — every field a save can change belongs here, or it
        // is silently dropped.
        orderIndex: values.orderIndex ?? 0,
        approvedAt: values.approvedAt ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error('Failed to save section');
  return row;
}

/* ---------------------------- section versions ---------------------------- */

export async function addVersion(
  values: typeof sectionVersions.$inferInsert,
): Promise<SectionVersion> {
  const [row] = await db.insert(sectionVersions).values(values).returning();
  if (!row) throw new Error('Failed to store section version');
  return row;
}

export async function listVersions(sectionId: string, limit = 20): Promise<SectionVersion[]> {
  return db
    .select()
    .from(sectionVersions)
    .where(eq(sectionVersions.sectionId, sectionId))
    .orderBy(desc(sectionVersions.createdAt))
    .limit(limit);
}
