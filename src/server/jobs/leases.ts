/**
 * Exclusive execution, by lease on the row.
 *
 * A worker may run a task or analysis job only while it holds that row's
 * lease: an atomic conditional update that succeeds for one caller and fails
 * for every other, renewed by a heartbeat while the work runs. This is what
 * makes duplicate execution impossible across processes and instances —
 * the property the previous "resume everything on every cold start" lacked.
 * A lease that lapses (the worker crashed or was redeployed) is how the reaper
 * knows the work needs picking up.
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { logger } from '@/lib/logger';
import { db } from '@/server/db';
import { analysisJobs, tasks } from '@/server/db/schema';

export const LEASE_SECONDS = 120;
export const HEARTBEAT_MS = 30_000;

/** This process. Each execution's lease owner is this plus a per-run token. */
export const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

type LeasedTable = 'tasks' | 'analysis_jobs';

const expiresIn = () => sql`now() + make_interval(secs => ${LEASE_SECONDS})`;

export async function claimLease(name: LeasedTable, id: string, owner = WORKER_ID): Promise<boolean> {
  if (name === 'tasks') {
    const rows = await db
      .update(tasks)
      .set({ leaseOwner: owner, leaseExpiresAt: expiresIn() })
      .where(
        and(
          eq(tasks.id, id),
          or(isNull(tasks.leaseExpiresAt), lt(tasks.leaseExpiresAt, sql`now()`), eq(tasks.leaseOwner, owner)),
        ),
      )
      .returning({ id: tasks.id });
    return rows.length > 0;
  }

  const rows = await db
    .update(analysisJobs)
    .set({ leaseOwner: owner, leaseExpiresAt: expiresIn(), attempts: sql`${analysisJobs.attempts} + 1` })
    .where(
      and(
        eq(analysisJobs.id, id),
        or(
          isNull(analysisJobs.leaseExpiresAt),
          lt(analysisJobs.leaseExpiresAt, sql`now()`),
          eq(analysisJobs.leaseOwner, owner),
        ),
      ),
    )
    .returning({ id: analysisJobs.id });
  return rows.length > 0;
}

export async function renewLease(name: LeasedTable, id: string, owner = WORKER_ID): Promise<boolean> {
  const rows =
    name === 'tasks'
      ? await db
          .update(tasks)
          .set({ leaseExpiresAt: expiresIn() })
          .where(and(eq(tasks.id, id), eq(tasks.leaseOwner, owner)))
          .returning({ id: tasks.id })
      : await db
          .update(analysisJobs)
          .set({ leaseExpiresAt: expiresIn() })
          .where(and(eq(analysisJobs.id, id), eq(analysisJobs.leaseOwner, owner)))
          .returning({ id: analysisJobs.id });
  return rows.length > 0;
}

export async function releaseLease(name: LeasedTable, id: string, owner = WORKER_ID): Promise<void> {
  if (name === 'tasks') {
    await db
      .update(tasks)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(and(eq(tasks.id, id), eq(tasks.leaseOwner, owner)));
    return;
  }
  await db
    .update(analysisJobs)
    .set({ leaseOwner: null, leaseExpiresAt: null })
    .where(and(eq(analysisJobs.id, id), eq(analysisJobs.leaseOwner, owner)));
}

/**
 * Runs `work` under the row's lease, heartbeating while it runs.
 *
 * Returns 'busy' without running anything when another live worker holds the
 * lease. The lease is released however the work ends.
 */
export async function withLease(
  name: LeasedTable,
  id: string,
  work: () => Promise<void>,
): Promise<'ran' | 'busy'> {
  /*
   * A token per execution, not per process: two jobs for the same row picked
   * up by one process (a queue retry beside a fallback run) must exclude each
   * other as surely as two processes do.
   */
  const owner = `${WORKER_ID}:${randomUUID().slice(0, 8)}`;
  if (!(await claimLease(name, id, owner))) return 'busy';

  const heartbeat = setInterval(() => {
    void renewLease(name, id, owner).catch((error: unknown) => {
      logger.warn('jobs.lease.renewFailed', { table: name, id, error: String(error).slice(0, 200) });
    });
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    await work();
    return 'ran';
  } finally {
    clearInterval(heartbeat);
    await releaseLease(name, id, owner).catch(() => undefined);
  }
}
