/**
 * Model Gateway against PostgreSQL (P1-B). Real plans, quota ledger,
 * reservations, usage events, tool-call records, request scope and project
 * authorisation; scripted provider adapters (no network, no keys).
 *
 *   DATABASE_URL=postgresql://…/academic_ai_test npm run db:migrate && npm run db:seed
 *   DATABASE_URL=postgresql://…/academic_ai_test npm run test:gateway:db
 *
 * Letters refer to the test areas of the P1-B brief.
 */

import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { resolveProvider } from '@/ai/registry';
import { resetEnvCache } from '@/config/env';
import { db } from '@/server/db';
import { aiQuotaReservations, aiToolCalls, aiUsageEvents, usageTracking } from '@/server/db/schema';
import { forgetPlan, productionDeps, recordToolExecution, setGatewayForTests } from '@/server/ai/gateway';
import { FakeAdapter } from '@/server/ai/gateway/adapters/fake';
import { GatewayError, toAppError } from '@/server/ai/gateway/errors';
import { createGateway, type GatewayDeps } from '@/server/ai/gateway/gateway';
import { commit, RECOVERED_WORDS_PER_TOKEN, reserve, settleExpired } from '@/server/ai/gateway/quota';
import { defineTool } from '@/server/ai/gateway/tools';
import { requirementsFor, selectModel } from '@/server/ai/model-router';
import { runForUser, withCallIds } from '@/server/ai/request-scope';
import { AppError } from '@/server/http/errors';
import * as plansRepo from '@/server/repositories/plans.repository';
import * as projectsRepo from '@/server/repositories/projects.repository';
import { periodKeyFor } from '@/server/repositories/usage.repository';
import { register } from '@/server/services/account.service';

const RUN = `gw-${Date.now()}`;
let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         expected ${JSON.stringify(expected)}\n         got      ${JSON.stringify(actual)}`}`);
}
async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    if (error instanceof GatewayError) return `gateway:${error.errorClass}`;
    if (error instanceof AppError) return error.code;
    return `other:${String(error).slice(0, 120)}`;
  }
}

const CLAUDE = { provider: 'anthropic' as const, model: 'claude-sonnet-5' };
const GEMINI = { provider: 'google' as const, model: 'gemini-2.5-pro' };

