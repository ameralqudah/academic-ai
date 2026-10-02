/**
 * Storing generated files as versioned objects.
 *
 * The rule that shapes every query here: **nothing is overwritten**. A new
 * version is a new row pointing at the previous one, so a researcher who
 * regenerates a thesis at midnight and prefers the earlier draft at nine can
 * still reach it.
 */

import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { db } from '@/server/db';
import { artifacts, type Artifact, type NewArtifact } from '@/server/db/schema';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The database, or the transaction a store runs in (WS4 G5): every query of one store uses one connection. */
type Executor = typeof db | Tx;

/**
 * Records the first version of a document.
 *
 * The lineage id is the artifact's own id, so a lineage can be found without a
 * join and the first version needs no special case.
 */
export async function createFirst(
  input: Omit<NewArtifact, 'version' | 'lineageId' | 'parentArtifactId'>,
  executor: Executor = db,
): Promise<Artifact> {
  /*
   * The id is generated here rather than by the database, so the row can be
   * inserted with its lineage already pointing at itself. Inserting and then
   * updating would leave a window where the lineage is wrong, and a concurrent
   * read in that window returns a version that appears to belong nowhere.
   */
  const id = crypto.randomUUID();

  const [row] = await executor
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
  executor: Executor = db,
): Promise<Artifact> {
  const [highest] = await executor
    .select({ version: artifacts.version })
    .from(artifacts)
    .where(eq(artifacts.lineageId, parent.lineageId))
    .orderBy(desc(artifacts.version))
    .limit(1);

  const [row] = await executor
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

export async function findOwned(id: string, userId: string, executor: Executor = db): Promise<Artifact | undefined> {
  const [row] = await executor
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

/**
 * WS4 G5: runs `work` holding a per-user, per-key transaction lock, so two
 * identical stores racing each other cannot both write: the second waits, then
 * finds the first. Every query of the store must run on the transaction it is
 * given: one connection per store, so stores waiting on the lock can never
 * exhaust the pool (a serverless pool holds a single connection).
 */
export async function withStoreLock<T>(userId: string, key: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`artifact:${userId}:${key}`}))`);
    return work(tx);
  });
}

/** WS4 G5: the user's live artifact stored under this idempotency key, at any time. */
export async function findByIdempotencyKey(userId: string, key: string, executor: Executor = db): Promise<Artifact | undefined> {
  const [row] = await executor
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.userId, userId), isNull(artifacts.deletedAt), sql`${artifacts.metadata} ->> 'idempotencyKey' = ${key}`))
    .orderBy(desc(artifacts.createdAt))
    .limit(1);
  return row;
}

/** WS4 G5: the user's live artifact from the same request (same identity and bytes) stored within the last `withinMinutes`. */
export async function findRecentRepeat(userId: string, requestKey: string, withinMinutes: number, executor: Executor = db): Promise<Artifact | undefined> {
  const [row] = await executor
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.userId, userId),
        isNull(artifacts.deletedAt),
        sql`${artifacts.metadata} ->> 'requestKey' = ${requestKey}`,
        gt(artifacts.createdAt, sql`now() - make_interval(mins => ${withinMinutes})`),
      ),
    )
    .orderBy(desc(artifacts.createdAt))
    .limit(1);
  return row;
}
