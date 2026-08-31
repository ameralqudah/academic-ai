/**
 * Long-running analyses, as rows.
 *
 * A bootstrap takes a minute; an HTTP request does not last that long. So the
 * request writes a row, returns its id, and the work continues afterwards while
 * the client asks about progress.
 *
 * The design point worth stating: **a job is never left claiming to be running
 * when nothing is.** On this hosting the work happens inside the web process,
 * so a redeploy mid-run kills it — and a row still marked RUNNING would show a
 * progress bar that never moves, forever. `failStale` is called at startup to
 * close that out, which is why `startedAt` is recorded rather than only
 * `createdAt`.
 */

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import { db } from '@/server/db';
import { analysisJobs, type AnalysisJob, type NewAnalysisJob } from '@/server/db/schema';

export type JobStatus = AnalysisJob['status'];

export async function create(values: NewAnalysisJob): Promise<AnalysisJob> {
  const [row] = await db.insert(analysisJobs).values(values).returning();
  if (!row) throw new Error('Failed to create analysis job');
  return row;
}

/**
 * Ownership is part of the query, never a check that follows it.
 *
 * The same rule as datasets and conversations: a two-step check is a race, and
 * a job's result can contain the whole of someone's data analysis.
 */
export async function findOwned(id: string, userId: string): Promise<AnalysisJob | undefined> {
  const [row] = await db
    .select()
    .from(analysisJobs)
    .where(and(eq(analysisJobs.id, id), eq(analysisJobs.userId, userId)))
    .limit(1);
  return row;
}

/**
 * A job by id, without an ownership check.
 *
 * For the background runner only, which has no request and therefore no user —
 * it is executing work whose ownership was established when the job was
 * created. Every path that comes from a request uses `findOwned` instead, and
 * the name is deliberately awkward so that using this one is a choice rather
 * than an accident.
 */
export async function findOwnedAny(id: string): Promise<AnalysisJob | undefined> {
  const [row] = await db.select().from(analysisJobs).where(eq(analysisJobs.id, id)).limit(1);
  return row;
}

export async function listForUser(userId: string, limit = 20): Promise<AnalysisJob[]> {
  return db
    .select()
    .from(analysisJobs)
    .where(eq(analysisJobs.userId, userId))
    .orderBy(desc(analysisJobs.createdAt))
    .limit(limit);
}

export async function markRunning(id: string): Promise<void> {
  await db
    .update(analysisJobs)
    .set({ status: 'RUNNING', startedAt: new Date(), progress: 0, updatedAt: new Date() })
    .where(eq(analysisJobs.id, id));
}

/**
 * Progress, written at whole percentages.
 *
 * The bootstrap calls this a hundred times rather than five thousand — writing
 * per resample would cost more in database round trips than the arithmetic it
 * describes.
 */
export async function updateProgress(id: string, progress: number, stage?: string): Promise<void> {
  await db
    .update(analysisJobs)
    .set({
      progress: Math.max(0, Math.min(100, Math.round(progress))),
      ...(stage ? { stage } : {}),
      updatedAt: new Date(),
    })
    .where(eq(analysisJobs.id, id));
}

export async function complete(
  id: string,
  result: Record<string, unknown>,
  durationMs: number,
): Promise<void> {
  await db
    .update(analysisJobs)
    .set({
      status: 'COMPLETED',
      progress: 100,
      stage: null,
      result,
      finishedAt: new Date(),
      durationMs,
      updatedAt: new Date(),
    })
    .where(eq(analysisJobs.id, id));
}

export async function fail(id: string, reasonKey: string, durationMs?: number): Promise<void> {
  await db
    .update(analysisJobs)
    .set({
      status: 'FAILED',
      errorReasonKey: reasonKey.slice(0, 128),
      finishedAt: new Date(),
      ...(durationMs === undefined ? {} : { durationMs }),
      updatedAt: new Date(),
    })
    .where(eq(analysisJobs.id, id));
}

export async function cancel(id: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(analysisJobs)
    .set({ status: 'CANCELLED', finishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(analysisJobs.id, id),
        eq(analysisJobs.userId, userId),
        /* Only work that has not finished — a completed job keeps its result. */
        inArray(analysisJobs.status, ['QUEUED', 'RUNNING']),
      ),
    )
    .returning({ id: analysisJobs.id });

  return rows.length > 0;
}

/** Whether a running job has been cancelled — polled between resamples. */
export async function isCancelled(id: string): Promise<boolean> {
  const [row] = await db
    .select({ status: analysisJobs.status })
    .from(analysisJobs)
    .where(eq(analysisJobs.id, id))
    .limit(1);

  return row?.status === 'CANCELLED';
}

/**
 * Closes out jobs abandoned by a restart.
 *
 * Called once at startup. Anything still QUEUED or RUNNING cannot be running —
 * the process that owned it is gone — so it is failed with a reason the user
 * can act on rather than left as a progress bar that never moves.
 *
 * The age condition guards against a second instance clearing the first one's
 * live work. Ten minutes is comfortably longer than any bootstrap this runs and
 * comfortably shorter than a user's patience.
 */
export async function failStale(olderThanMinutes = 10): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);

  const rows = await db
    .update(analysisJobs)
    .set({
      status: 'FAILED',
      errorReasonKey: 'analysis.job.error.interrupted',
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(analysisJobs.status, ['QUEUED', 'RUNNING']),
        or(lt(analysisJobs.startedAt, cutoff), isNull(analysisJobs.startedAt)),
        lt(analysisJobs.createdAt, cutoff),
      ),
    )
    .returning({ id: analysisJobs.id });

  return rows.length;
}

/** How many jobs a user has in flight, for a concurrency limit. */
export async function countActive(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(analysisJobs)
    .where(
      and(eq(analysisJobs.userId, userId), inArray(analysisJobs.status, ['QUEUED', 'RUNNING'])),
    );

  return row?.value ?? 0;
}
