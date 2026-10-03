/**
 * Snapshot completeness (R7) and the slice depth (R8) against PostgreSQL
 * (P1-E, PR #6).
 *
 *   DATABASE_URL=…/academic_ai_test npm run db:migrate && npm run db:seed
 *   DATABASE_URL=…/academic_ai_test npm run test:snapshot:db
 *
 * R7: per-section integrity counts from the stored guard records (never
 * recomputed, never the numbers themselves); untested hypotheses and the
 * latest analysis run from the graph, only with FF_GRAPH, member-scoped, no
 * payloads; no active dataset. The snapshot stays pinned and member-scoped.
 * R8: the slice is one hop (k=1), within its caps, and droppable.
 */

import 'dotenv/config';

import { eq } from 'drizzle-orm';

import { resetEnvCache } from '@/config/env';
import { buildContextPrompt } from '@/server/context/manager';
import type { TokenCounter } from '@/server/context/token-count';
import { buildContextV2, FOCUS_SLICE_ID } from '@/server/context/v2/assembler';
import { MAX_FOCUS, MAX_SLICE_EDGES, MAX_SLICE_NODES, SLICE_DEPTH } from '@/server/context/v2/graph-context';
import { SNAPSHOT_ID } from '@/server/context/v2/snapshot';
import { db } from '@/server/db';
import { datasets, graphEdges, graphNodes, projectMembers, researchSections, sectionVersions } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as graph from '@/server/graph/service';
import type { SectionIntegrity } from '@/server/integrity/section';
import * as projectsRepo from '@/server/repositories/projects.repository';
import { register } from '@/server/services/account.service';

const RUN = `snap-${Date.now()}`;
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

const integrity = (counts: Partial<SectionIntegrity>): SectionIntegrity => ({
  mode: 'model',
  guardVersion: 'test',
  quarantined: 0,
  manual: 0,
  traced: 0,
  sources: [],
  excluded: [],
  findings: [],
  ...counts,
});

