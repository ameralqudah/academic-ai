/**
 * Graph context for Context V2 against PostgreSQL (P1-E, PR #3).
 *
 *   DATABASE_URL=…/academic_ai_test npm run db:migrate && npm run db:seed
 *   DATABASE_URL=…/academic_ai_test npm run test:graphctx:db
 *
 * The snapshot's graph section and the focus-graph slice: only with
 * FF_CONTEXT_V2 and FF_GRAPH both on, only for members (VIEWER and up), only
 * from the caller's project, bounded, and with claims rendered by PR #2's
 * rules. With either flag off, no graph-derived data reaches the context.
 */

import 'dotenv/config';

import { eq } from 'drizzle-orm';

import { resetEnvCache } from '@/config/env';
import { buildContextPrompt } from '@/server/context/manager';
import type { TokenCounter } from '@/server/context/token-count';
import { buildContextV2, FOCUS_SLICE_ID } from '@/server/context/v2/assembler';
import { hasClaimToken, UNRESOLVED_CLAIM_MARKER } from '@/server/context/v2/claims';
import { MAX_FOCUS, MAX_SLICE_NODES } from '@/server/context/v2/graph-context';
import { db } from '@/server/db';
import { graphEdges, graphNodes, projectMembers } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as graph from '@/server/graph/service';
import * as conversationsRepo from '@/server/repositories/conversations.repository';
import * as projectsRepo from '@/server/repositories/projects.repository';
import { register } from '@/server/services/account.service';

const RUN = `gctx-${Date.now()}`;
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

async function acknowledged<T>(work: (ack?: string) => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'IMPACT_ACK_REQUIRED') throw error;
    return work((error.details as { report: graph.ImpactReport }).report.hash);
  }
}

const perChar: TokenCounter = { provider: 'estimate', exact: true, count: (text) => text.length };

/** Every graph label of the fixture, any of which would be a leak where graph context is off. */
const GRAPH_WORDS = ['Zeta', 'Omega', 'Kappa', 'Sigma', 'Research graph:', 'Focus graph'];
const leaks = (text: string) => GRAPH_WORDS.filter((word) => text.includes(word));

