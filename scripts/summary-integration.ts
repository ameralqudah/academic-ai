/**
 * Thread summaries against PostgreSQL (P1-E, PR #4).
 *
 *   DATABASE_URL=…/academic_ai_test npm run db:migrate && npm run db:seed
 *   DATABASE_URL=…/academic_ai_test npm run test:summary:db
 *
 * Generation (cadence, internal-step metering, the idempotency key, duplicate
 * prevention, the numeric guard, ownership, quota refusal, deletion safety)
 * and use in Context V2 (no overlap with shown turns, chronological order,
 * fail-safe reads), the routed provider's TokenCounter, and v1 unchanged with
 * the flag off. A scripted model; no network.
 */

import 'dotenv/config';

import { readFileSync } from 'node:fs';

import { and, eq } from 'drizzle-orm';

import { resetEnvCache } from '@/config/env';
import { productionDeps, setGatewayForTests } from '@/server/ai/gateway';
import { FakeAdapter } from '@/server/ai/gateway/adapters/fake';
import { GatewayError } from '@/server/ai/gateway/errors';
import { createGateway } from '@/server/ai/gateway/gateway';
import { buildContextPrompt } from '@/server/context/manager';
import { registerTokenCounter, type TokenCounter } from '@/server/context/token-count';
import { buildContextV2 } from '@/server/context/v2/assembler';
import { hasClaimToken, UNRESOLVED_CLAIM_MARKER } from '@/server/context/v2/claims';
import { refreshThreadSummary, summaryKey, KEEP_RECENT, SUMMARY_EVERY } from '@/server/context/v2/summaries';
import { SUMMARY_HEADING } from '@/server/context/v2/summary-context';
import { db } from '@/server/db';
import { dispatchThreadSummary } from '@/server/jobs/dispatch';
import { QUEUES, stopQueue } from '@/server/jobs/queue';
import { startJobWorkers } from '@/server/jobs/worker';
import { aiConversations, aiQuotaReservations, aiUsageEvents, analysisRuns, datasets, threadSummaries } from '@/server/db/schema';
import * as graph from '@/server/graph/service';
import { QUARANTINE_MARKER } from '@/server/integrity/numbers';
import { setMemoryRlsProbeForTests } from '@/server/memory/db-scope';
import * as conversationsRepo from '@/server/repositories/conversations.repository';
import * as projectsRepo from '@/server/repositories/projects.repository';
import { register } from '@/server/services/account.service';
import { recordTurn } from '@/server/services/chat.service';

const RUN = `sum-${Date.now()}`;
let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

function setFlags(flags: { v2?: boolean; graph?: boolean }) {
  process.env.FF_CONTEXT_V2 = flags.v2 ? 'true' : 'false';
  process.env.FF_GRAPH = flags.graph ? 'true' : 'false';
  process.env.FF_RUNS = 'false';
  resetEnvCache();
}

const perChar: TokenCounter = { provider: 'estimate', exact: true, count: (text) => text.length };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const base = Date.parse('2026-10-01T10:00:00Z');

