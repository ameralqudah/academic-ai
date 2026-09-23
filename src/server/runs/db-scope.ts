/**
 * The database scope of the run paths: row-level security, enforced (P1-D).
 *
 * Every read and write of the run tables happens inside `withRunScope`, one
 * short transaction that switches to the restricted role `academic_app`
 * (NOBYPASSRLS, not a table owner) and names the acting user in a
 * transaction-local setting. PostgreSQL then applies the policies of
 * migration 0015: a query can see or change only rows of projects the user
 * belongs to, with the role they hold there — whatever the application code
 * asks for.
 *
 * Before the first scope, `assertRlsEnforced` proves the database will
 * enforce this: the role exists and can be taken, it cannot bypass RLS and is
 * not a superuser, and RLS is on for all four tables. If any of that fails,
 * the run engine refuses to start (UNAVAILABLE). It never falls back to
 * running with application checks alone.
 *
 * Tools never execute inside a scope: the transaction is held only for the
 * run-table statements, so a single-connection pool (serverless) cannot
 * deadlock against the tool's own queries.
 */

import { sql } from 'drizzle-orm';

import { logger } from '@/lib/logger';
import { db } from '@/server/db';
import { AppError } from '@/server/http/errors';

export type RunTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const RUN_ROLE = 'academic_app';
const RUN_TABLES = ['research_runs', 'run_steps', 'run_approvals', 'run_events'];

let verified = false;

interface RlsProbe {
  role: string;
  bypass: boolean;
  superuser: boolean;
  rls: boolean | null;
  row_security: string;
}

/** Proves the database enforces RLS for the run role; throws UNAVAILABLE otherwise. Cached once proven. */
export async function assertRlsEnforced(): Promise<void> {
  if (verified) return;
  let probe: RlsProbe | undefined;
  try {
    probe = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local role ${RUN_ROLE}`));
      const rows = await tx.execute(sql`
        select current_user as role, r.rolbypassrls as bypass, r.rolsuper as superuser,
               (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname in ('research_runs', 'run_steps', 'run_approvals', 'run_events')) as rls,
               current_setting('row_security') as row_security
        from pg_roles r where r.rolname = current_user`);
      return (rows as unknown as RlsProbe[])[0];
    });
  } catch (error) {
    logger.error('runs.rls.unavailable', { error: String(error).slice(0, 300) });
  }
  const ok = probe && probe.role === RUN_ROLE && !probe.bypass && !probe.superuser && probe.rls === true && probe.row_security !== 'off';
  if (!ok) {
    logger.error('runs.rls.notEnforced', { probe: probe ?? null, tables: RUN_TABLES });
    throw new AppError(
      'UNAVAILABLE',
      'Research runs are unavailable: the database cannot enforce their access policies.',
      'عمليات البحث غير متاحة: لا تستطيع قاعدة البيانات فرض سياسات الوصول الخاصة بها.',
      { reason: 'rls_unavailable' },
    );
  }
  verified = true;
}

/** For tests that change the database role setup. */
export function forgetRlsCheck(): void {
  verified = false;
}

/**
 * Runs `work` as `userId` under the restricted role, in one transaction.
 * Only run-table statements belong inside; never a tool or a model call.
 */
export async function withRunScope<T>(userId: string, work: (tx: RunTx) => Promise<T>): Promise<T> {
  if (!userId) throw new AppError('UNAUTHORIZED', 'You need to log in.', 'تحتاج إلى تسجيل الدخول.');
  await assertRlsEnforced();
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${RUN_ROLE}`));
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return work(tx);
  });
}

/**
 * The system path: the owner connection, which bypasses RLS. Used only by
 * the job runner to learn which user a queued run belongs to (it has no
 * session), and by the reaper to find runs whose worker died. Everything the
 * run then does happens in `withRunScope` as that user.
 */
export const systemDb = db;
