/**
 * Storing generated files as versioned objects.
 *
 * The rule that shapes every query here: **nothing is overwritten**. A new
 * version is a new row pointing at the previous one, so a researcher who
 * regenerates a thesis at midnight and prefers the earlier draft at nine can
 * still reach it.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';

import { db } from '@/server/db';
import { artifacts, type Artifact, type NewArtifact } from '@/server/db/schema';

/**
 * Records the first version of a document.
 *
 * The lineage id is the artifact's own id, so a lineage can be found without a
 * join and the first version needs no special case.
 */
export async function createFirst(
  input: Omit<NewArtifact, 'version' | 'lineageId' | 'parentArtifactId'>,
): Promise<Artifact> {
  /*
   * The id is generated here rather than by the database, so the row can be
   * inserted with its lineage already pointing at itself. Inserting and then
   * updating would leave a window where the lineage is wrong, and a concurrent
   * read in that window returns a version that appears to belong nowhere.
   */
  const id = crypto.randomUUID();

  const [row] = await db
    .insert(artifacts)
    .values({ ...input, id, version: 1, lineageId: id })
    .returning();

  return row as Artifact;
}

/**
 * Adds a version to an existing lineage.
 *
 * The version number comes from the highest in the lineage rather than from a
 * count: counting would renumber everything if a version were ever removed, and
 * a researcher who told their supervisor "version 3" expects it to stay
 * version 3.
 */
export async function createVersion(
  parent: Artifact,
  input: Omit<NewArtifact, 'version' | 'lineageId' | 'parentArtifactId'>,
): Promise<Artifact> {
  const [highest] = await db
    .select({ version: artifacts.version })
    .from(artifacts)
    .where(eq(artifacts.lineageId, parent.lineageId))
    .orderBy(desc(artifacts.version))
    .limit(1);

  const [row] = await db
    .insert(artifacts)
    .values({
      ...input,
      version: (highest?.version ?? parent.version) + 1,
      lineageId: parent.lineageId,
      parentArtifactId: parent.id,
    })
    .returning();

  return row as Artifact;
}

export async function findOwned(id: string, userId: string): Promise<Artifact | undefined> {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId), isNull(artifacts.deletedAt)))
    .limit(1);

  return row;
}

/** Every version of one document, newest first. */
export async function lineage(lineageId: string, userId: string): Promise<Artifact[]> {
  return db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.lineageId, lineageId),
        eq(artifacts.userId, userId),
        isNull(artifacts.deletedAt),
      ),
    )
    .orderBy(desc(artifacts.version));
}

/**
 * The latest version of each document a user has.
 *
 * The list view: a researcher with four versions of a thesis and two of a
 * questionnaire should see two entries, not six.
 */
export async function listLatest(userId: string, limit = 50): Promise<Artifact[]> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.userId, userId), isNull(artifacts.deletedAt)))
    .orderBy(desc(artifacts.createdAt))
    .limit(limit * 4);

  const seen = new Set<string>();
  const latest: Artifact[] = [];

  for (const row of rows) {
    if (seen.has(row.lineageId)) continue;

    seen.add(row.lineageId);
    latest.push(row);

    if (latest.length >= limit) break;
  }

  return latest;
}

export async function listForProject(projectId: string, userId: string): Promise<Artifact[]> {
  return db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.projectId, projectId),
        eq(artifacts.userId, userId),
        isNull(artifacts.deletedAt),
      ),
    )
    .orderBy(desc(artifacts.createdAt));
}

/**
 * Soft-deletes one version.
 *
 * Soft because a version removed by accident is a version the researcher wants
 * back, and the bytes are still in storage either way.
 */
export async function remove(id: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(artifacts)
    .set({ deletedAt: new Date() })
    .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId), isNull(artifacts.deletedAt)))
    .returning({ id: artifacts.id });

  return rows.length > 0;
}