async function main() {
  process.env.OPENAI_API_KEY = 'placeholder-for-the-scripted-model';
  process.env.JOB_RUNNER = 'direct';
  setFlags({});
  const fake = new FakeAdapter('openai');
  const deps = { ...productionDeps, adapters: () => ({ openai: fake }), models: async () => ({ configured: [{ provider: 'openai' as const, model: 'gpt-4.1' }], defaultProvider: 'openai' as const, siblings: {} }) };
  setGatewayForTests(createGateway(deps));

  const user = async (name: string) =>
    (await register({ name, email: `${RUN}-${name}@example.test`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123', locale: 'en' })).id;
  const owner = await user('owner');
  const stranger = await user('stranger');
  const project = await projectsRepo.create({ userId: owner, title: 'Summary project', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });

  /** A conversation with `count` messages, alternating user and assistant, one minute apart. */
  const conversationWith = async (count: number, content: (n: number) => string = (n) => `said ${n}: message number ${n}`) => {
    const conversation = (await db.insert(aiConversations).values({ userId: owner, projectId: project.id, scope: 'PROJECT', title: `c-${count}` }).returning())[0]!;
    const ids: string[] = [];
    for (let n = 1; n <= count; n += 1) {
      const message = await conversationsRepo.addMessage({ conversationId: conversation.id, role: n % 2 ? 'USER' : 'ASSISTANT', content: content(n), createdAt: new Date(base + n * 60_000) });
      ids.push(message.id);
    }
    return { id: conversation.id, ids };
  };
  const rows = (conversationId: string) => db.select().from(threadSummaries).where(eq(threadSummaries.conversationId, conversationId));
  const reservation = (key: string) => db.select().from(aiQuotaReservations).where(and(eq(aiQuotaReservations.userId, owner), eq(aiQuotaReservations.idempotencyKey, key)));

  /* ------------------------------------------------------------------ */
  console.log('\nflag gating: with FF_CONTEXT_V2 off nothing is generated or read');
  const due = await conversationWith(20);
  const callsBefore = fake.calls.length;
  check('refresh with the flag off is disabled: no model call, no row', [(await refreshThreadSummary({ userId: owner, conversationId: due.id })).outcome, fake.calls.length - callsBefore, (await rows(due.id)).length], ['disabled', 0, 0]);
  const hooked = await conversationWith(18);
  await recordTurn({ conversationId: hooked.id, userId: owner, userMessage: 'said 19: more', assistantMessage: 'said 20: reply' });
  await wait(300);
  check('a recorded turn schedules nothing with the flag off', [(await rows(hooked.id)).length, fake.calls.length - callsBefore], [0, 0]);

  /* ------------------------------------------------------------------ */
  console.log('\ncadence, metering and the idempotency key');
  setFlags({ v2: true });
  const short = await conversationWith(SUMMARY_EVERY + KEEP_RECENT - 1);
  check(`fewer than ${SUMMARY_EVERY} messages older than the ${KEEP_RECENT} most recent: not due, no model call`, [(await refreshThreadSummary({ userId: owner, conversationId: short.id })).outcome, fake.calls.length - callsBefore], ['not_due', 0]);

  fake.push({ reply: { text: 'The user and the assistant discussed messages one to fourteen.', usage: { inputTokens: 321, outputTokens: 45, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false } } });
  const first = await refreshThreadSummary({ userId: owner, conversationId: due.id });
  const [v1] = await rows(due.id);
  check('due: version 1 is written, through the last message older than the recent ones', [first, v1?.version, v1?.throughMessageId === due.ids[20 - KEEP_RECENT - 1], v1?.messageCount], [{ outcome: 'written', version: 1, quarantined: 0 }, 1, true, 20 - KEEP_RECENT]);
  const sent = fake.calls.at(-1)!;
  const sentText = JSON.stringify(sent.request.messages);
  check('the model saw the older messages only, never the recent ones', [sentText.includes('said 14:'), sentText.includes('said 15:'), sentText.includes('said 20:')], [true, false, false]);
  check('it was routed by the router (no model requested), as purpose thread.summary', [sent.request.requested ?? null, sent.request.purpose, sent.model], [null, 'thread.summary', 'gpt-4.1']);
  const [held] = await reservation(summaryKey(due.id, 1));
  check(`metered as an internal step under ${summaryKey('{conversation}', 1)}: committed, no request, no words`, [held?.status, held?.requests, held?.words], ['committed', 0, 0]);
  const usage = await db.select().from(aiUsageEvents).where(and(eq(aiUsageEvents.userId, owner), eq(aiUsageEvents.purpose, 'thread.summary')));
  check('… and its tokens are on the usage ledger', [usage.length, usage[0]?.inputTokens, usage[0]?.outputTokens], [1, 321, 45]);

  /* ------------------------------------------------------------------ */
  console.log('\nno duplicate summary, never charged twice');
  const again = fake.calls.length;
  check('refreshing again with nothing new is not due: no call, still one row', [(await refreshThreadSummary({ userId: owner, conversationId: due.id })).outcome, fake.calls.length - again, (await rows(due.id)).length], ['not_due', 0, 1]);
  await db.delete(threadSummaries).where(eq(threadSummaries.conversationId, due.id));
  const charged = fake.calls.length;
  check('a version whose call was already charged is never called again (its key is refused before the model)', [(await refreshThreadSummary({ userId: owner, conversationId: due.id })).outcome, fake.calls.length - charged, (await rows(due.id)).length], ['duplicate', 0, 0]);

  const race = await conversationWith(20);
  const raceModel = new FakeAdapter('openai', [{ reply: { text: 'Race summary A.' }, delayMs: 150 }, { reply: { text: 'Race summary B.' }, delayMs: 150 }]);
  setGatewayForTests(createGateway({ ...deps, adapters: () => ({ openai: raceModel }) }));
  const raced = await Promise.all([refreshThreadSummary({ userId: owner, conversationId: race.id }), refreshThreadSummary({ userId: owner, conversationId: race.id })]);
  setGatewayForTests(createGateway(deps));
  const raceRows = await rows(race.id);
  check('two refreshes at once write one version 1, the other finds it taken', [raceRows.length, raceRows[0]?.version, raced.map((result) => result.outcome).sort()], [1, 1, ['duplicate', 'written']]);
  const staggered = await conversationWith(20);
  const slowFast = new FakeAdapter('openai', [{ reply: { text: 'Slow summary.' }, delayMs: 400 }, { reply: { text: 'Fast summary.' } }]);
  setGatewayForTests(createGateway({ ...deps, adapters: () => ({ openai: slowFast }) }));
  const slow = refreshThreadSummary({ userId: owner, conversationId: staggered.id });
  await wait(80);
  const fast = await refreshThreadSummary({ userId: owner, conversationId: staggered.id });
  const late = await slow;
  setGatewayForTests(createGateway(deps));
  const staggeredRows = await rows(staggered.id);
  check('a slow refresh that finishes after a faster one wrote its version is refused, not stored as a second version', [fast.outcome, late.outcome, staggeredRows.map((row) => row.version)], ['written', 'duplicate', [1]]);
  const [raceHeld] = await reservation(summaryKey(race.id, 1));
  check('… and the shared key is one reservation, committed once', [raceHeld?.status, (await reservation(summaryKey(race.id, 1))).length], ['committed', 1]);

  /* ------------------------------------------------------------------ */
  console.log('\nthe numeric guard: no unverified research number enters a summary');
  const [dataset] = await db.insert(datasets).values({ userId: owner, originalName: 'survey.csv', storageKey: `${RUN}/survey.csv` }).returning();
  const numbers = await conversationWith(20, (n) => (n === 1 ? 'said 1: my sample is N = 250 students' : `said ${n}: message ${n}`));
  await db.insert(analysisRuns).values({ userId: owner, datasetId: dataset!.id, projectId: project.id, conversationId: numbers.id, testKey: 'correlation', spec: {}, result: { estimate: 0.52, p: 0.003 } });
  fake.push({ reply: { text: 'With N = 250, the correlation was r = 0.52 (p = .003); the effect was b = 0.71 and 63.5% agreed.' } });
  const guarded = await refreshThreadSummary({ userId: owner, conversationId: numbers.id });
  const [guardedRow] = await rows(numbers.id);
  check('numbers the analyses produced and the user stated are kept', [guardedRow?.summary.includes('N = 250'), guardedRow?.summary.includes('0.52'), guardedRow?.summary.includes('.003')], [true, true, true]);
  check('untraced numbers are quarantined with the visible marker, never stored', [guardedRow?.summary.includes('0.71'), guardedRow?.summary.includes('63.5'), guardedRow?.summary.includes(QUARANTINE_MARKER.en), (guarded as { quarantined?: number }).quarantined], [false, false, true, 2]);
  check('… and the guard is recorded with the summary', [(guardedRow?.model as { guardVersion?: string } | null)?.guardVersion !== undefined, (guardedRow?.model as { quarantined?: number } | null)?.quarantined], [true, 2]);

  /* ------------------------------------------------------------------ */
  console.log('\nownership, quota and deletion');
  const strangers = fake.calls.length;
  check('another user cannot have a conversation summarised: not found, no model call', [(await refreshThreadSummary({ userId: stranger, conversationId: due.id })).outcome, fake.calls.length - strangers], ['not_found', 0]);
  const refusing = createGateway({
    ...deps,
    quota: { ...deps.quota, reserve: async () => { throw new GatewayError('quota', 'Used up.'); } },
  });
  setGatewayForTests(refusing);
  const quotaConversation = await conversationWith(20);
  const quotaCalls = fake.calls.length;
  check('a refused reservation means no model call and no summary', [(await refreshThreadSummary({ userId: owner, conversationId: quotaConversation.id })).outcome, fake.calls.length - quotaCalls, (await rows(quotaConversation.id)).length], ['refused', 0, 0]);
  setGatewayForTests(createGateway(deps));
  const doomed = await conversationWith(20);
  fake.push({ reply: { text: 'A summary that arrives too late.' }, delayMs: 200 });
  const pending = refreshThreadSummary({ userId: owner, conversationId: doomed.id });
  await wait(50);
  await db.delete(aiConversations).where(eq(aiConversations.id, doomed.id));
  check('a conversation deleted while its summary is generated: nothing is written, nothing crashes', [(await pending).outcome, (await rows(doomed.id)).length], ['refused', 0]);

  /* ------------------------------------------------------------------ */
  console.log('\nthe summary in Context V2');
  const long = await conversationWith(20);
  fake.push({ reply: { text: 'Earlier, messages one to fourteen covered the design.' } });
  await refreshThreadSummary({ userId: owner, conversationId: long.id });
  const turnOrder = (prompt: string) => [...prompt.matchAll(/(?:User|Assistant): said (\d+)/g)].map((match) => Number(match[1]));
  const lineLength = 'Assistant: said 20: message number 20'.length;
  const tight = await buildContextV2({ purpose: 'answer', request: 'x', userId: owner, conversationId: long.id, projectId: project.id, locale: 'en', counter: perChar, maxTokens: 400 + (lineLength * 4 + 200) * 2 });
  const shown = turnOrder(tight.prompt);
  const throughNumber = 20 - KEEP_RECENT;
  check('turns had to be dropped, so the summary stands in for them', [tight.envelope.summary !== undefined, tight.prompt.includes(SUMMARY_HEADING.en)], [true, true]);
  check('no turn the summary covers is shown (no overlap)', shown.every((n) => n > throughNumber), true);
  check('the turns shown stay chronological and are the newest', [shown, shown.at(-1)], [[...shown].sort((a, b) => a - b), 20]);
  check('the summary comes before the turns, inside the conversation block', tight.prompt.indexOf(SUMMARY_HEADING.en) < tight.prompt.indexOf(`said ${shown[0]}:`), true);
  check('it is model-generated (not evidence), measured by the counter', [tight.envelope.summary?.authority, tight.envelope.summary?.tokens === perChar.count(tight.envelope.summary?.content ?? '')], ['model-generated', true]);
  const roomy = await buildContextV2({ purpose: 'answer', request: 'x', userId: owner, conversationId: long.id, projectId: project.id, locale: 'en', counter: perChar, maxTokens: 50_000 });
  check('when every turn fits, the turns are shown verbatim and the summary is left out', [roomy.envelope.summary === undefined, turnOrder(roomy.prompt)], [true, Array.from({ length: 20 }, (_, i) => i + 1)]);

  const huge = await conversationWith(40);
  /* A summary through message 10, older than the 20 messages the context loads. */
  await db.insert(threadSummaries).values({ conversationId: huge.id, userId: owner, version: 1, summary: 'The first part of a long conversation.', throughMessageId: huge.ids[9]!, messageCount: 10 });
  const hugeRoomy = await buildContextV2({ purpose: 'answer', request: 'x', userId: owner, conversationId: huge.id, projectId: project.id, locale: 'en', counter: perChar, maxTokens: 50_000 });
  check('a summary of history older than every loaded turn is included, repeating nothing shown', [hugeRoomy.envelope.summary !== undefined, turnOrder(hugeRoomy.prompt)[0], turnOrder(hugeRoomy.prompt).length], [true, 21, 20]);
  check('the stranger never sees the owner’s summary', (await buildContextV2({ purpose: 'answer', request: 'x', userId: stranger, conversationId: long.id, locale: 'en', counter: perChar, maxTokens: 400 })).envelope.summary, undefined);

  const me = { userId: owner };
  setFlags({ v2: true, graph: true });
  const claim = await graph.createNode(project.id, me, { type: 'claim', data: { text: 'Trust predicts adoption in prior work.' } });
  setFlags({ v2: true });
  const claimed = await conversationWith(20);
  fake.push({ reply: { text: `They discussed {{claim:${claim.id}}} and {{claim:00000000-0000-4000-8000-000000000000}}.` } });
  await refreshThreadSummary({ userId: owner, conversationId: claimed.id });
  const claimContext = await buildContextV2({ purpose: 'answer', request: 'x', userId: owner, conversationId: claimed.id, projectId: project.id, locale: 'en', counter: perChar, maxTokens: 400 + (lineLength * 4 + 200) * 2 });
  check('claim references in a summary follow the claim rules: text or the marker, never raw', [claimContext.prompt.includes('They discussed Trust predicts adoption in prior work.'), claimContext.prompt.includes(UNRESOLVED_CLAIM_MARKER.en), hasClaimToken(claimContext.prompt)], [true, true, false]);

  setMemoryRlsProbeForTests(() => async () => { throw Object.assign(new Error('role "academic_app" does not exist'), { code: '42704' }); });
  const unsafe = await buildContextV2({ purpose: 'answer', request: 'x', userId: owner, conversationId: long.id, projectId: project.id, locale: 'en', counter: perChar, maxTokens: 400 + (lineLength * 4 + 200) * 2 });
  setMemoryRlsProbeForTests(null);
  check('if RLS cannot be enforced, there is no summary and the context still builds deterministically', [unsafe.envelope.summary, turnOrder(unsafe.prompt).at(-1), unsafe.prompt.includes('Project snapshot:')], [undefined, 20, true]);

  /* ------------------------------------------------------------------ */
  console.log('\nthe hook, the routed counter, and v1 unchanged');
  const hookedOn = await conversationWith(18);
  fake.push({ reply: { text: 'Summary written after a recorded turn.' } });
  await recordTurn({ conversationId: hookedOn.id, userId: owner, userMessage: 'said 19: more', assistantMessage: 'said 20: reply' });
  for (let attempt = 0; attempt < 30 && (await rows(hookedOn.id)).length === 0; attempt += 1) await wait(100);
  check('with the flag on, a recorded turn refreshes the summary in the background', (await rows(hookedOn.id))[0]?.version, 1);

  registerTokenCounter('openai', { provider: 'openai', exact: true, count: () => 7 });
  const routed = await buildContextPrompt({ purpose: 'answer', request: 'x', userId: owner, conversationId: long.id, locale: 'en', tokenProvider: 'openai' });
  const unrouted = await buildContextPrompt({ purpose: 'answer', request: 'x', userId: owner, conversationId: long.id, locale: 'en' });
  check('the routed provider’s counter measures the budget; without one, the estimate does', [(routed.envelope.turns ?? []).every((turn) => turn.tokens === 7), (unrouted.envelope.turns ?? []).every((turn) => turn.tokens === 7)], [true, false]);
  registerTokenCounter('openai', null);

  setFlags({});
  const v1Before = await buildContextPrompt({ purpose: 'answer', request: 'x', userId: owner, conversationId: short.id, projectId: project.id, locale: 'en', tokenProvider: 'openai' });
  await db.insert(threadSummaries).values({ conversationId: short.id, userId: owner, version: 1, summary: 'A summary v1 must ignore.', throughMessageId: short.ids[2]!, messageCount: 3 });
  const v1After = await buildContextPrompt({ purpose: 'answer', request: 'x', userId: owner, conversationId: short.id, projectId: project.id, locale: 'en' });
  check('with FF_CONTEXT_V2 off, the v1 prompt is byte-for-byte the same with a summary present and a provider passed', [v1After.prompt === v1Before.prompt, v1After.prompt.includes('A summary v1 must ignore'), v1After.envelope.summary], [true, false, undefined]);

  /* ------------------------------------------------------------------ */
  console.log('\nthe queue path (JOB_RUNNER=inline, as in production)');
  setFlags({ v2: true });
  const queueSource = readFileSync('src/server/jobs/queue.ts', 'utf8');
  check('every queue the code sends to or works on is created first', Object.keys(QUEUES).filter((key) => !queueSource.includes(`createQueue(QUEUES.${key}`)), []);
  process.env.JOB_RUNNER = 'inline';
  check('the job workers start with the summary queue registered', await startJobWorkers({ taskConcurrency: 1, analysisConcurrency: 1 }), true);
  const queued = await conversationWith(20);
  fake.push({ reply: { text: 'Summary written by the queue worker.' } });
  await dispatchThreadSummary(queued.id, owner);
  for (let attempt = 0; attempt < 60 && (await rows(queued.id)).length === 0; attempt += 1) await wait(250);
  check('a queued refresh is picked up by the worker and written once', (await rows(queued.id)).map((row) => [row.version, row.summary]), [[1, 'Summary written by the queue worker.']]);
  await stopQueue();
  process.env.JOB_RUNNER = 'direct';

  setGatewayForTests(null);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await stopQueue().catch(() => undefined);
  process.exit(1);
});
