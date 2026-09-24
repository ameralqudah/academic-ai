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
 * the run engine refuses to start (UNAVAILABLE, `rls_unavailable`). It never
 * falls back to running with application checks alone. A probe that could not
 * reach the database at all (connection, timeout, availability) proves
 * nothing either way: it is retried a bounded number of times and then
 * refused as `infra_unavailable` — still refused, but never recorded as RLS
 * being off.
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

export interface RlsProbe {
  role: string;
  bypass: boolean;
  superuser: boolean;
  rls: boolean | null;
  row_security: string;
}

/**
 * Failures that say nothing about RLS: the database could not be reached or
 * could not answer now. Driver codes (postgres.js, Node sockets) and SQLSTATEs
 * of class 08 (connection exception) and 53 (insufficient resources, e.g. too
 * many connections), shutdown/cannot-connect-now, a cancelled statement
 * (statement timeout), and lock/serialisation conflicts. Anything else —
 * including a missing role (42704), a role that may not be taken (42501), and
 * any error without a recognised code — is definitive, as before.
 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '57P01',
  '57P02',
  '57P03',
  '57014',
  '55P03',
  '40001',
  '40P01',
]);
const TRANSIENT_SQLSTATE_CLASSES = ['08', '53'];

/** The first error code in the chain (drizzle wraps the driver's error as `cause`). */
function errorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Whether a probe that threw may succeed on a retry (`transient`), or proves RLS cannot be enforced (`definitive`). */
export function rlsProbeFailure(error: unknown): 'transient' | 'definitive' {
  const code = errorCode(error);
  if (!code) return 'definitive';
  if (TRANSIENT_CODES.has(code)) return 'transient';
  if (/^[0-9A-Z]{5}$/.test(code) && TRANSIENT_SQLSTATE_CLASSES.includes(code.slice(0, 2))) return 'transient';
  return 'definitive';
}

/** Probe attempts before a transient failure is reported, and the waits between them. */
export const RLS_PROBE_ATTEMPTS = 3;
const RLS_PROBE_BACKOFF_MS = [250, 1_000];

async function probeRls(): Promise<RlsProbe | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${RUN_ROLE}`));
    const rows = await tx.execute(sql`
      select current_user as role, r.rolbypassrls as bypass, r.rolsuper as superuser,
             (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname in ('research_runs', 'run_steps', 'run_approvals', 'run_events')) as rls,
             current_setting('row_security') as row_security
      from pg_roles r where r.rolname = current_user`);
    return (rows as unknown as RlsProbe[])[0];
  });
}

let probe: () => Promise<RlsProbe | undefined> = probeRls;

/** For tests: wrap or replace the probe (e.g. to inject a connection failure). `null` restores it. */
export function setRlsProbeForTests(wrap: ((real: () => Promise<RlsProbe | undefined>) => () => Promise<RlsProbe | undefined>) | null): void {
  probe = wrap ? wrap(probeRls) : probeRls;
  verified = false;
}

/**
 * Proves the database enforces RLS for the run role; throws UNAVAILABLE
 * otherwise. Cached once proven.
 * - Definitive (`rls_unavailable`): the probe answered and RLS is not
 *   enforced, or it failed in a way a retry cannot change. Fail closed.
 * - Transient (`infra_unavailable`): the database could not be reached,
 *   `RLS_PROBE_ATTEMPTS` times with backoff. Also refused (nothing runs
 *   unproven), but it claims nothing about RLS, and nothing is cached.
 */
export async function assertRlsEnforced(): Promise<void> {
  if (verified) return;
  let result: RlsProbe | undefined;
  for (let attempt = 1; ; attempt += 1) {
    try {
      result = await probe();
      break;
    } catch (error) {
      if (rlsProbeFailure(error) === 'definitive') {
        logger.error('runs.rls.unavailable', { error: String(error).slice(0, 300) });
        break;
      }
      logger.warn('runs.rls.probeTransient', { attempt, code: errorCode(error) });
      if (attempt >= RLS_PROBE_ATTEMPTS) {
        throw new AppError(
          'UNAVAILABLE',
          'Research runs are temporarily unavailable: the database could not be reached. Try again shortly.',
          'عمليات البحث غير متاحة مؤقتًا: تعذّر الوصول إلى قاعدة البيانات. حاول مجددًا بعد قليل.',
          { reason: 'infra_unavailable', transient: true },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, RLS_PROBE_BACKOFF_MS[attempt - 1] ?? RLS_PROBE_BACKOFF_MS.at(-1)));
    }
  }
  const ok = result && result.role === RUN_ROLE && !result.bypass && !result.superuser && result.rls === true && result.row_security !== 'off';
  if (!ok) {
    logger.error('runs.rls.notEnforced', { probe: result ?? null, tables: RUN_TABLES });
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
 * run then does happens in `withRunScope` as that user. It writes in exactly
 * two places, both terminal and both in the store (a smoke gate checks this):
 * the fail-closed `rls_unavailable` stop, and settling a run whose owner can
 * no longer edit its project.
 */
export const systemDb = db;
