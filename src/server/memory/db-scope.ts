/**
 * The database scope of memories and thread summaries: row-level security,
 * enforced (P1-E), on the same model as the run tables (`runs/db-scope.ts`).
 *
 * Every read and write of `memories` and `thread_summaries` happens inside
 * `withMemoryScope`: one short transaction that switches to the restricted
 * role `academic_app` (NOBYPASSRLS, not a table owner) and names the acting
 * user in a transaction-local setting. PostgreSQL then applies the policies of
 * migration 0018, whatever the application code asks for.
 *
 * Before the first scope, `assertMemoryRlsEnforced` proves the database will
 * enforce them: the role can be taken, cannot bypass RLS, is not a superuser,
 * and RLS is on for both tables. If not, memory refuses to start (UNAVAILABLE,
 * `rls_unavailable`); it never falls back to application checks alone. A probe
 * that could not reach the database is retried a bounded number of times and
 * refused as `infra_unavailable`, claiming nothing about RLS.
 *
 * Only memory-table statements belong inside a scope; never a model call.
 */

import { sql } from 'drizzle-orm';

import { logger } from '@/lib/logger';
import { db } from '@/server/db';
import { AppError } from '@/server/http/errors';
import { RLS_PROBE_ATTEMPTS, RUN_ROLE, rlsProbeFailure, type RlsProbe, type RunTx } from '@/server/runs/db-scope';

export type MemoryTx = RunTx;

export const MEMORY_TABLES = ['memories', 'thread_summaries'] as const;

let verified = false;

const PROBE_BACKOFF_MS = [250, 1_000];

async function probeMemoryRls(): Promise<RlsProbe | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${RUN_ROLE}`));
    const rows = await tx.execute(sql`
      select current_user as role, r.rolbypassrls as bypass, r.rolsuper as superuser,
             (select bool_and(c.relrowsecurity) and count(*) = 2 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname in ('memories', 'thread_summaries')) as rls,
             current_setting('row_security') as row_security
      from pg_roles r where r.rolname = current_user`);
    return (rows as unknown as RlsProbe[])[0];
  });
}

let probe: () => Promise<RlsProbe | undefined> = probeMemoryRls;

/** For tests: wrap or replace the probe. `null` restores it. */
export function setMemoryRlsProbeForTests(wrap: ((real: () => Promise<RlsProbe | undefined>) => () => Promise<RlsProbe | undefined>) | null): void {
  probe = wrap ? wrap(probeMemoryRls) : probeMemoryRls;
  verified = false;
}

/** For tests that change the database role setup. */
export function forgetMemoryRlsCheck(): void {
  verified = false;
}

/** Proves the database enforces RLS on the memory tables for the restricted role; throws UNAVAILABLE otherwise. Cached once proven. */
export async function assertMemoryRlsEnforced(): Promise<void> {
  if (verified) return;
  let result: RlsProbe | undefined;
  for (let attempt = 1; ; attempt += 1) {
    try {
      result = await probe();
      break;
    } catch (error) {
      if (rlsProbeFailure(error) === 'definitive') {
        logger.error('memory.rls.unavailable', { error: String(error).slice(0, 300) });
        break;
      }
      logger.warn('memory.rls.probeTransient', { attempt });
      if (attempt >= RLS_PROBE_ATTEMPTS) {
        throw new AppError(
          'UNAVAILABLE',
          'Memory is temporarily unavailable: the database could not be reached. Try again shortly.',
          'الذاكرة غير متاحة مؤقتًا: تعذّر الوصول إلى قاعدة البيانات. حاول مجددًا بعد قليل.',
          { reason: 'infra_unavailable', transient: true },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, PROBE_BACKOFF_MS[attempt - 1] ?? PROBE_BACKOFF_MS.at(-1)));
    }
  }
  const ok = result && result.role === RUN_ROLE && !result.bypass && !result.superuser && result.rls === true && result.row_security !== 'off';
  if (!ok) {
    logger.error('memory.rls.notEnforced', { probe: result ?? null, tables: MEMORY_TABLES });
    throw new AppError(
      'UNAVAILABLE',
      'Memory is unavailable: the database cannot enforce its access policies.',
      'الذاكرة غير متاحة: لا تستطيع قاعدة البيانات فرض سياسات الوصول الخاصة بها.',
      { reason: 'rls_unavailable' },
    );
  }
  verified = true;
}

/** Runs `work` as `userId` under the restricted role, in one transaction. Only memory-table statements belong inside. */
export async function withMemoryScope<T>(userId: string, work: (tx: MemoryTx) => Promise<T>): Promise<T> {
  if (!userId) throw new AppError('UNAUTHORIZED', 'You need to log in.', 'تحتاج إلى تسجيل الدخول.');
  await assertMemoryRlsEnforced();
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${RUN_ROLE}`));
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return work(tx);
  });
}