async function main() {
  resetEnvCache();

  const user = async (name: string) =>
    (await register({ name, email: `${RUN}-${name}@example.test`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123', locale: 'en' })).id;
  const free = await user('free');
  const paid = await user('paid');
  const racer = await user('racer');
  const stranger = await user('stranger');

  const top = await plansRepo.findTopPlan();
  if (!top) throw new Error('No paid plan seeded — run npm run db:seed.');
  const subscription = await plansRepo.ensureSubscription({ userId: paid, planId: top.id, status: 'ACTIVE', periodEnd: new Date(Date.now() + 30 * 86_400_000) });
  await plansRepo.updateSubscription(subscription.id, { planId: top.id, status: 'ACTIVE', periodEnd: new Date(Date.now() + 30 * 86_400_000) });

  const project = await projectsRepo.create({ userId: free, title: 'GW', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  const foreign = await projectsRepo.create({ userId: stranger, title: 'Theirs', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });

  /** Production dependencies (real plans, quota, meter, scope, project checks) with scripted adapters. */
  const claude = new FakeAdapter('anthropic');
  const gemini = new FakeAdapter('google');
  const deps: GatewayDeps = {
    ...productionDeps,
    adapters: () => ({ anthropic: claude, google: gemini }),
    models: async () => ({ configured: [CLAUDE, GEMINI], defaultProvider: 'anthropic', siblings: {} }),
    clock: { ...productionDeps.clock, sleep: async () => undefined },
  };
  const gw = createGateway(deps);
  setGatewayForTests(gw);

  const ask = (text = 'Hello', extra: Record<string, unknown> = {}) => ({ purpose: 'chat', messages: [{ role: 'user' as const, content: text }], needsReasoning: true, ...extra });
  const events = (userId: string) => db.select().from(aiUsageEvents).where(eq(aiUsageEvents.userId, userId));
  const ledger = async (userId: string) => {
    const rows = await db.select().from(usageTracking).where(and(eq(usageTracking.userId, userId), eq(usageTracking.metric, 'AI_REQUEST')));
    return { rows: rows.length, requests: rows.reduce((sum, row) => sum + row.amount, 0) };
  };

  /* ------------------------------------------------------------------ */
  console.log('\nL/M. Plan propagation and premium protection');
  {
    const r = await runForUser(free, () => gw.generate(ask('reason about this')));
    check('a free user is routed off the premium model, even for reasoning work', [r.provider, r.routing.tier], ['google', 'free']);
    const p = await runForUser(paid, () => gw.generate(ask('reason about this')));
    check('a paid user gets the premium model for reasoning work', [p.provider, p.routing.tier], ['anthropic', 'paid']);

    /* A worker has no request: only the user id travels (task/job row), and the plan is looked up again. */
    const worker = await runForUser(free, () => withCallIds({ jobId: `${RUN}-job`, taskId: null }, () => gw.generate(ask('from a worker'))));
    const [row] = await db.select().from(aiUsageEvents).where(eq(aiUsageEvents.jobId, `${RUN}-job`));
    check('in a worker the plan is resolved from the user id: still not premium', [worker.provider, row?.modelClass, row?.userId === free], ['google', 'standard', true]);

    const before = (await events(free)).length;
    check('a call outside any user scope is refused, never routed as anonymous', await outcome(() => gw.generate(ask())), 'gateway:internal');
    check('… and leaves no usage row', (await events(free)).length, before);

    check(
      'a free user naming the premium model is refused (defence in depth over the model picker)',
      await runForUser(free, () => outcome(() => gw.generate(ask('x', { requested: CLAUDE })))),
      'gateway:entitlement',
    );
    claude.push({ fail: new GatewayError('outage', 'down', { provider: 'anthropic' }) });
    const failedOver = await runForUser(paid, () => gw.generate(ask('x')));
    check('a paid user’s failover stays within the plan', failedOver.provider, 'google');
    gemini.push({ fail: new GatewayError('outage', 'down', { provider: 'google' }) }, { fail: new GatewayError('outage', 'down', { provider: 'google' }) }, { fail: new GatewayError('outage', 'down', { provider: 'google' }) });
    const claudeBefore = claude.calls.length;
    check('a free user’s failed call never fails over to the premium model', [await runForUser(free, () => outcome(() => gw.generate(ask('x')))), claude.calls.length - claudeBefore], ['gateway:outage', 0]);

    /* The alternate entry points: the router (tools, handlers), the resolver (config check), the planner path. */
    const viaRouter = await runForUser(free, async () => (await selectModel(requirementsFor({ capability: 'literature.review' }))).provider.complete({ task: 'chat', locale: 'en', system: '', messages: [{ role: 'user', content: 'x' }] }));
    const viaResolver = await runForUser(free, async () => (await resolveProvider()).complete({ task: 'chat', locale: 'en', system: '', messages: [{ role: 'user', content: 'x' }] }));
    check('no alternate path reaches the premium model for a free user (router, resolver)', [viaRouter.provider, viaResolver.provider], ['google', 'google']);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nL/M. A deployment whose only model is premium');
  {
    const premiumOnly = createGateway({ ...deps, models: async () => ({ configured: [CLAUDE], defaultProvider: 'anthropic', siblings: {} }) });
    const u = await user('premium-only');
    const claudeBefore = claude.calls.length;
    let publicError: AppError | null = null;
    const refused = await runForUser(u, () =>
      outcome(async () => {
        try {
          await premiumOnly.generate(ask('x'));
        } catch (error) {
          if (error instanceof GatewayError) publicError = toAppError(error);
          throw error;
        }
      }),
    );
    const reservations = await db.select().from(aiQuotaReservations).where(eq(aiQuotaReservations.userId, u));
    check(
      'a free user is refused (no eligible model), and nothing is sent, reserved or counted',
      [refused, claude.calls.length - claudeBefore, reservations.length, (await events(u)).length, (await ledger(u)).requests],
      ['gateway:entitlement', 0, 0, 0, 0],
    );
    const shown = publicError as AppError | null;
    check('the user is told why, in both languages, with the upgrade path', [shown?.code, shown?.message.includes('No AI model is available on your plan'), Boolean(shown?.messageAr)], ['PLAN_LIMIT', true, true]);
    const served = await runForUser(paid, () => premiumOnly.generate(ask('x')));
    check('a paid user on the same deployment is served by it', served.provider, 'anthropic');
  }

  /* ------------------------------------------------------------------ */
  console.log('\nI/J. Durable metering');
  {
    const u = await user('meter');
    const before = await ledger(u);
    await runForUser(u, () => withCallIds({ projectId: null }, () => gw.generate(ask('one'))));
    const after = await ledger(u);
    check('one logical call writes exactly one AI_REQUEST ledger row (no double count)', [after.rows - before.rows, after.requests - before.requests], [1, 1]);
    const [row] = await events(u);
    check('a durable usage row with tokens, cost, latency, status and routing', [row?.status, row?.inputTokens, (row?.costMicroUsd ?? 0) > 0, row?.currency, typeof row?.latencyMs, Boolean(row?.routing)], ['succeeded', 100, true, 'USD', 'number', true]);

    gemini.push({ fail: new GatewayError('outage', 'down', { provider: 'google' }) });
    const retried = await runForUser(u, () => gw.generate(ask('two', { needsReasoning: false, latencySensitive: true })));
    const call = await db.select().from(aiUsageEvents).where(eq(aiUsageEvents.callId, retried.callId));
    check('every attempt is recorded, with its retry count and error class', call.map((c) => [c.attempt, c.status, c.errorClass, c.retryCount]).sort(), [[1, 'failed', 'outage', 0], [2, 'succeeded', null, 1]]);

    gemini.push({ fail: new GatewayError('invalid_request', 'bad', { provider: 'google' }) });
    const failedCall = await runForUser(u, () => outcome(() => gw.generate(ask('three', { needsReasoning: false, latencySensitive: true }))));
    const failures = await db.select().from(aiUsageEvents).where(and(eq(aiUsageEvents.userId, u), eq(aiUsageEvents.status, 'failed'), eq(aiUsageEvents.errorClass, 'invalid_request')));
    check('a failed call leaves a durable row too', [failedCall, failures.length], ['gateway:invalid_request', 1]);
    check('… and its reservation is released, not counted', (await ledger(u)).requests - before.requests, 2);

    const internal = await runForUser(u, () => gw.generate(ask('four', { countsAsRequest: false })));
    const internalRow = (await db.select().from(usageTracking).where(and(eq(usageTracking.userId, u), eq(usageTracking.metric, 'AI_REQUEST')))).find((r) => r.amount === 0);
    check('an internal step is metered (tokens, cost) but not counted as a request', [Boolean(internal.callId), internalRow?.tokensIn, internalRow!.costMicroUsd > 0], [true, 100, true]);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nK/N. Quota enforcement and concurrent reservations');
  {
    const period = periodKeyFor();
    await db.insert(usageTracking).values({ userId: racer, periodKey: period, metric: 'AI_REQUEST', amount: 15 });
    /* Slow replies for the calls that get through, so all 20 overlap; unscripted calls answer 'ok' at once. */
    for (let i = 0; i < 5; i += 1) gemini.push({ reply: { text: 'ok' }, delayMs: 30 });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => runForUser(racer, () => outcome(() => gw.generate(ask(`race ${i}`, { needsReasoning: false, latencySensitive: true }))))),
    );
    const ok = results.filter((r) => r === 'ok').length;
    check('20 concurrent calls against 5 remaining requests: exactly 5 succeed', [ok, results.filter((r) => r === 'gateway:quota').length], [5, 15]);
    /*
     * The reservation itself, raced directly: the pool runs several transactions
     * at once, and without the per-user lock two of them read the same total and
     * both reserve (seen as 6–7 grants for 5 when the lock is removed).
     */
    const raced: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const target = await user(`race-${round}`);
      const settled = await Promise.allSettled(
        Array.from({ length: 30 }, () =>
          reserve({ userId: target, idempotencyKey: randomUUID(), requests: 1, words: 0, limits: { maxAiRequests: 5, maxGeneratedWords: 1_000_000 }, unlimited: () => false }),
        ),
      );
      raced.push(settled.filter((r) => r.status === 'fulfilled').length);
    }
    check('30 concurrent reservations against 5 remaining, five times: never more than 5', raced, [5, 5, 5, 5, 5]);
    check('the ledger ends exactly at the plan limit', (await ledger(racer)).requests, 20);
    check('the next call is refused with the plan limit', await runForUser(racer, () => outcome(() => gw.generate(ask('one more')))), 'gateway:quota');
    check(
      'an internal step at the limit is refused too (no classification of every message on a used-up plan)',
      await runForUser(racer, () => outcome(() => gw.generate(ask('classify', { countsAsRequest: false })))),
      'gateway:quota',
    );
    const continued = await runForUser(racer, () => outcome(() => gw.generate(ask('round 2', { countsAsRequest: false, continuation: true }))));
    check('a continuation round of an admitted call still runs at the limit, and is not counted', [continued, (await ledger(racer)).requests], ['ok', 20]);

    const u = await user('idem');
    await runForUser(u, () => gw.generate(ask('a', { idempotencyKey: 'task-1:step-2' })));
    const again = await runForUser(u, () => outcome(() => gw.generate(ask('a', { idempotencyKey: 'task-1:step-2' }))));
    const reservations = await db.select().from(aiQuotaReservations).where(eq(aiQuotaReservations.userId, u));
    check('a retried step with the same key reserves and counts once', [reservations.length, (await ledger(u)).requests], [1, 1]);
    check('WS4 G8: … and once its call has completed and been charged, the key is refused, before any provider is called', [again, (await events(u)).length], ['gateway:invalid_request', 1]);

    const w = await user('words');
    await db.insert(usageTracking).values({ userId: w, periodKey: period, metric: 'GENERATED_WORD', amount: 5000 });
    check('a plan whose words are used up refuses a generation, even with no estimate', await runForUser(w, () => outcome(() => gw.generate(ask('x')))), 'gateway:quota');

    const x = await user('expiry');
    await db.insert(aiQuotaReservations).values({ userId: x, periodKey: period, idempotencyKey: 'crashed-worker', requests: 20, words: 0, expiresAt: new Date(Date.now() - 1000) });
    check('a reservation left by a crashed worker stops counting at expiry', await runForUser(x, () => outcome(() => gw.generate(ask('x')))), 'ok');
    const swept = await settleExpired();
    const [stale] = await db.select().from(aiQuotaReservations).where(and(eq(aiQuotaReservations.userId, x), eq(aiQuotaReservations.idempotencyKey, 'crashed-worker')));
    check('and the reaper settles it: released, since it never reached a provider', [swept.released >= 1, stale?.status], [true, 'released']);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nWS4 G8. An idempotency key never buys an uncharged call');
  {
    const period = periodKeyFor();
    const u = await user('g8');
    const keyed = (key: string) => runForUser(u, () => outcome(() => gw.generate(ask('k', { idempotencyKey: key }))));
    check('a fresh key runs and is charged', [await keyed('g8-a'), (await ledger(u)).requests], ['ok', 1]);
    check('the same key after completion is refused, and nothing more is charged or sent', [await keyed('g8-a'), (await ledger(u)).requests, (await events(u)).length], ['gateway:invalid_request', 1, 1]);
    check('… however often it is asked', [await keyed('g8-a'), await keyed('g8-a'), (await ledger(u)).requests, (await events(u)).length], ['gateway:invalid_request', 'gateway:invalid_request', 1, 1]);
    await db.insert(aiQuotaReservations).values({ userId: u, periodKey: period, idempotencyKey: 'g8-inflight', requests: 1, words: 0, expiresAt: new Date(Date.now() + 60_000) });
    const [shared] = await db.select().from(aiQuotaReservations).where(and(eq(aiQuotaReservations.userId, u), eq(aiQuotaReservations.idempotencyKey, 'g8-inflight')));
    check('a key still reserved (a retry of unfinished work) shares that reservation, and is charged once when it completes', [await keyed('g8-inflight'), (await ledger(u)).requests, (await db.select().from(aiQuotaReservations).where(eq(aiQuotaReservations.id, shared!.id)))[0]?.status], ['ok', 2, 'committed']);
    await db.insert(aiQuotaReservations).values({ userId: u, periodKey: period, idempotencyKey: 'g8-released', requests: 1, words: 0, status: 'released', expiresAt: new Date(Date.now() - 60_000), settledAt: new Date() });
    check('a released key (it consumed nothing) is reserved afresh and charged', [await keyed('g8-released'), (await ledger(u)).requests], ['ok', 3]);
    check('the refusal is the plan-neutral invalid_request, not a quota error, and names the cause', await runForUser(u, () => gw.generate(ask('k', { idempotencyKey: 'g8-a' })).catch((error: GatewayError) => [error.errorClass, error.detail])), ['invalid_request', 'idempotency_key_committed']);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nWS4 G2. A failed settlement is retried, and never leaves provider usage unbilled');
  {
    const sleeps: number[] = [];
    const flaky = (failures: number) => {
      let left = failures;
      const tries: number[] = [];
      const gateway = createGateway({
        ...deps,
        clock: { ...deps.clock, sleep: async (ms: number) => void sleeps.push(ms) },
        quota: {
          ...deps.quota,
          commit: async (input) => {
            tries.push(1);
            if (left > 0) {
              left -= 1;
              throw new Error('database unavailable');
            }
            return deps.quota.commit(input);
          },
        },
      });
      return { gateway, tries };
    };
    const reservationsOf = (userId: string) => db.select().from(aiQuotaReservations).where(eq(aiQuotaReservations.userId, userId));

    const t = await user('g2-transient');
    const transient = flaky(1);
    check('a settlement that fails once is retried: the answer is delivered and charged at once', [await runForUser(t, () => outcome(() => transient.gateway.generate(ask('x')))), transient.tries.length, (await ledger(t)).requests, (await reservationsOf(t))[0]?.status], ['ok', 2, 1, 'committed']);

    const d = await user('g2-down');
    const down = flaky(99);
    gemini.push({ reply: { text: 'one two three four', usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false } } });
    const answer = await runForUser(d, () => outcome(() => down.gateway.generate(ask('x'))));
    const [held] = await reservationsOf(d);
    check('a settlement that keeps failing is tried three times, never fails the delivered answer, and leaves the reservation for the reaper', [answer, down.tries.length, (await ledger(d)).requests, held?.status], ['ok', 3, 0, 'reserved']);
    await db.update(aiQuotaReservations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiQuotaReservations.id, held!.id));
    const usageRows = await events(d);
    const swept = await settleExpired();
    const [settled] = await reservationsOf(d);
    const ledgerRows = await db.select().from(usageTracking).where(eq(usageTracking.userId, d));
    const requestRow = ledgerRows.find((row) => row.metric === 'AI_REQUEST');
    const wordRow = ledgerRows.find((row) => row.metric === 'GENERATED_WORD');
    check('at expiry the reaper commits it from the usage rows instead of releasing it', [swept.recovered >= 1, settled?.status], [true, 'committed']);
    check('… charging the request, the tokens and the cost the provider reported', [requestRow?.amount, requestRow?.tokensIn, requestRow?.tokensOut, requestRow?.costMicroUsd, requestRow?.provider], [1, usageRows[0]?.inputTokens, usageRows[0]?.outputTokens, usageRows.reduce((s, r) => s + r.costMicroUsd, 0), usageRows[0]?.provider]);
    check('… and words estimated from the output tokens (the text was never seen)', wordRow?.amount, Math.round(40 * RECOVERED_WORDS_PER_TOKEN));
    const again = await settleExpired();
    const late = await commit({ reservation: held!, countsAsRequest: true, outputText: 'one two three four', projectId: null, provider: 'google', model: 'x', tokensIn: 1, tokensOut: 1, costMicroUsd: 1 });
    check('sweeping again, or the call’s own late commit, never charges twice', [(await ledger(d)).requests, (await db.select().from(usageTracking).where(eq(usageTracking.userId, d))).length, late], [1, 2, false]);

    /* An attempt that consumed tokens but failed: charged its tokens and cost, never a request or words (as the call's own settlement would). */
    const f = await user('g2-failed');
    const [orphan] = await db.insert(aiQuotaReservations).values({ userId: f, periodKey: periodKeyFor(), idempotencyKey: 'g2-orphan', requests: 1, words: 0, expiresAt: new Date(Date.now() - 1000) }).returning();
    const routing = { tier: 'free', requested: null, chosen: { provider: 'google', model: 'gemini-2.5-pro', modelClass: 'standard' }, fallbacks: [], reason: 'test' };
    await db.insert(aiUsageEvents).values([
      { callId: 'g2-orphan-call', attempt: 1, userId: f, purpose: 'chat', kind: 'stream', provider: 'google', model: 'gemini-2.5-pro', modelClass: 'standard', status: 'failed', errorClass: 'network', inputTokens: 90, outputTokens: 30, totalTokens: 120, costMicroUsd: 77, reservationId: orphan!.id, routing },
      { callId: 'g2-orphan-call', attempt: 2, userId: f, purpose: 'chat', kind: 'stream', provider: 'google', model: 'gemini-2.5-pro', modelClass: 'standard', status: 'failed', errorClass: 'network', inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicroUsd: 0, reservationId: orphan!.id, routing },
    ]);
    await settleExpired();
    const failedRows = await db.select().from(usageTracking).where(eq(usageTracking.userId, f));
    check('a consumed but failed call is committed with its tokens and cost, and no request or words', [(await reservationsOf(f))[0]?.status, failedRows.map((r) => [r.metric, r.amount, r.tokensIn, r.tokensOut, r.costMicroUsd])], ['committed', [['AI_REQUEST', 0, 90, 30, 77]]]);

    const n = await user('g2-nothing');
    const [unused] = await db.insert(aiQuotaReservations).values({ userId: n, periodKey: periodKeyFor(), idempotencyKey: 'g2-nothing', requests: 1, words: 0, expiresAt: new Date(Date.now() - 1000) }).returning();
    await db.insert(aiUsageEvents).values({ callId: 'g2-nothing-call', attempt: 1, userId: n, purpose: 'chat', kind: 'generate', provider: 'google', model: 'gemini-2.5-pro', modelClass: 'standard', status: 'failed', errorClass: 'auth', reservationId: unused!.id, routing });
    await settleExpired();
    check('a call that reached no usage is released, as before, and nothing is charged', [(await reservationsOf(n))[0]?.status, (await db.select().from(usageTracking).where(eq(usageTracking.userId, n))).length], ['released', 0]);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nWS4 G6. Embeddings reserve, are refused on a used-up plan, and are committed');
  {
    const e = await user('g6');
    const out = await runForUser(e, () => gw.embed({ purpose: 'memory', inputs: ['alpha', 'beta'] }));
    const [row] = (await events(e)).filter((r) => r.kind === 'embed');
    const [held] = await db.select().from(aiQuotaReservations).where(eq(aiQuotaReservations.userId, e));
    const ledgerRows = await db.select().from(usageTracking).where(eq(usageTracking.userId, e));
    check('an embedding takes a real reservation, which its usage row names', [Boolean(out.callId), held?.idempotencyKey === out.callId, row?.reservationId === held?.id, held?.status], [true, true, true, 'committed']);
    check('… committed as an internal step: its tokens and cost, but no request and no words', ledgerRows.map((r) => [r.metric, r.amount, r.tokensIn]), [['AI_REQUEST', 0, 3]]);
    check('… so it does not use up the plan', (await ledger(e)).requests, 0);

    const full = await user('g6-full');
    await db.insert(usageTracking).values({ userId: full, periodKey: periodKeyFor(), metric: 'AI_REQUEST', amount: 20 });
    check('on a used-up plan an embedding is refused before the provider is called', [await runForUser(full, () => outcome(() => gw.embed({ purpose: 'memory', inputs: ['alpha'] }))), (await events(full)).length], ['gateway:quota', 0]);

    const broken = new FakeAdapter('google');
    broken.embed = async () => {
      throw new GatewayError('invalid_request', 'rejected');
    };
    const failing = createGateway({ ...deps, adapters: () => ({ anthropic: claude, google: broken }) });
    const b = await user('g6-broken');
    check('a failed embedding is released, and charges nothing', [await runForUser(b, () => outcome(() => failing.embed({ purpose: 'memory', inputs: ['alpha'] }))), (await db.select().from(aiQuotaReservations).where(eq(aiQuotaReservations.userId, b)))[0]?.status, (await db.select().from(usageTracking).where(eq(usageTracking.userId, b))).length], ['gateway:invalid_request', 'released', 0]);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nT. Cross-project isolation');
  {
    check(
      'a call naming another user’s project is refused',
      await runForUser(free, () => withCallIds({ projectId: foreign.id }, () => outcome(() => gw.generate(ask('x'))))),
      'NOT_FOUND',
    );
    check(
      '… also when the project is passed per call rather than in the scope',
      await runForUser(free, () => outcome(() => gw.generate(ask('x'), { ids: { projectId: foreign.id } }))),
      'NOT_FOUND',
    );
    await runForUser(free, () => gw.generate(ask('mine'), { ids: { projectId: project.id } }));
    const [row] = await db.select().from(aiUsageEvents).where(eq(aiUsageEvents.projectId, project.id));
    const [ledgerRow] = await db.select().from(usageTracking).where(and(eq(usageTracking.userId, free), eq(usageTracking.projectId, project.id)));
    check('usage is recorded against the right project', [row?.userId === free, ledgerRow?.projectId === project.id], [true, true]);
    check('no usage row ever names a project the user cannot see', (await db.select().from(aiUsageEvents).where(eq(aiUsageEvents.projectId, foreign.id))).length, 0);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nC/Q. Tool calls are recorded durably');
  {
    const search = defineTool('web_search', 'Search', z.object({ query: z.string().min(2) }));
    const write = defineTool('document_write', 'Write', z.object({ section: z.string() }));
    claude.push({
      reply: {
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'a', name: 'web_search', arguments: { query: 'trust' } },
          { id: 'b', name: 'web_search', arguments: { query: 'x' } },
          { id: 'c', name: 'document_write', arguments: { section: 's' } },
        ],
      },
    });
    const r = await runForUser(paid, () => withCallIds({ runId: 'run-9' }, () => gw.toolCall(ask('find'), { tools: [search, write], permittedTools: ['web_search'] })));
    const rows = await db.select().from(aiToolCalls).where(eq(aiToolCalls.callId, r.callId));
    check('validated and rejected calls are both recorded, with run and user', rows.map((row) => `${row.toolCallId}:${row.status}`).sort(), ['a:validated', 'b:rejected', 'c:rejected']);
    check('rejected calls keep the raw arguments and the reason, never as data', [rows.find((row) => row.toolCallId === 'c')?.arguments, rows.find((row) => row.toolCallId === 'c')?.error?.startsWith('not_permitted')], [null, true]);
    await recordToolExecution(r.toolCallRecords.a!, { status: 'succeeded', latencyMs: 42, resultSummary: { results: 3 } });
    const [done] = await db.select().from(aiToolCalls).where(eq(aiToolCalls.id, r.toolCallRecords.a!));
    check('the executor records the result, latency and success', [done?.status, done?.latencyMs, done?.runId, done?.userId === paid], ['succeeded', 42, 'run-9', true]);
  }

  /* ------------------------------------------------------------------ */
  console.log('\nE/O. Streaming through the facade, cancelled mid-stream');
  {
    const u = await user('stream');
    gemini.push({ stream: ['a', 'b', 'c', 'd', 'e'], delayMs: 25 });
    const controller = new AbortController();
    const provider = await runForUser(u, async () => (await selectModel(requirementsFor({ capability: 'general.answer' }))).provider);
    let received = '';
    const got = await runForUser(u, () =>
      outcome(async () => {
        for await (const chunk of provider.stream({ task: 'chat', locale: 'en', system: '', messages: [{ role: 'user', content: 'x' }], signal: controller.signal })) {
          received += chunk.delta;
          if (received.length >= 2) controller.abort();
        }
      }),
    );
    const [row] = await events(u);
    check('a disconnected stream is cancelled, and the attempt recorded with its usage so far', [got, row?.status, row?.usageEstimated, row!.outputTokens > 0], ['VALIDATION', 'cancelled', true, true]);
    check('what was delivered still counts against the plan', (await ledger(u)).requests, 1);
  }

  setGatewayForTests(null);
  forgetPlan();
  await db.execute(sql`select 1`);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