async function main() {
  setFlags({ v2: true, graph: true });
  const user = async (name: string) =>
    (await register({ name, email: `${RUN}-${name}@example.test`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123', locale: 'en' })).id;
  const owner = await user('owner');
  const viewer = await user('viewer');
  const stranger = await user('stranger');
  const project = await projectsRepo.create({ userId: owner, title: 'Snapshot project', academicField: 'Management', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  const other = await projectsRepo.create({ userId: stranger, title: 'Other project', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  await db.insert(projectMembers).values({ projectId: project.id, userId: viewer, role: 'VIEWER' });

  /* Sections and their stored guard records. */
  const section = async (sectionKey: string, status: 'DRAFT' | 'APPROVED', content: string, orderIndex: number) =>
    (await db.insert(researchSections).values({ projectId: project.id, sectionKey: sectionKey as never, status, content, orderIndex }).returning())[0]!.id;
  const results = await section('RESULTS', 'DRAFT', 'The effect was b = 0.42, p = .01, and r = .31.', 1);
  const discussion = await section('DISCUSSION', 'DRAFT', 'We found 12.5% and 0.77 in total.', 2);
  const intro = await section('INTRODUCTION', 'APPROVED', 'An introduction with 3 numbers 4.4 and 5.5.', 0);
  /* RESULTS: an older record with other counts, then the latest (2 quarantined, 1 untraced, a finding that must never appear). */
  await db.insert(sectionVersions).values({ sectionId: results, content: 'old', origin: 'AI', integrity: integrity({ quarantined: 7, manual: 9 }), createdAt: new Date(Date.now() - 60_000) });
  await db.insert(sectionVersions).values({
    sectionId: results,
    content: 'The effect was b = 0.42, p = .01.',
    origin: 'AI',
    integrity: integrity({ quarantined: 2, manual: 1, traced: 3, findings: [{ text: '0.4242', value: 0.4242, kind: 'decimal' } as never], sources: [{ id: 'legacy-run-secret', tier: 'verified' } as never] }),
  });
  /* DISCUSSION: a record with nothing untraced (its numbers in the text are not recounted). INTRODUCTION: a version with no record. */
  await db.insert(sectionVersions).values({ sectionId: discussion, content: 'x', origin: 'USER', integrity: integrity({ mode: 'person', traced: 2 }) });
  await db.insert(sectionVersions).values({ sectionId: intro, content: 'x', origin: 'USER' });

  /* A legacy dataset of the creator, attached to the project: never in the member-scoped snapshot. */
  await db.insert(datasets).values({ userId: owner, projectId: project.id, originalName: 'Active Dataset Secret.csv', storageKey: `${RUN}/secret.csv`, rowCount: 412 });

  /* Graph: hypotheses (tested, untested, tested only by a superseded result, superseded), runs, and a two-hop chain. */
  const me = { userId: owner };
  const ids: Record<string, string> = {};
  const node = async (key: string, type: string, label: string, data: Record<string, unknown>, projectId = project.id, actor = me) => {
    ids[key] = (await graph.createNode(projectId, actor, { type, label, data })).id;
    return ids[key]!;
  };
  const link = (src: string, rel: string, dst: string, projectId = project.id, actor = me) =>
    acknowledged((ack) => graph.link(projectId, actor, { srcId: ids[src]!, rel, dstId: ids[dst]!, impactAcknowledged: ack }));
  const raw = async (key: string, type: string, label: string, data: Record<string, unknown>, extra: { status?: string; createdAt?: Date; projectId?: string } = {}) => {
    ids[key] = (
      await db
        .insert(graphNodes)
        .values({ projectId: extra.projectId ?? project.id, type, label, data, status: extra.status ?? 'active', createdByUserId: owner, ...(extra.createdAt ? { createdAt: extra.createdAt } : {}) })
        .returning({ id: graphNodes.id })
    )[0]!.id;
    return ids[key]!;
  };
  const edge = (src: string, rel: string, dst: string, projectId = project.id) =>
    db.insert(graphEdges).values({ projectId, srcId: ids[src]!, rel, dstId: ids[dst]!, dependency: true, createdByUserId: owner, origin: 'user' });

  await node('H1', 'hypothesis', 'H1 Tested Alpha', { code: 'H1', statement: 'Statement Secret One', kind: 'direct', direction: 'positive' });
  await node('H2', 'hypothesis', 'H2 Open Beta', { code: 'H2', statement: 'Statement Secret Two', kind: 'direct', direction: 'positive' });
  await node('H3', 'hypothesis', 'H3 Stale Gamma', { code: 'H3', statement: 'Statement Secret Three', kind: 'direct', direction: 'positive' });
  await raw('H4', 'hypothesis', 'H4 Superseded Delta', { code: 'H4', statement: 'x' }, { status: 'superseded' });
  await raw('R1', 'analysis_run', 'Run Older Epsilon', { engine: 'r-lavaan', status: 'succeeded', seed: 4242, specHash: 'hash-secret-older' }, { createdAt: new Date('2026-09-01T10:00:00Z') });
  await raw('R2', 'analysis_run', 'Run Latest Zeta', { engine: 'pls-sem', engineVersion: '9.9.9', status: 'succeeded', seed: 777, resultHash: 'hash-secret-latest', method: 'Bootstrap Secret' }, { createdAt: new Date('2026-09-20T10:00:00Z') });
  await raw('R3', 'analysis_run', 'Run Superseded Eta', { engine: 'old', status: 'succeeded' }, { status: 'superseded', createdAt: new Date('2026-09-30T10:00:00Z') });
  await raw('V1', 'result_value', 'beta value Theta', { value: 0.3737, stat: 'beta' });
  await raw('V2', 'result_value', 'old value Iota', { value: 0.5151, stat: 'beta' }, { status: 'superseded' });
  await edge('V1', 'tests', 'H1');
  await edge('V2', 'tests', 'H3');
  await edge('V1', 'produced_by', 'R2');

  /* A — B — C: two hops from A. */
  await node('A', 'construct', 'Chain Alpha Construct', { name: 'Alpha', definition: 'Def Secret A', kind: 'reflective' });
  await node('B', 'research_question', 'Chain Beta Question', { text: 'x' });
  await node('C', 'gap', 'Chain Gamma Gap', { statement: 'x' });
  await node('D', 'construct', 'Chain Retired Construct', { name: 'Retired', definition: 'x', kind: 'reflective' });
  await link('A', 'scoped_by', 'B');
  await link('B', 'addresses', 'C');
  await link('D', 'scoped_by', 'B');
  await db.update(graphNodes).set({ status: 'superseded' }).where(eq(graphNodes.id, ids.D!));

  /* Another project's graph: a hypothesis, a run, a construct. */
  await raw('XH', 'hypothesis', 'Foreign Hypothesis Kappa', { statement: 'x' }, { projectId: other.id });
  await raw('XR', 'analysis_run', 'Foreign Run Kappa', { engine: 'x', status: 'succeeded' }, { projectId: other.id, createdAt: new Date('2026-10-01T10:00:00Z') });

  const build = (userId: string, extra: Partial<Parameters<typeof buildContextV2>[0]> = {}) =>
    buildContextV2({ purpose: 'answer', request: 'Explain please', userId, projectId: project.id, locale: 'en', counter: perChar, maxTokens: 20_000, ...extra });
  const snapshotOf = (built: Awaited<ReturnType<typeof build>>) => built.envelope.fragments.find((entry) => entry.id === SNAPSHOT_ID)?.content ?? '';
  const sliceOf = (built: Awaited<ReturnType<typeof build>>) => built.envelope.fragments.find((entry) => entry.id === FOCUS_SLICE_ID)?.content ?? null;

  /* ------------------------------------------------------------------ */
  console.log('\nR7: per-section integrity counts (stored records only)');
  setFlags({ v2: true });
  const v2only = snapshotOf(await build(owner));
  check('the latest record’s counts are shown per section', v2only.includes('RESULTS (DRAFT; 2 quarantined numbers; 1 untraced number)'), true);
  check('an older record of the same section is not used', [v2only.includes('7 quarantined'), v2only.includes('9 untraced')], [false, false]);
  check('a section whose record has nothing untraced, or that has no record, shows its status only (its text is not recounted)', [v2only.includes('DISCUSSION (DRAFT)'), v2only.includes('INTRODUCTION (APPROVED)')], [true, true]);
  check('counts only: no number, finding or source of the record, and no section text', [v2only.includes('0.4242'), v2only.includes('legacy-run-secret'), v2only.includes('0.42'), v2only.includes('12.5%')], [false, false, false, false]);
  check('the counts need no FF_GRAPH (v1 project data)', v2only.includes('2 quarantined numbers'), true);
  check('a VIEWER member sees the same counts', snapshotOf(await build(viewer)).includes('RESULTS (DRAFT; 2 quarantined numbers; 1 untraced number)'), true);
  const strangerSnap = snapshotOf(await build(stranger));
  check('a non-member gets the no-project snapshot: no section, no count', [strangerSnap.includes('no research project'), strangerSnap.includes('quarantined'), strangerSnap.includes('RESULTS')], [true, false, false]);

  console.log('\nR7: no active dataset (legacy datasets are creator-only)');
  const ownerBoth = await (async () => {
    setFlags({ v2: true, graph: true });
    return build(owner);
  })();
  check('even for the creator, with both flags on, the snapshot names no dataset', [ownerBoth.prompt.includes('Active Dataset Secret'), ownerBoth.prompt.includes('412'), /dataset/i.test(snapshotOf(ownerBoth))], [false, false, false]);

  console.log('\nR7: untested hypotheses and the latest analysis run (FF_GRAPH)');
  const both = snapshotOf(ownerBoth);
  check('untested: a hypothesis no result tests, and one tested only by a superseded result; not one a live result tests', [both.includes('Untested hypotheses (2 of 3): H2 Open Beta; H3 Stale Gamma'), /Untested hypotheses[^\n]*H1 Tested Alpha/.test(both)], [true, false]);
  check('a superseded hypothesis is neither counted nor listed', [both.includes('H4 Superseded Delta'), both.includes('of 3')], [false, true]);
  check('the latest live run by when it was recorded: label, status, engine, date', both.includes('Latest analysis run: Run Latest Zeta (succeeded; pls-sem; recorded 2026-09-20)'), true);
  check('a newer but superseded run is not the latest; an older one is not shown', [both.includes('Run Superseded Eta'), both.includes('Run Older Epsilon')], [false, false]);
  check('no result value, hash, seed, method, engine version or statement is copied in', ['0.3737', '0.5151', 'hash-secret', '777', '4242', 'Bootstrap Secret', '9.9.9', 'Statement Secret', 'Def Secret'].filter((text) => ownerBoth.prompt.includes(text)), []);
  check('nothing of another project', [ownerBoth.prompt.includes('Foreign Hypothesis Kappa'), ownerBoth.prompt.includes('Foreign Run Kappa')], [false, false]);
  check('a VIEWER member gets the same graph lines', [snapshotOf(await build(viewer)).includes('Untested hypotheses (2 of 3)'), snapshotOf(await build(viewer)).includes('Latest analysis run: Run Latest Zeta')], [true, true]);
  const strangerBoth = (await build(stranger)).prompt;
  check('a non-member gets none of it', ['Untested', 'Latest analysis run', 'Open Beta', 'Run Latest Zeta'].filter((text) => strangerBoth.includes(text)), []);
  setFlags({ v2: true });
  const noGraph = (await build(owner)).prompt;
  check('with FF_GRAPH off: no untested hypotheses, no run, no graph label', ['Untested', 'Latest analysis run', 'Open Beta', 'Run Latest Zeta', 'Research graph:'].filter((text) => noGraph.includes(text)), []);
  setFlags({ v2: false, graph: true });
  const v1 = await buildContextPrompt({ purpose: 'answer', request: 'x', userId: owner, projectId: project.id, locale: 'en' });
  check('with FF_CONTEXT_V2 off (v1, even with FF_GRAPH): none of the R7 lines', [v1.request, ['quarantined number', 'untraced number', 'Untested', 'Latest analysis run'].filter((text) => v1.prompt.includes(text))], [undefined, []]);
  setFlags({ v2: true, graph: true });
  check('the tested-hypotheses read is per project (another project’s member sees only theirs)', (await graph.testedHypothesisIds(other.id, { userId: stranger })).size, 0);
  check('the tested-hypotheses read is member-scoped (a stranger is refused)', await graph.testedHypothesisIds(project.id, { userId: stranger }).then(() => 'ok', (error: unknown) => (error instanceof AppError ? error.code : 'error')), 'NOT_FOUND');

  console.log('\nR7: snapshot invariants');
  const tight = await build(owner, { maxTokens: 50, request: 'How does Chain Alpha Construct relate?' });
  check('the snapshot is first and pinned, and survives a budget with no room (with its counts and graph lines)', [tight.envelope.fragments[0]!.id, tight.envelope.fragments[0]!.pinned, snapshotOf(tight).includes('2 quarantined numbers'), snapshotOf(tight).includes('Untested hypotheses')], [SNAPSHOT_ID, true, true, true]);
  check('… while the focus slice is dropped by the budget', sliceOf(tight), null);
  check('the snapshot is project data, never an instruction', tight.envelope.fragments[0]!.authority, 'project-data');

  /* ------------------------------------------------------------------ */
  console.log('\nR8: the slice is one hop (k=1), within its caps');
  check('the depth is formally one hop, and the caps are unchanged', [SLICE_DEPTH, MAX_FOCUS, MAX_SLICE_NODES, MAX_SLICE_EDGES], [1, 4, 12, 20]);
  const aroundA = sliceOf(await build(owner, { focusNodeIds: [ids.A!] })) ?? '';
  check('one-hop neighbours are included', aroundA.includes('[construct] Chain Alpha Construct —scoped_by→ [research question] Chain Beta Question'), true);
  check('a second-hop node is not', aroundA.includes('Chain Gamma Gap'), false);
  check('a superseded neighbour is not', (sliceOf(await build(owner, { focusNodeIds: [ids.B!] })) ?? '').includes('Chain Retired Construct'), false);
  check('a focus node of another project yields nothing of it', [(sliceOf(await build(owner, { focusNodeIds: [ids.XH!] })) ?? '').includes('Kappa'), (await build(owner, { focusNodeIds: [ids.XH!] })).prompt.includes('Foreign')], [false, false]);
  check('a non-member gets no slice, even naming a node', sliceOf(await build(stranger, { focusNodeIds: [ids.A!] })), null);
  setFlags({ v2: true });
  check('FF_GRAPH is required for the slice', sliceOf(await build(owner, { focusNodeIds: [ids.A!] })), null);
  setFlags({ v2: true, graph: true });
  check('the slice is unpinned project data (droppable)', [(await build(owner, { focusNodeIds: [ids.A!] })).envelope.fragments.find((entry) => entry.id === FOCUS_SLICE_ID)?.pinned, (await build(owner, { focusNodeIds: [ids.A!] })).envelope.fragments.find((entry) => entry.id === FOCUS_SLICE_ID)?.authority], [false, 'project-data']);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
