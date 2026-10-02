/**
 * The Context Assembler V2 against PostgreSQL (P1-E, PR #2).
 *
 *   DATABASE_URL=…/academic_ai_test npm run db:migrate && npm run db:seed
 *   DATABASE_URL=…/academic_ai_test npm run test:context:db
 *
 * Chronological turns (relevance and authority never reorder them; the oldest
 * are dropped first), the member-scoped project snapshot (always present;
 * legacy creator-only records cannot stand in for membership), claim
 * references rendered before assembly (and never reaching a model raw), the
 * TokenCounter as the measure of every budget, and v1 unchanged with the flag
 * off. A scripted model; no network.
 */

import 'dotenv/config';

import { readFileSync } from 'node:fs';

import { and, eq } from 'drizzle-orm';

import { resetEnvCache } from '@/config/env';
import { productionDeps, setGatewayForTests } from '@/server/ai/gateway';
import { FakeAdapter } from '@/server/ai/gateway/adapters/fake';
import { createGateway } from '@/server/ai/gateway/gateway';
import { runForUser } from '@/server/ai/request-scope';
import { fragment, type ContextFragment } from '@/server/context/envelope';
import { buildContextPrompt } from '@/server/context/manager';
import type { TokenCounter } from '@/server/context/token-count';
import { buildContextV2, TURN_SHARE } from '@/server/context/v2/assembler';
import { hasClaimToken, renderClaims, UNRESOLVED_CLAIM_MARKER } from '@/server/context/v2/claims';
import { SNAPSHOT_ID } from '@/server/context/v2/snapshot';
import { chronological, fitTurns } from '@/server/context/v2/turns';
import { db } from '@/server/db';
import { aiConversations, artifacts, graphNodes, projectMembers } from '@/server/db/schema';
import * as graph from '@/server/graph/service';
import * as conversationsRepo from '@/server/repositories/conversations.repository';
import * as projectsRepo from '@/server/repositories/projects.repository';
import { register } from '@/server/services/account.service';
import { answerGeneralQuestion } from '@/server/services/ai.service';

const RUN = `ctx2-${Date.now()}`;
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
  resetEnvCache();
}

/** A counter that charges one token per character, so budgets are exact in the tests. */
const perChar: TokenCounter = { provider: 'estimate', exact: true, count: (text) => text.length };

const turn = (n: number, at: string, relevance = 0.5, role: 'USER' | 'ASSISTANT' = 'USER'): ContextFragment =>
  fragment({
    id: `message-t${n}`,
    kind: 'conversation',
    authority: role === 'USER' ? 'user-content' : 'model-generated',
    content: `${role === 'USER' ? 'User' : 'Assistant'}: turn ${n}`,
    provenance: { source: 'conversation', id: `t${n}`, at },
    relevance,
  });

/** The turns of a prompt, in the order they appear in it. */
const turnOrder = (prompt: string) => [...prompt.matchAll(/(?:User|Assistant): (?:turn|said) (\d+)/g)].map((match) => Number(match[1]));

