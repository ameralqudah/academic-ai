/**
 * Datasets: the description of an uploaded file, never its bytes.
 *
 * Two things in here carry more weight than the rest.
 *
 * **Every lookup takes a user id.** There is no `findById(id)` that returns a
 * row to whoever asks for it. The project repository already works this way —
 * `findOwned` rather than `findById` for anything reachable from a request —
 * and datasets need it more, not less: a storage key is enough to fetch a file
 * once the row is in hand, so a row handed out carelessly is a file handed out
 * carelessly.
 *
 * **Deleted rows stay out of every list.** "Delete the file" sets `deletedAt`
 * and removes the bytes, leaving the analyses intact. That only works if the
 * soft-deleted row cannot be picked up again by an ordinary query and used to
 * attempt a read of bytes that are gone, so the filter lives here rather than
 * in each caller.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { db } from '@/server/db';
import {
  analysisRuns,
  datasets,
  type Dataset,
  type NewDataset,
} from '@/server/db/schema';

/** Rows that still have their bytes. */
const alive = () => isNull(datasets.deletedAt);

export async function create(values: NewDataset): Promise<Dataset> {
  const [row] = await db.insert(datasets).values(values).returning();
  if (!row) throw new Error('Failed to create dataset');
  return row;
}

/**
 * The only way a request obtains a dataset.
 *
 * Both conditions are in the same query rather than fetched-then-checked: a
 * two-step check is a race and an easy thing to forget at a call site.
 */
export async function findOwned(id: string, userId: string): Promise<Dataset | undefined> {
  const [row] = await db
    .select()
    .from(datasets)
    .where(and(eq(datasets.id, id), eq(datasets.userId, userId), alive()))
    .limit(1);
  return row;
}

/**
 * Includes soft-deleted rows. Used only where a caller must show that a file
 * once existed — a saved analysis pointing at a file the user has since
 * removed — and never as a route to the bytes.
 */
export async function findOwnedIncludingDeleted(
  id: string,
  userId: string,
): Promise<Dataset | undefined> {
  const [row] = await db
    .select()
    .from(datasets)
    .where(and(eq(datasets.id, id), eq(datasets.userId, userId)))
    .limit(1);
  return row;
}

export async function listByUser(userId: string, limit = 50): Promise<Dataset[]> {
  return db
    .select()
    .from(datasets)
    .where(and(eq(datasets.userId, userId), alive()))
    .orderBy(desc(datasets.createdAt))
    .limit(limit);
}

export async function listByProject(projectId: string, userId: string): Promise<Dataset[]> {
  return db
    .select()
    .from(datasets)
    .where(and(eq(datasets.projectId, projectId), eq(datasets.userId, userId), alive()))
    .orderBy(desc(datasets.createdAt));
}

/** The cleaned copies derived from one original. */
export async function listChildren(parentId: string, userId: string): Promise<Dataset[]> {
  return db
    .select()
    .from(datasets)
    .where(and(eq(datasets.parentDatasetId, parentId), eq(datasets.userId, userId), alive()))
    .orderBy(desc(datasets.createdAt));
}

export async function update(
  id: string,
  userId: string,
  values: Partial<NewDataset>,
): Promise<Dataset | undefined> {
  const [row] = await db
    .update(datasets)
    .set(values)
    .where(and(eq(datasets.id, id), eq(datasets.userId, userId)))
    .returning();
  return row;
}

/**
 * "Delete the file": the bytes go, the row is marked, the analyses survive.
 *
 * The caller removes the object from storage; this records that it is gone. In
 * that order, because a row still pointing at bytes that no longer exist is a
 * recoverable inconsistency, while a row marked deleted whose bytes are still
 * on disk is an orphaned file nobody will ever clean up.
 */
export async function softDelete(id: string, userId: string): Promise<Dataset | undefined> {
  const [row] = await db
    .update(datasets)
    .set({ deletedAt: new Date() })
    .where(and(eq(datasets.id, id), eq(datasets.userId, userId)))
    .returning();
  return row;
}

/**
 * "Delete everything": the row goes, and the foreign key takes the analyses
 * with it.
 *
 * Destructive and irreversible, which is why the service layer requires an
 * explicit confirmation before calling it.
 */
export async function hardDelete(id: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(datasets)
    .where(and(eq(datasets.id, id), eq(datasets.userId, userId)))
    .returning({ id: datasets.id });
  return rows.length > 0;
}

/** How much a "delete everything" would destroy, for the confirmation prompt. */
export async function countDependents(
  id: string,
  userId: string,
): Promise<{ analyses: number; cleanedCopies: number }> {
  const [analyses] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(analysisRuns)
    .where(and(eq(analysisRuns.datasetId, id), eq(analysisRuns.userId, userId)));

  const [children] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(datasets)
    .where(and(eq(datasets.parentDatasetId, id), eq(datasets.userId, userId)));

  return { analyses: analyses?.value ?? 0, cleanedCopies: children?.value ?? 0 };
}

/** Total bytes a user is holding, for quota reporting and the admin dashboard. */
export async function totalBytesForUser(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`coalesce(sum(${datasets.byteSize}), 0)::bigint` })
    .from(datasets)
    .where(and(eq(datasets.userId, userId), alive()));
  return Number(row?.value ?? 0);
}