async function main() {
  setFlags({ graph: true });
  const user = async (name: string) =>
    (await register({ name, email: `${RUN}-${name}@example.test`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123', locale: 'en' })).id;
  const owner = await user('owner');
  const viewer = await user('viewer');
  const stranger = await user('stranger');
  const removed = await user('removed');
  const project = await projectsRepo.create({ userId: owner, title: 'Trust and adoption', academicField: 'Management', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  const other = await projectsRepo.create({ userId: stranger, title: 'Other project', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  await db.insert(projectMembers).values([
    { projectId: project.id, userId: viewer, role: 'VIEWER' },
    { projectId: project.id, userId: removed, role: 'EDITOR' },
  ]);

  const me = { userId: owner };
  const ids: Record<string, string> = {};
  const node = async (key: string, type: string, label: string, data: Record<string, unknown>, projectId = project.id, actor = me) => {
    ids[key] = (await graph.createNode(projectId, actor, { type, label, data })).id;
    return ids[key]!;
  };
  const link = (src: string, rel: string, dst: string, projectId = project.id, actor = me) =>
    acknowledged((ack) => graph.link(projectId, actor, { srcId: ids[src]!, rel, dstId: ids[dst]!, impactAcknowledged: ack }));

  /* G — RQ — C (— S), C2; C3 superseded; a literature claim asserted by a block, and a seeded unverified one. */
  await node('G', 'gap', 'Gap Omega', { statement: 'No evidence on trust in Jordan' });
  await node('RQ', 'research_question', 'Does trust drive adoption (Zeta)?', { text: 'Does trust drive adoption?' });
  await node('C', 'construct', 'Trust Zeta', { name: 'Trust', definition: 'Willingness to be vulnerable', kind: 'reflective' });
  await node('C2', 'construct', 'Adoption Zeta', { name: 'Adoption', definition: 'Intention to use', kind: 'reflective' });
  await node('C3', 'construct', 'Retired Kappa', { name: 'Retired', definition: 'Old', kind: 'reflective' });
  await node('S', 'source', 'Source Sigma 1995', { title: 'Mayer, Davis & Schoorman 1995' });
  await node('H', 'hypothesis', 'H1 trust increases adoption', { code: 'H1', statement: 'Trust increases adoption', kind: 'direct', direction: 'positive' });
  await node('CL', 'claim', 'claim-lit', { text: 'Gefen et al. report that trust predicts adoption.' });
  await node('B', 'block', 'Block Zeta', { text: 'As shown…' });
  await link('RQ', 'addresses', 'G');
  await link('C', 'scoped_by', 'RQ');
  await link('C2', 'scoped_by', 'RQ');
  await link('C3', 'scoped_by', 'RQ');
  await link('C', 'defined_by', 'S');
  await link('B', 'asserts', 'CL');
  await db.update(graphNodes).set({ status: 'superseded' }).where(eq(graphNodes.id, ids.C3!));
  ids.UN = (await db.insert(graphNodes).values({ projectId: project.id, type: 'claim', label: 'claim-unverified', data: { text: 'The effect was b = 0.42, p = .01.' }, status: 'active', createdByUserId: owner }).returning({ id: graphNodes.id }))[0]!.id;
  await db.insert(graphEdges).values({ projectId: project.id, srcId: ids.B!, rel: 'asserts', dstId: ids.UN!, dependency: true, createdByUserId: owner, origin: 'user' });

  /* Another project, with its own graph. */
  await node('X', 'construct', 'Foreign Secret Construct', { name: 'Secret', definition: 'x', kind: 'reflective' }, other.id, { userId: stranger });
  await node('XRQ', 'research_question', 'Foreign secret question about trust', { text: 'x' }, other.id, { userId: stranger });
  await link('X', 'scoped_by', 'XRQ', other.id, { userId: stranger });

  const build = (userId: string, extra: Partial<Parameters<typeof buildContextV2>[0]> = {}) =>
    buildContextV2({ purpose: 'answer', request: 'How does trust relate to adoption?', userId, projectId: project.id, locale: 'en', counter: perChar, maxTokens: 20_000, ...extra });
  const sliceOf = (built: Awaited<ReturnType<typeof build>>) => built.envelope.fragments.find((entry) => entry.id === FOCUS_SLICE_ID)?.content ?? null;

  /* ------------------------------------------------------------------ */
  console.log('\nthe flag matrix');
  setFlags({});
  const bothOff = await buildContextPrompt({ purpose: 'answer', request: 'How does trust relate to adoption?', userId: owner, projectId: project.id, locale: 'en' });
  check('both flags off: v1, and no graph-derived data at all', [bothOff.request, leaks(bothOff.prompt)], [undefined, []]);
  setFlags({ graph: true });
  const graphOnly = await buildContextPrompt({ purpose: 'answer', request: 'How does trust relate to adoption?', userId: owner, projectId: project.id, locale: 'en' });
  check('FF_GRAPH on but Context V2 off: v1, still no graph-derived context', [graphOnly.request, leaks(graphOnly.prompt)], [undefined, []]);
  setFlags({ v2: true, graph: false });
  const v2Only = await build(owner, { focusNodeIds: [ids.C!] });
  check('Context V2 on, FF_GRAPH off: the snapshot has no graph section and there is no slice, even with a focus node named', [leaks(v2Only.prompt), sliceOf(v2Only), v2Only.prompt.includes('Project snapshot:')], [[], null, true]);
  check('… while an explicitly referenced claim still resolves (PR #2 rule, independent of FF_GRAPH)', (await build(owner, { request: `See {{claim:${ids.CL}}}.` })).request, 'See Gefen et al. report that trust predicts adoption..');
  setFlags({ v2: true, graph: true });
  const both = await build(owner);
  check('both flags on: the snapshot carries the graph section and the slice is present', [both.envelope.fragments[0]!.content.includes('Research graph:'), sliceOf(both) !== null, both.prompt.includes('Focus graph')], [true, true, true]);

  /* ------------------------------------------------------------------ */
  console.log('\nthe snapshot’s graph section');
  const section = both.envelope.fragments[0]!.content;
  check('it counts live nodes by type (the superseded construct is not counted)', [section.includes('2 constructs'), section.includes('3 constructs'), section.includes('Retired Kappa')], [true, false, false]);
  check('it lists research questions and hypotheses by label', [section.includes('Research questions: Does trust drive adoption (Zeta)?'), section.includes('Hypotheses: H1 trust increases adoption')], [true, true]);
  check('labels only: no payload (definitions, statements, claim text) is copied in', [section.includes('Willingness to be vulnerable'), section.includes('Gefen'), section.includes('b = 0.42')], [false, false, false]);
  check('… not even of the listed questions and hypotheses (their text, direction, kind)', [section.includes('"statement"'), section.includes('positive'), section.includes('{')], [false, false, false]);
  check('nothing of another project appears', section.includes('Foreign'), false);
  check('it stays part of the pinned snapshot', [both.envelope.fragments[0]!.pinned, both.envelope.fragments[0]!.id], [true, 'project-snapshot']);

  /* ------------------------------------------------------------------ */
  console.log('\nthe focus-graph slice and its boundaries');
  const aroundC = sliceOf(await build(owner, { focusNodeIds: [ids.C!] }))!;
  check('around a named focus node: its one-step neighbours (its question, its source)', [aroundC.includes('[construct] Trust Zeta —scoped_by→ [research question] Does trust drive adoption (Zeta)?'), aroundC.includes('[construct] Trust Zeta —defined_by→ [source] Source Sigma 1995')], [true, true]);
  check('… and nothing two steps away (the gap, the sibling construct)', [aroundC.includes('Gap Omega'), aroundC.includes('Adoption Zeta')], [false, false]);
  const aroundRQ = sliceOf(await build(owner, { focusNodeIds: [ids.RQ!] }))!;
  check('a superseded neighbour is left out of the slice', [aroundRQ.includes('Trust Zeta'), aroundRQ.includes('Adoption Zeta'), aroundRQ.includes('Retired Kappa')], [true, true, false]);
  const matched = sliceOf(both)!;
  check('with no focus named, nodes whose labels share the request’s words are the focus', [matched.includes('one step around'), matched.includes('Trust Zeta') || matched.includes('Does trust drive adoption')], [true, true]);
  check('a request that matches nothing gets no slice', sliceOf(await build(owner, { request: 'Explain bootstrap intervals please' })), null);

  const wide = await projectsRepo.create({ userId: owner, title: 'Wide graph', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  await node('W', 'research_question', 'Wide question', { text: 'w' }, wide.id);
  for (let index = 0; index < MAX_SLICE_NODES + 6; index += 1) {
    await node(`W${index}`, 'construct', `Wide construct ${index}`, { name: `c${index}`, definition: 'd', kind: 'reflective' }, wide.id);
    await link(`W${index}`, 'scoped_by', 'W', wide.id);
  }
  const wideSlice = sliceOf(await build(owner, { projectId: wide.id, focusNodeIds: [ids.W!] }))!;
  const shown = new Set(wideSlice.match(/Wide construct \d+/g) ?? []);
  check(`the slice is bounded: at most ${MAX_SLICE_NODES} nodes (focus included) out of ${MAX_SLICE_NODES + 7}`, [shown.size <= MAX_SLICE_NODES - 1, shown.size > 0], [true, true]);
  const manyFocus = Array.from({ length: MAX_FOCUS + 3 }, (_, index) => ids[`W${index}`]!);
  const roots = (sliceOf(await build(owner, { projectId: wide.id, focusNodeIds: manyFocus }))!.split('\n')[0]!.match(/\[construct\]/g) ?? []).length;
  check(`at most ${MAX_FOCUS} focus nodes`, roots, MAX_FOCUS);

  /* ------------------------------------------------------------------ */
  console.log('\nmembership and isolation');
  const asViewer = await build(viewer, { focusNodeIds: [ids.C!] });
  check('a VIEWER member (not the creator) gets the graph section and the slice', [asViewer.prompt.includes('Research graph:'), (sliceOf(asViewer) ?? '').includes('Trust Zeta')], [true, true]);
  const asStranger = await build(stranger, { focusNodeIds: [ids.C!] });
  check('a non-member gets neither, and no graph label at all, even naming a focus node', [leaks(asStranger.prompt), sliceOf(asStranger)], [[], null]);
  await db.delete(projectMembers).where(eq(projectMembers.userId, removed));
  check('a removed member loses graph context at once', leaks((await build(removed)).prompt), []);
  const crossFocus = await build(owner, { focusNodeIds: [ids.X!, ids.XRQ!] });
  check('a focus node of another project is skipped: nothing of it appears (cross-project isolation)', [crossFocus.prompt.includes('Foreign'), sliceOf(crossFocus)?.includes('Foreign') ?? false], [false, false]);
  const strangerOwn = await build(stranger, { projectId: other.id, focusNodeIds: [ids.C!] });
  check('… nor does a node of this project appear in the other project’s context', [strangerOwn.prompt.includes('Trust Zeta'), (sliceOf(strangerOwn) ?? '').includes('Trust Zeta')], [false, false]);
  const missing = await build(owner, { focusNodeIds: ['00000000-0000-4000-8000-000000000000'] });
  check('a focus id that does not exist yields no slice and no error', sliceOf(missing), null);

  /* ------------------------------------------------------------------ */
  console.log('\nclaims in the slice keep PR #2’s rules');
  const aroundB = await build(owner, { focusNodeIds: [ids.B!] });
  const bSlice = sliceOf(aroundB)!;
  check('a current, verified claim in the slice is shown as its text', bSlice.includes('[claim] Gefen et al. report that trust predicts adoption.'), true);
  check('an unverified claim in the slice is the marker; its numbers never appear', [bSlice.includes(`[claim] ${UNRESOLVED_CLAIM_MARKER.en}`), aroundB.prompt.includes('b = 0.42')], [true, false]);
  check('no raw {{claim:…}} anywhere in the prompt', [hasClaimToken(aroundB.prompt), aroundB.prompt.includes(ids.UN!), aroundB.prompt.includes(ids.CL!)], [false, false, false]);
  const byReference = sliceOf(await build(owner, { request: `What supports {{claim:${ids.CL}}}?` }))!;
  check('a claim referenced in the request is a focus node: the slice shows what asserts it', byReference.includes('[block] Block Zeta —asserts→ [claim] Gefen et al. report'), true);

  /* ------------------------------------------------------------------ */
  console.log('\nturn order and budgeting are unchanged');
  const conversation = await conversationsRepo.findOrCreate({ userId: owner, projectId: project.id, scope: 'PROJECT', title: 'g' });
  for (let n = 1; n <= 4; n += 1) {
    await conversationsRepo.addMessage({ conversationId: conversation.id, role: n % 2 ? 'USER' : 'ASSISTANT', content: `said ${n}: trust`, createdAt: new Date(Date.parse('2026-10-01T10:00:00Z') + n * 60_000) });
  }
  const withTurns = await build(owner, { conversationId: conversation.id });
  check('with graph context on, turns stay one chronological block', [...withTurns.prompt.matchAll(/(?:User|Assistant): said (\d)/g)].map((match) => Number(match[1])), [1, 2, 3, 4]);
  check('the slice is an ordinary, unpinned project-data fragment (budgeted like the others)', (() => {
    const slice = withTurns.envelope.fragments.find((entry) => entry.id === FOCUS_SLICE_ID);
    return [slice?.pinned, slice?.authority, slice?.tokens === perChar.count(slice?.content ?? '')];
  })(), [false, 'project-data', true]);
  const snapTokens = withTurns.envelope.fragments[0]!.tokens;
  const tight = await build(owner, { conversationId: conversation.id, maxTokens: snapTokens + 10 });
  check('a budget with room only for the snapshot drops the slice, never the snapshot', [tight.envelope.fragments[0]!.id, tight.envelope.fragments.some((entry) => entry.id === FOCUS_SLICE_ID), (tight.envelope.turns ?? []).length], ['project-snapshot', false, 0]);

  setFlags({});
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