async function main() {
  setFlags({});
  const user = async (name: string) =>
    (await register({ name, email: `${RUN}-${name}@example.test`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123', locale: 'en' })).id;
  const owner = await user('owner');
  const viewer = await user('viewer');
  const stranger = await user('stranger');
  const removed = await user('removed');
  const project = await projectsRepo.create({ userId: owner, title: 'Hybrid learning and achievement', academicField: 'Education', degree: 'MASTER', researchType: 'QUANTITATIVE', problemArea: 'Grade 9 mathematics' });
  const elsewhere = await projectsRepo.create({ userId: stranger, title: 'Elsewhere', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  await db.insert(projectMembers).values([
    { projectId: project.id, userId: viewer, role: 'VIEWER' },
    { projectId: project.id, userId: removed, role: 'EDITOR' },
  ]);
  await projectsRepo.upsertSection({ projectId: project.id, sectionKey: 'INTRODUCTION', content: 'Intro text that must not appear.', status: 'DRAFT', orderIndex: 0 });

  /* ------------------------------------------------------------------ */
  console.log('\nconversation turns: chronological, never re-ranked');
  const base = Date.parse('2026-10-01T10:00:00Z');
  const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
  const given = [turn(3, at(3), 0.1), turn(1, at(1), 0.9), turn(4, at(4), 0.2), turn(2, at(2), 0.99)];
  check('turns are put in the order they were said, whatever order they arrive in', chronological(given).map((entry) => entry.provenance.id), ['t1', 't2', 't3', 't4']);
  check('… and relevance scores do not move them (the most relevant stays in its place)', fitTurns(given, 10_000, perChar).kept.map((entry) => entry.provenance.id), ['t1', 't2', 't3', 't4']);
  const ties = [turn(5, at(5)), turn(6, at(5)), turn(7, at(5))];
  check('turns with the same time keep the order they were given', chronological(ties).map((entry) => entry.provenance.id), ['t5', 't6', 't7']);
  const length = 'User: turn 1'.length;
  const two = fitTurns(given, length * 2 + 1, perChar);
  check('when the budget is short, the newest turns are kept and the oldest dropped', [two.kept.map((entry) => entry.provenance.id), two.dropped.map((entry) => entry.provenance.id)], [['t3', 't4'], ['t1', 't2']]);
  check('… the kept turns are returned oldest first', two.kept.map((entry) => entry.provenance.id), ['t3', 't4']);
  const gap = [turn(1, at(1)), fragment({ id: 'message-big', kind: 'conversation', authority: 'user-content', content: `User: ${'x'.repeat(500)}`, provenance: { source: 'conversation', id: 'big', at: at(2) } }), turn(3, at(3))];
  check('… and an older, shorter turn is not slipped in past one that did not fit (no gap in the middle)', fitTurns(gap, length * 2 + 1, perChar).kept.map((entry) => entry.provenance.id), ['t3']);
  check('no room at all keeps no turn and drops them all', [fitTurns(given, 0, perChar).kept.length, fitTurns(given, 0, perChar).dropped.length], [0, 4]);

  /* ------------------------------------------------------------------ */
  console.log('\nthe TokenCounter decides the budget');
  const cheap: TokenCounter = { provider: 'estimate', exact: false, count: () => 1 };
  const dear: TokenCounter = { provider: 'estimate', exact: false, count: () => 1_000 };
  check('a counter that charges little fits every turn', fitTurns(given, 4, cheap).kept.length, 4);
  check('… and one that charges a lot fits none, for the same turns and budget', fitTurns(given, 4, dear).kept.length, 0);
  check('the kept turns carry the counter’s measure', fitTurns(given, 100, perChar).kept.map((entry) => entry.tokens), given.map(() => length));

  /* ------------------------------------------------------------------ */
  console.log('\nclaim references are rendered, never passed raw');
  setFlags({ v2: true, graph: true });
  const me = { userId: owner };
  const literature = await graph.createNode(project.id, me, { type: 'claim', data: { text: 'Earlier studies report the same direction.' } });
  /* Seeded directly, as the stats suite does: the graph refuses to write a claim with numbers outside the strict path. */
  const untraced = (await db.insert(graphNodes).values({ projectId: project.id, type: 'claim', label: 'seeded', data: { text: 'The effect was b = 0.42, p = .01.' }, status: 'active', createdByUserId: owner }).returning({ id: graphNodes.id }))[0]!;
  const theirs = await graph.createNode(elsewhere.id, { userId: stranger }, { type: 'claim', data: { text: 'Another project’s finding.' } });
  const missing = '00000000-0000-4000-8000-000000000000';
  check('a resolved claim renders as its text; an unresolved one as the marker', renderClaims(`A {{claim:x}} and {{claim:y}}.`, new Map([['x', 'X holds']]), 'en'), `A X holds and ${UNRESOLVED_CLAIM_MARKER.en}.`);
  check('a reference shaped loosely (spacing, case) is still caught', [renderClaims('See {{ Claim : x }} here.', new Map(), 'en'), hasClaimToken('{{ CLAIM:abc }}')], [`See ${UNRESOLVED_CLAIM_MARKER.en} here.`, true]);
  check('the Arabic marker is used for an Arabic context', renderClaims('{{claim:x}}', new Map(), 'ar'), UNRESOLVED_CLAIM_MARKER.ar);

  const conversation = await conversationsRepo.findOrCreate({ userId: owner, projectId: project.id, scope: 'PROJECT', title: 'ctx' });
  const said = async (n: number, role: 'USER' | 'ASSISTANT', content: string) =>
    conversationsRepo.addMessage({ conversationId: conversation.id, role, content, createdAt: new Date(at(n)) });
  await said(1, 'USER', `said 1: what does {{claim:${literature.id}}} mean?`);
  await said(2, 'ASSISTANT', `said 2: it says {{claim:${untraced.id}}} and {{claim:${theirs.id}}}.`);
  await said(3, 'USER', `said 3: and {{claim:${missing}}}?`);
  await said(4, 'ASSISTANT', 'said 4: noted.');
  await said(5, 'USER', 'said 5: hybrid learning achievement please');

  const built = await buildContextV2({ purpose: 'answer', request: `Explain {{claim:${literature.id}}} again.`, userId: owner, conversationId: conversation.id, projectId: project.id, locale: 'en', counter: perChar, maxTokens: 20_000 });
  check('a valid claim reference renders to the claim’s readable text', built.prompt.includes('what does Earlier studies report the same direction. mean?'), true);
  check('a claim that is not verified, another project’s, and a missing one each become the marker', [built.prompt.includes(`it says ${UNRESOLVED_CLAIM_MARKER.en} and ${UNRESOLVED_CLAIM_MARKER.en}.`), built.prompt.includes(`and ${UNRESOLVED_CLAIM_MARKER.en}?`)], [true, true]);
  check('… nothing is invented for them: neither their text nor their ids appear', [built.prompt.includes('b = 0.42'), built.prompt.includes('Another project'), built.prompt.includes(untraced.id), built.prompt.includes(missing)], [false, false, false, false]);
  check('no raw {{claim:…}} is left in the context', [hasClaimToken(built.prompt), built.prompt.includes('{{claim')], [false, false]);
  check('the request is rendered the same way, for the message the model reads', built.request, 'Explain Earlier studies report the same direction. again.');


  /* The flag matrix (P1-E review): claim resolution depends on FF_CONTEXT_V2 and membership, never on FF_GRAPH. */
  const superseded = await graph.createNode(project.id, me, { type: 'claim', data: { text: 'A claim that was later replaced.' } });
  await db.update(graphNodes).set({ status: 'superseded' }).where(eq(graphNodes.id, superseded.id));
  const matrixRequest = [literature.id, untraced.id, theirs.id, missing, superseded.id].map((id) => `{{claim:${id}}}`).join(' | ');
  const resolvedRequest = ['Earlier studies report the same direction.', ...Array(4).fill(UNRESOLVED_CLAIM_MARKER.en)].join(' | ');
  for (const graphOn of [false, true]) {
    setFlags({ v2: true, graph: graphOn });
    const label = `FF_CONTEXT_V2=true, FF_GRAPH=${graphOn}`;
    const asOwner = await buildContextV2({ purpose: 'answer', request: matrixRequest, userId: owner, conversationId: conversation.id, projectId: project.id, locale: 'en', counter: perChar, maxTokens: 20_000 });
    check(`${label}: a valid, current, verified claim of the project resolves to its readable text`, [asOwner.request.startsWith('Earlier studies report the same direction.'), asOwner.prompt.includes('what does Earlier studies report the same direction. mean?')], [true, true]);
    check(`${label}: an unverified, another project’s, a missing and a non-current claim each become the marker`, asOwner.request, resolvedRequest);
    check(`${label}: … nothing is reconstructed for them (neither their text nor their ids)`, [asOwner.prompt + asOwner.request].map((text) => [text.includes('b = 0.42'), text.includes('Another project'), text.includes('later replaced'), text.includes(untraced.id), text.includes(missing), text.includes(superseded.id)])[0], [false, false, false, false, false, false]);
    check(`${label}: no raw {{claim:…}} in the context or the request`, [hasClaimToken(asOwner.prompt), hasClaimToken(asOwner.request)], [false, false]);
    const asMember = await buildContextV2({ purpose: 'answer', request: `Explain {{claim:${literature.id}}}.`, userId: viewer, projectId: project.id, locale: 'en', counter: perChar });
    check(`${label}: an authorized member who is not the creator (VIEWER) gets the claim’s text`, asMember.request, 'Explain Earlier studies report the same direction..');
    const asOutsider = await buildContextV2({ purpose: 'answer', request: `Explain {{claim:${literature.id}}}.`, userId: stranger, projectId: project.id, locale: 'en', counter: perChar });
    check(`${label}: an unauthorized caller (not a member) gets the marker, and nothing about the claim`, [asOutsider.request, asOutsider.prompt.includes('Earlier studies')], [`Explain ${UNRESOLVED_CLAIM_MARKER.en}.`, false]);
    const noProject = await buildContextV2({ purpose: 'answer', request: `Explain {{claim:${literature.id}}}.`, userId: owner, locale: 'en', counter: perChar });
    check(`${label}: with no project named, even the owner’s claim is the marker (it is resolved only within its project)`, noProject.request, `Explain ${UNRESOLVED_CLAIM_MARKER.en}.`);
    check(`${label}: the snapshot carries graph-derived content only with FF_GRAPH on (PR #3)`, asOwner.envelope.fragments[0]!.content.includes('Research graph:'), graphOn);
  }
  setFlags({ v2: false, graph: true });
  const v1Claims = await buildContextPrompt({ purpose: 'answer', request: matrixRequest, userId: owner, conversationId: conversation.id, projectId: project.id, locale: 'en' });
  check('FF_CONTEXT_V2=false: v1 behaviour, unchanged (no rendered request; references left as v1 left them)', [v1Claims.request, v1Claims.prompt.includes(`{{claim:${literature.id}}}`)], [undefined, true]);
  setFlags({ v2: true, graph: true });

  /* ------------------------------------------------------------------ */
  console.log('\nturn order and budgeting in the assembled context');
  check('turns appear in the prompt in the order they were said', turnOrder(built.prompt), [1, 2, 3, 4, 5]);
  check('… in one block after the other context (user and assistant turns are not split by authority)', [built.prompt.indexOf('## The conversation so far') > built.prompt.indexOf('## Project snapshot'), (built.envelope.turns ?? []).map((entry) => entry.authority)], [true, ['user-content', 'model-generated', 'user-content', 'model-generated', 'user-content']]);
  const relevant = await buildContextV2({ purpose: 'answer', request: 'hybrid learning achievement', userId: owner, conversationId: conversation.id, projectId: project.id, locale: 'en', counter: perChar, maxTokens: 20_000 });
  check('a request matching only the newest turn does not move it (relevance cannot reorder turns)', turnOrder(relevant.prompt), [1, 2, 3, 4, 5]);
  const snapshotTokens = perChar.count(built.envelope.fragments[0]!.content);
  const turnTexts = (built.envelope.turns ?? []).map((entry) => entry.content.length);
  const lastTwo = turnTexts.slice(-2).reduce((a, b) => a + b, 0);
  const tight = await buildContextV2({ purpose: 'answer', request: 'x', userId: owner, conversationId: conversation.id, projectId: project.id, locale: 'en', counter: perChar, maxTokens: snapshotTokens + Math.ceil((lastTwo + 1) / TURN_SHARE) });
  check('over budget, the oldest turns are dropped and the newest kept, still in order', turnOrder(tight.prompt), [4, 5]);
  check('… the drop is recorded and said in the prompt', [tight.envelope.omitted.reduce((total, group) => (group.kind === 'conversation' ? total + group.count : total), 0), tight.prompt.includes('3 earlier turns did not fit')], [3, true]);
  const tightCheap = await buildContextV2({ purpose: 'answer', request: 'x', userId: owner, conversationId: conversation.id, projectId: project.id, locale: 'en', counter: { provider: 'estimate', exact: false, count: (text) => Math.ceil(text.length / 100) }, maxTokens: snapshotTokens + Math.ceil((lastTwo + 1) / TURN_SHARE) });
  check('the same budget measured by a cheaper counter keeps every turn (the counter, not a fixed rule, decides)', turnOrder(tightCheap.prompt), [1, 2, 3, 4, 5]);
  check('the envelope’s used tokens are the counter’s', built.envelope.budget.usedTokens, [built.envelope.fragments, built.envelope.turns ?? []].flat().reduce((total, entry) => total + perChar.count(entry.content), 0));

  /* ------------------------------------------------------------------ */
  console.log('\nthe project snapshot: always present, member-scoped');
  const snap = built.envelope.fragments[0]!;
  check('it is present, first, and pinned', [snap.id, snap.pinned, built.prompt.startsWith('## Project snapshot')], [SNAPSHOT_ID, true, true]);
  check('the creator-only v1 project reader is not used (its "Project: …" fragment is absent)', [built.prompt.includes('Project: Hybrid'), built.prompt.includes('Title: Hybrid')], [false, true]);
  check('it holds the project’s fields and its sections’ keys, never their bodies', [snap.content.includes('Title: Hybrid learning and achievement'), snap.content.includes('Problem area: Grade 9 mathematics'), /INTRODUCTION/.test(snap.content), snap.content.includes('Intro text that must not appear')], [true, true, true, false]);
  const noProject = await buildContextV2({ purpose: 'answer', request: 'x', userId: owner, locale: 'en', counter: perChar });
  check('with no project it is still present, saying so', [noProject.envelope.fragments[0]?.id, noProject.prompt.includes('no research project is attached')], [SNAPSHOT_ID, true]);
  const tiny = await buildContextV2({ purpose: 'route', request: 'x', userId: owner, conversationId: conversation.id, projectId: project.id, locale: 'en', counter: perChar, maxTokens: 1 });
  check('a budget too small for anything still carries the snapshot (it is never dropped)', [tiny.envelope.fragments[0]?.id, tiny.prompt.includes('Title: Hybrid learning'), (tiny.envelope.turns ?? []).length], [SNAPSHOT_ID, true, 0]);
  const asViewer = await buildContextV2({ purpose: 'answer', request: 'x', userId: viewer, projectId: project.id, locale: 'en', counter: perChar });
  check('a VIEWER member (not the creator) gets the project’s snapshot, with their role', [asViewer.prompt.includes('Title: Hybrid learning'), asViewer.prompt.includes('Your role: VIEWER')], [true, true]);
  const asStranger = await buildContextV2({ purpose: 'answer', request: 'x', userId: stranger, projectId: project.id, locale: 'en', counter: perChar });
  check('a non-member gets the no-project snapshot: nothing about the project, not even that it exists', [asStranger.prompt.includes('Hybrid learning'), asStranger.prompt.includes('no research project is attached'), asStranger.envelope.fragments[0]?.provenance.id], [false, true, 'none']);
  check('… exactly what a project that does not exist gets', (await buildContextV2({ purpose: 'answer', request: 'x', userId: stranger, projectId: missing, locale: 'en', counter: perChar })).prompt, asStranger.prompt);
  await db.delete(projectMembers).where(eqMember(project.id, removed));
  const afterRemoval = await buildContextV2({ purpose: 'answer', request: 'x', userId: removed, projectId: project.id, locale: 'en', counter: perChar });
  check('a member who was removed loses the snapshot at once', afterRemoval.prompt.includes('Hybrid learning'), false);

  /* Legacy creator-only records under the project. */
  const conversationOfStranger = (await db.insert(aiConversations).values({ userId: stranger, projectId: project.id, scope: 'PROJECT', title: 'planted' }).returning())[0]!;
  await db.insert(artifacts).values({ userId: stranger, projectId: project.id, kind: 'docx', filename: 'stranger-planted.docx', storageKey: `${RUN}/x`, byteSize: 1, lineageId: `${RUN}-lineage` });
  await db.insert(artifacts).values({ userId: owner, projectId: project.id, kind: 'docx', filename: 'owner-own.docx', storageKey: `${RUN}/y`, byteSize: 1, lineageId: `${RUN}-lineage-2` });
  const strangerWithLegacy = await buildContextV2({ purpose: 'plan', request: 'x', userId: stranger, projectId: project.id, conversationId: conversationOfStranger.id, locale: 'en', counter: perChar });
  check('a non-member’s own legacy record filed under the project (an artifact) does not bypass membership: it is not shown with the project', [strangerWithLegacy.prompt.includes('stranger-planted.docx'), strangerWithLegacy.prompt.includes('Hybrid learning')], [false, false]);
  setFlags({});
  const strangerV1 = await buildContextPrompt({ purpose: 'plan', request: 'x', userId: stranger, projectId: project.id, locale: 'en' });
  check('(v1, unchanged, did show it: the creator-only artifact reader is what V2 no longer lets stand in for membership)', strangerV1.prompt.includes('stranger-planted.docx'), true);
  const ownerV1 = await buildContextPrompt({ purpose: 'plan', request: 'x', userId: owner, projectId: project.id, locale: 'en' });
  setFlags({ v2: true, graph: true });
  const viewerPlan = await buildContextV2({ purpose: 'plan', request: 'x', userId: viewer, projectId: project.id, locale: 'en', counter: perChar });
  check('a member does not see another person’s legacy records either (legacy stays creator-only, WS4 A2)', [viewerPlan.prompt.includes('owner-own.docx'), viewerPlan.prompt.includes('stranger-planted.docx')], [false, false]);
  const ownerPlan = await buildContextV2({ purpose: 'plan', request: 'x', userId: owner, projectId: project.id, locale: 'en', counter: perChar });
  check('… while a member’s own legacy records still appear, as in v1', [ownerPlan.prompt.includes('owner-own.docx'), ownerV1.prompt.includes('owner-own.docx')], [true, true]);

  /* ------------------------------------------------------------------ */
  console.log('\nnothing raw reaches the model');
  const fake = new FakeAdapter('openai');
  setGatewayForTests(createGateway({ ...productionDeps, adapters: () => ({ openai: fake }), models: async () => ({ configured: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai', siblings: {} }) }));
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'placeholder-for-the-scripted-model';
  resetEnvCache();
  const seen = () => {
    const call = fake.calls.at(-1)!;
    return JSON.stringify({ system: call.request.system ?? '', messages: call.request.messages });
  };
  try {
    await runForUser(owner, () => answerGeneralQuestion({ userId: owner, message: `What about {{claim:${literature.id}}} and {{claim:${missing}}}?`, locale: 'en', projectId: project.id, context: { conversationId: conversation.id } }));
    const sent = seen();
    check('the model receives readable claim text and markers, never a raw {{claim:…}} (system or messages)', [sent.includes('{{claim'), sent.includes('Earlier studies report the same direction.'), sent.includes(UNRESOLVED_CLAIM_MARKER.en)], [false, true, true]);
    check('… the message itself is rendered from the same claims', fake.calls.at(-1)!.request.messages.at(-1)?.content, `What about Earlier studies report the same direction. and ${UNRESOLVED_CLAIM_MARKER.en}?`);
    const route = readFileSync('src/app/api/chat/route.ts', 'utf8');
    check('… and the chat route hands its build’s rendered message to the answer', [route.includes('contextRequest = built.request;'), route.includes('{ contextPrompt, contextRequest }')], [true, true]);
    await runForUser(owner, () => answerGeneralQuestion({ userId: owner, message: `Plain path {{claim:${literature.id}}}`, locale: 'en', projectId: project.id, history: [{ role: 'user', content: `Earlier {{claim:${missing}}}` }], material: `Material {{claim:${missing}}}` }));
    check('… on the path without context too (history, material and message are scrubbed)', [seen().includes('{{claim'), seen().includes('Plain path')], [false, true]);
    await runForUser(owner, () => answerGeneralQuestion({ userId: owner, message: `Given {{claim:${literature.id}}}`, locale: 'en', projectId: project.id, contextPrompt: 'Prebuilt context.', contextRequest: 'Given Earlier studies report the same direction.' }));
    check('… and a caller that built the context hands the rendered message on', [seen().includes('{{claim'), seen().includes('Given Earlier studies report')], [false, true]);

    /* ------------------------------------------------------------------ */
    console.log('\nwith Context V2 off, the existing behaviour is unchanged');
    setFlags({ v2: false, graph: true });
    process.env.OPENAI_API_KEY = 'placeholder-for-the-scripted-model';
    resetEnvCache();
    const v1 = await buildContextPrompt({ purpose: 'answer', request: 'x', userId: owner, conversationId: conversation.id, projectId: project.id, locale: 'en' });
    check('no snapshot, no turns block, no rendered request: the v1 envelope', [v1.prompt.includes('## Project snapshot'), v1.prompt.includes('## The conversation so far'), v1.request, v1.envelope.turns, v1.prompt.includes("## What the user wrote")], [false, false, undefined, undefined, true]);
    check('… its claim references are left as they were (v1 does not render them)', v1.prompt.includes(`{{claim:${literature.id}}}`), true);
    await runForUser(owner, () => answerGeneralQuestion({ userId: owner, message: `Untouched {{claim:${missing}}}`, locale: 'en', projectId: project.id, history: [{ role: 'user', content: 'h' }] }));
    check('… and the general answer sends the message as before', seen().includes(`Untouched {{claim:${missing}}}`), true);
  } finally {
    setGatewayForTests(null);
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    setFlags({});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function eqMember(projectId: string, userId: string) {
  return and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
