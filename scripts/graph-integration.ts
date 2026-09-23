/**
 * Research Graph (P1-A + P1-A.1 hardening), against a real PostgreSQL.
 *
 *   DATABASE_URL=postgresql://…/academic_ai_test npm run db:migrate
 *   DATABASE_URL=postgresql://…/academic_ai_test npm run test:graph
 *
 * Every scenario builds a fresh fixture project covering the whole chain:
 *
 *   research question → constructs → hypotheses → items → columns /
 *   transformations → model → analysis → run → values → tables → claims /
 *   text → citations / evidence
 *
 * with the run and its outputs recorded through the engine path
 * (`recordRun`), then checks: the exact stale set of a change to each object
 * type (R6); the write path; resolution rules; version pinning; supersede and
 * re-run; result provenance and verification; the regression scenarios A–I of
 * the hardening brief; and the database-level guarantees (cross-project edges,
 * immutable history, immutable computed results, payload cap, service-level
 * authorisation, feature flag). Findings F-1 … F-24 refer to
 * docs/phase1/P1A_REVIEW.md.
 */

import 'dotenv/config';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { resetEnvCache } from '@/config/env';
import { db } from '@/server/db';
import { graphEdges, graphNodes, nodeVersions, projectMembers, researchProjects, staleMarks } from '@/server/db/schema';
import { graphEnabled } from '@/server/graph/access';
import { computeImpact, type ImpactEdge } from '@/server/graph/impact';
import * as graph from '@/server/graph/service';
import { AppError } from '@/server/http/errors';
import * as projectsRepo from '@/server/repositories/projects.repository';
import { register } from '@/server/services/account.service';

const RUN = `graph-${Date.now()}`;
let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         expected ${JSON.stringify(expected)}\n         got      ${JSON.stringify(actual)}`}`);
}

/** The error code, plus the refusal reason for conflicts ("CONFLICT:frozen"). */
async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    if (!(error instanceof AppError)) return `unexpected: ${String(error).slice(0, 160)}`;
    const reason = (error.details as { reason?: string } | undefined)?.reason;
    return reason ? `${error.code}:${reason}` : error.code;
  }
}

/** Whether PostgreSQL itself refused the statement. */
async function databaseRefuses(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return false;
  } catch (error) {
    return !(error instanceof AppError);
  }
}

/** Runs a write, acknowledging the Impact Report it asks for. */
async function acknowledged<T>(work: (ack?: string) => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'IMPACT_ACK_REQUIRED') throw error;
    return work((error.details as { report: graph.ImpactReport }).report.hash);
  }
}

const sorted = (list: string[] = []) => [...list].sort();

async function main() {
  process.env.FF_GRAPH = 'true';
  resetEnvCache();

  const user = async (name: string) =>
    (
      await register({
        name,
        email: `${RUN}-${name.toLowerCase()}@example.test`,
        password: 'Passw0rd123',
        confirmPassword: 'Passw0rd123',
        locale: 'en',
      })
    ).id;

  const owner = await user('Owner');
  const stranger = await user('Stranger');
  const viewer = await user('Viewer');
  const editor = await user('Editor');
  const me: graph.Actor = { userId: owner };
  const engine: graph.Actor = { userId: owner, origin: 'engine' };

  const newProject = (title: string, userId = owner) =>
    projectsRepo.create({ userId, title, academicField: 'Management', degree: 'MASTER', researchType: 'QUANTITATIVE' });

  /* ------------------------------------------------------------------ */
  /*                              Fixture                               */
  /* ------------------------------------------------------------------ */

  async function fixture() {
    const P = (await newProject('Graph fixture')).id;
    const ids: Record<string, string> = {};
    const names = new Map<string, string>();
    const name = (id: string) => names.get(id) ?? '?';
    const remember = (key: string, id: string) => {
      ids[key] = id;
      names.set(id, key);
    };

    const node = async (key: string, type: string, data: Record<string, unknown> = {}) => {
      const created = await graph.createNode(P, me, { type, label: key, data });
      remember(key, created.id);
      return created;
    };
    const link = (src: string, rel: string, dst: string, extra: { allowStaleTarget?: boolean } = {}) =>
      acknowledged((ack) => graph.link(P, me, { srcId: ids[src]!, rel, dstId: ids[dst]!, impactAcknowledged: ack, ...extra }));
    const get = (key: string) => graph.getNode(P, me, ids[key]!);
    const status = async (key: string) => (await get(key)).status;
    const currency = (key: string) => graph.assess(P, me, ids[key]!);
    const openMarks = async (key: string) =>
      (await get(key)).openStaleMarks.map(({ causeNodeId, causeVersion, kind }) => ({ causeNodeId, causeVersion, kind }));
    const resolve = async (key: string, resolution: 'accepted' | 'regenerated' | 'dismissed') =>
      graph.resolveStale(P, me, ids[key]!, resolution, await openMarks(key));
    const update = async (key: string, change: Record<string, unknown>) => {
      const current = await get(key);
      return acknowledged((ack) =>
        graph.updateNode(P, me, ids[key]!, { data: { ...current.data, ...change }, expectedVersion: current.currentVersion, impactAcknowledged: ack }),
      );
    };
    /** The stale set a change would produce, by severity (dry run). */
    const preview = async (key: string, change: Record<string, unknown>) => {
      const current = await get(key);
      const report = await graph.previewUpdate(P, me, ids[key]!, { ...current.data, ...change });
      const of = (severity: string) => sorted(report.items.filter((item) => item.severity === severity).map((item) => name(item.nodeId)));
      return { invalidates: of('invalidates'), review: of('review'), info: of('info'), report };
    };
    const edgeOf = async (src: string, rel: string, dst: string) => {
      const [edge] = await db
        .select()
        .from(graphEdges)
        .where(and(eq(graphEdges.srcId, ids[src]!), eq(graphEdges.rel, rel), eq(graphEdges.dstId, ids[dst]!)));
      return edge!;
    };
    /** Resolves every open mark, upstream first, as the author would after reviewing. */
    const settle = async () => {
      for (let pass = 0; pass < 10; pass += 1) {
        const open = [...new Set((await graph.listStale(P, me)).map((mark) => mark.nodeId))];
        if (open.length === 0) return;
        for (const id of open) {
          const key = name(id);
          await resolve(key, 'accepted').catch(() => undefined);
        }
      }
    };

    await node('G', 'gap', { statement: 'No evidence on trust in e-government in Jordan' });
    await node('RQ', 'research_question', { text: 'Does trust drive adoption of e-government?' });
    await node('O', 'objective', { text: 'Estimate the effect of trust on adoption' });
    await node('S', 'source', { title: 'Mayer, Davis & Schoorman 1995' });
    await node('S2', 'source', { title: 'Gefen, Karahanna & Straub 2003' });
    await node('C', 'construct', { name: 'Trust', definition: 'Willingness to be vulnerable', kind: 'reflective' });
    await node('C2', 'construct', { name: 'Adoption', definition: 'Intention to use', kind: 'reflective' });
    await node('I1', 'instrument_item', { code: 'TR1', wording: 'I trust the portal', scaleMin: 1, scaleMax: 5 });
    await node('I2', 'instrument_item', { code: 'TR2', wording: 'The portal is reliable', scaleMin: 1, scaleMax: 5 });
    await node('I3', 'instrument_item', { code: 'AD1', wording: 'I intend to use it', scaleMin: 1, scaleMax: 5 });
    await node('INS', 'instrument', { title: 'Survey v1' });
    await node('M', 'conceptual_model', { name: 'Research model', type: 'pls_sem' });
    await node('E1', 'model_element', { kind: 'latent', measurement: 'reflective' });
    await node('E2', 'model_element', { kind: 'latent', measurement: 'reflective' });
    await node('EP', 'model_element', { kind: 'path', role: 'direct' });
    await node('H', 'hypothesis', { code: 'H1', statement: 'Trust increases adoption', kind: 'direct', direction: 'positive' });
    await node('A', 'analysis', { name: 'PLS model', method: 'pls_sem', spec: { bootstrap: 5000 } });
    await node('DV', 'dataset_version', { version: 1, contentHash: 'aaa', rows: 300 });
    await node('COL1', 'dataset_column', { name: 'TR1' });
    await node('COL2', 'dataset_column', { name: 'TR2' });
    await node('COL3', 'dataset_column', { name: 'AD1' });
    await node('T', 'transform_step', { op: 'drop_straightliners' });
    await node('DV2', 'dataset_version', { version: 2, contentHash: 'bbb', rows: 287 });
    await node('CI', 'citation', { claim: 'Trust predicts adoption', support: 'supports' });
    await node('EV', 'evidence', { text: 'β = .35 in a US sample' });
    await node('SEC', 'section', { key: 'results', text: '' });
    await node('B1', 'block', { text: 'H1 was supported (β = .42, p < .001).' });
    await node('CL', 'claim', { text: 'β = .42, p < .001' });
    await node('B2', 'block', { text: 'Trust is defined as…' });
    await node('B3', 'block', { text: 'As Gefen et al. (2003) show, trust predicts adoption.' });
    await node('CL2', 'claim', { text: 'trust predicts adoption' });
    await node('B4', 'block', { text: 'We hypothesise that trust…' });
    await node('B5', 'block', { text: 'Item TR1 asked…' });
    await node('ABS', 'block', { text: 'Abstract…' });
    await node('XR', 'block', { text: 'See Table 2 in the Results.' });
    await node('SUB', 'submission', { journal: 'JIS' });
    await node('RESP', 'response', { text: 'We revised the results.' });

    const links: [string, string, string][] = [
      ['RQ', 'addresses', 'G'],
      ['O', 'operationalizes', 'RQ'],
      ['C', 'scoped_by', 'RQ'],
      ['C2', 'scoped_by', 'RQ'],
      ['C', 'defined_by', 'S'],
      ['I1', 'measures', 'C'],
      ['I2', 'measures', 'C'],
      ['I3', 'measures', 'C2'],
      ['INS', 'has_item', 'I1'],
      ['INS', 'has_item', 'I2'],
      ['INS', 'has_item', 'I3'],
      ['E1', 'represents', 'C'],
      ['E2', 'represents', 'C2'],
      ['E1', 'indicated_by', 'I1'],
      ['E1', 'indicated_by', 'I2'],
      ['E2', 'indicated_by', 'I3'],
      ['EP', 'connects', 'E1'],
      ['EP', 'connects', 'E2'],
      ['M', 'contains', 'E1'],
      ['M', 'contains', 'E2'],
      ['M', 'contains', 'EP'],
      ['H', 'answers', 'RQ'],
      ['H', 'relates', 'C'],
      ['H', 'relates', 'C2'],
      ['H', 'posits', 'EP'],
      ['CI', 'of_source', 'S2'],
      ['CI', 'about', 'C'],
      ['EV', 'extracted_from', 'S2'],
      ['H', 'grounded_in', 'CI'],
      ['COL1', 'binds', 'I1'],
      ['COL2', 'binds', 'I2'],
      ['COL3', 'binds', 'I3'],
      ['DV', 'includes', 'COL1'],
      ['DV', 'includes', 'COL2'],
      ['DV', 'includes', 'COL3'],
      ['DV', 'collected_with', 'INS'],
      ['T', 'applies_to', 'COL1'],
      ['DV2', 'derived_from', 'DV'],
      ['DV2', 'transformed_by', 'T'],
      ['A', 'specifies', 'M'],
      ['A', 'specifies', 'H'],
      ['A', 'uses_column', 'COL1'],
      ['A', 'uses_column', 'COL2'],
      ['A', 'uses_column', 'COL3'],
    ];
    for (const [src, rel, dst] of links) await link(src, rel, dst);
    await settle();

    const recorded = await graph.recordRun(P, engine, {
      analysisId: ids.A!,
      datasetVersionIds: [ids.DV2!],
      label: 'R',
      run: { engine: 'ts-pls', engineVersion: '1', seed: 7 },
      results: [
        { key: 'V', type: 'result_value', label: 'V', data: { stat: 'beta', value: 0.42, p: 0.0004 }, tests: [ids.H!] },
        { key: 'TBL', type: 'result_table', label: 'TBL', data: { title: 'Path coefficients' }, showsValues: ['V'] },
      ],
    });
    remember('R', recorded.run.id);
    remember('V', recorded.outputs.V!.id);
    remember('TBL', recorded.outputs.TBL!.id);

    const manuscript: [string, string, string][] = [
      ['SEC', 'has_block', 'B1'],
      ['B1', 'asserts', 'CL'],
      ['CL', 'reports', 'V'],
      ['B2', 'describes', 'C'],
      ['B3', 'asserts', 'CL2'],
      ['CL2', 'cites', 'CI'],
      ['CL2', 'supported_by', 'EV'],
      ['B3', 'cites', 'CI'],
      ['B4', 'describes', 'H'],
      ['B5', 'describes', 'I1'],
      ['ABS', 'summarizes', 'SEC'],
      ['XR', 'refers_to', 'TBL'],
      ['XR', 'refers_to', 'SEC'],
      ['SUB', 'snapshot_of', 'SEC'],
      ['RESP', 'changes', 'SEC'],
    ];
    for (const [src, rel, dst] of manuscript) await link(src, rel, dst);
    await settle();

    return { P, ids, name, remember, node, link, get, status, currency, openMarks, resolve, update, preview, edgeOf, settle };
  }

  /* ------------------------------------------------------------------ */
  /*                               Checks                               */
  /* ------------------------------------------------------------------ */

  console.log('\nFixture and membership');
  const f0 = await fixture();
  const members = await db.select().from(projectMembers).where(eq(projectMembers.projectId, f0.P));
  check('creating a project makes its creator OWNER', members.map((m) => [m.userId === owner, m.role]), [[true, 'OWNER']]);
  check('the fixture starts with no open marks', (await graph.listStale(f0.P, me)).length, 0);
  check('the recorded run is computed and current', [(await f0.get('R')).provenance, (await f0.currency('R')).effective], ['computed', 'current']);
  check('a claim reporting a computed, current value is verified', (await f0.currency('CL')).verification, 'verified');
  check('so is the block that makes the claim', (await f0.currency('B1')).verification, 'verified');
  check('the data the run used is frozen, with its lineage', await Promise.all(['DV2', 'DV', 'COL1', 'T'].map(async (k) => Boolean((await f0.get(k)).frozenAt))), [true, true, true, true]);
  check('the run records the exact versions it used', [(await f0.edgeOf('R', 'executes', 'A')).dstVersion, (await f0.edgeOf('R', 'uses_data', 'DV2')).dstVersion], [1, 1]);

  console.log('\nR6: the stale set of each kind of change (dry run)');
  const expectImpact = async (title: string, key: string, change: Record<string, unknown>, expected: { invalidates?: string[]; review?: string[]; info?: string[] }) => {
    const got = await f0.preview(key, change);
    check(`${title}: invalidates`, got.invalidates, sorted(expected.invalidates));
    check(`${title}: review`, got.review, sorted(expected.review));
    check(`${title}: info`, got.info, sorted(expected.info));
    return got.report;
  };
  const MANUSCRIPT_TAIL = { review: ['SEC', 'ABS', 'XR', 'RESP'], info: ['SUB'] };

  await expectImpact('research question reworded', 'RQ', { text: 'Does trust drive continued use?' }, { review: ['O', 'C', 'C2', 'H'] });
  await expectImpact('construct measurement kind', 'C', { kind: 'formative' }, {
    invalidates: ['E1', 'EP', 'M', 'A', 'R', 'V', 'TBL', 'CL', 'B1'],
    review: ['I1', 'I2', 'H', 'CI', 'B2', ...MANUSCRIPT_TAIL.review],
    info: MANUSCRIPT_TAIL.info,
  });
  await expectImpact('construct definition', 'C', { definition: 'Belief in integrity' }, { review: ['I1', 'I2', 'E1', 'H', 'CI', 'B2'] });
  const cosmetic = await expectImpact('construct Arabic name (cosmetic)', 'C', { nameAr: 'الثقة' }, {});
  check('a cosmetic change needs no acknowledgement', cosmetic.requiresAcknowledgement, false);
  await expectImpact('hypothesis direction', 'H', { direction: 'negative' }, {
    invalidates: ['A', 'R', 'V', 'TBL', 'CL', 'B1'],
    review: ['EP', 'B4', ...MANUSCRIPT_TAIL.review],
    info: MANUSCRIPT_TAIL.info,
  });
  await expectImpact('hypothesis wording', 'H', { statement: 'Trust raises adoption' }, { review: ['EP', 'A', 'V', 'B4'] });
  await expectImpact('item reverse-coded', 'I1', { reverseCoded: true }, {
    invalidates: ['COL1', 'E1', 'EP', 'M', 'DV', 'T', 'DV2', 'A', 'R', 'V', 'TBL', 'CL', 'B1'],
    review: ['C', 'INS', 'B5', 'H', ...MANUSCRIPT_TAIL.review],
    info: MANUSCRIPT_TAIL.info,
  });
  await expectImpact('item reworded', 'I1', { wording: 'I fully trust the portal' }, { review: ['C', 'INS', 'COL1', 'E1', 'B5'], info: ['DV'] });
  await expectImpact('model path direct → moderation (F-9)', 'EP', { role: 'moderation' }, {
    invalidates: ['M', 'A', 'R', 'V', 'TBL', 'CL', 'B1'],
    review: ['H', ...MANUSCRIPT_TAIL.review],
    info: MANUSCRIPT_TAIL.info,
  });
  await expectImpact('latent variable reflective → formative', 'E1', { measurement: 'formative' }, {
    invalidates: ['EP', 'M', 'A', 'R', 'V', 'TBL', 'CL', 'B1'],
    review: ['H', ...MANUSCRIPT_TAIL.review],
    info: MANUSCRIPT_TAIL.info,
  });
  await expectImpact('analysis spec', 'A', { spec: { bootstrap: 10000 } }, {
    invalidates: ['R', 'V', 'TBL', 'CL', 'B1'],
    ...MANUSCRIPT_TAIL,
  });
  await expectImpact('analysis description (cosmetic)', 'A', { description: 'The main model' }, {});
  await expectImpact('citation contradicted', 'CI', { support: 'contradicts' }, { invalidates: ['B3', 'CL2'], review: ['H'] });
  await expectImpact('citation only partly supports', 'CI', { support: 'partial' }, { review: ['B3', 'CL2', 'H'] });
  await expectImpact('source retracted', 'S2', { retracted: true }, { invalidates: ['CI', 'EV', 'B3', 'CL2'], review: ['H'] });
  await expectImpact('results text edited (F-10)', 'B1', { text: 'H1 was supported (β = .41).' }, MANUSCRIPT_TAIL);
  await expectImpact('section edited', 'SEC', { text: 'Results, revised' }, { review: ['ABS', 'XR', 'RESP'], info: ['SUB'] });
  check('a computed value cannot even be previewed as edited', await outcome(() => f0.preview('V', { value: 0.41 })), 'CONFLICT:immutable_result');
  check('a dataset version’s content cannot change (F-6)', await outcome(() => f0.preview('DV2', { contentHash: 'ccc' })), 'CONFLICT:immutable_field');
  check('a column of data a run used cannot be recoded', await outcome(() => f0.preview('COL1', { recode: { '6': null } })), 'CONFLICT:frozen');
  check('a cosmetic note on frozen data is still allowed', await outcome(() => f0.update('COL1', { description: 'Trust item 1' })), 'ok');

  console.log('\nData lineage before any run uses it');
  {
    const f = f0;
    await f.node('DX', 'dataset_version', { version: 1, contentHash: 'x1', rows: 50 });
    await f.node('CX', 'dataset_column', { name: 'Q1' });
    await f.node('TX', 'transform_step', { op: 'recode' });
    await f.node('DX2', 'dataset_version', { version: 2, contentHash: 'x2', rows: 50 });
    await f.link('DX', 'includes', 'CX');
    await f.link('TX', 'applies_to', 'CX');
    await f.link('DX2', 'derived_from', 'DX');
    await f.link('DX2', 'transformed_by', 'TX');
    const change = await f.preview('CX', { recode: { '9': null } });
    check('recoding a column invalidates its version, cleaning step and derived versions', change.invalidates, sorted(['DX', 'TX', 'DX2']));
  }

  /* ------------------------------------------------------------------ */

  console.log('\nWrite path: acknowledgement, versions, conflicts');
  {
    const f = await fixture();
    const before = await f.get('C');
    const proposed = { ...before.data, kind: 'formative' };
    const refusal = await graph.updateNode(f.P, me, f.ids.C!, { data: proposed, expectedVersion: 1 }).catch((error: unknown) => error);
    check('a change with consequences is refused without acknowledgement', refusal instanceof AppError && refusal.code, 'IMPACT_ACK_REQUIRED');
    check('the refusal is HTTP 428 and carries the report', refusal instanceof AppError && refusal.status, 428);
    const report = ((refusal as AppError).details as { report: graph.ImpactReport }).report;
    check('a wrong acknowledgement is refused', await outcome(() => graph.updateNode(f.P, me, f.ids.C!, { data: proposed, expectedVersion: 1, impactAcknowledged: 'f'.repeat(64) })), 'IMPACT_ACK_REQUIRED');
    check('an acknowledgement for another proposal is refused', await outcome(() => graph.updateNode(f.P, me, f.ids.C!, { data: { ...proposed, definition: 'x' }, expectedVersion: 1, impactAcknowledged: report.hash })), 'IMPACT_ACK_REQUIRED');
    const updated = await graph.updateNode(f.P, me, f.ids.C!, { data: proposed, expectedVersion: 1, changeNote: 'Formative, per supervisor', impactAcknowledged: report.hash });
    check('the acknowledged change is versioned', updated.node.currentVersion, 2);
    const versions = await graph.listVersions(f.P, me, f.ids.C!);
    check('both versions are kept', versions.map((v) => v.version), [2, 1]);
    check('the new version records its kind and the acknowledged report', [versions[0]!.changeKind, versions[0]!.impactReportHash], ['structural', report.hash]);
    check('the old version is unchanged', versions[1]!.payload.kind, 'reflective');
    const marks = await db.select().from(staleMarks).where(and(eq(staleMarks.causeNodeId, f.ids.C!), isNull(staleMarks.resolvedAt)));
    check('one mark per affected node', marks.length, report.items.length);
    check('marks record the propagation path', marks.find((m) => m.nodeId === f.ids.B1)?.path.map(f.name), ['C', 'E1', 'M', 'A', 'R', 'V', 'CL', 'B1']);
    check('marks record the replaced version and the flagged node’s own version', [marks[0]!.causeVersion, marks[0]!.nodeVersion], [1, 1]);
    check('flagged nodes become stale; unaffected ones stay active', [await f.status('R'), await f.status('H'), await f.status('C2')], ['stale', 'stale', 'active']);
    check('G: editing an old version is refused', await outcome(() => graph.updateNode(f.P, me, f.ids.C!, { data: { ...proposed, definition: 'y' }, expectedVersion: 1 })), 'CONFLICT:version_conflict');
    check('an unchanged payload creates no version', (await graph.updateNode(f.P, me, f.ids.C!, { data: proposed, expectedVersion: 2 })).node.currentVersion, 2);
    check('invalid payloads are refused', await outcome(() => graph.updateNode(f.P, me, f.ids.C!, { data: { ...proposed, kind: 'banana' }, expectedVersion: 2 })), 'VALIDATION');
    check('a payload over the size limit is refused (F-8)', await outcome(() => graph.createNode(f.P, me, { type: 'note', data: { blob: 'y'.repeat(300_000) } })), 'VALIDATION');
  }

  console.log('\nResolution rules (F-2, F-13)');
  {
    const f = await fixture();
    await f.update('A', { spec: { bootstrap: 10000 } }); // R, V, TBL, CL, B1 invalidated
    const b1Marks = await f.openMarks('B1');
    check('resolving without naming every open mark is refused', await outcome(() => graph.resolveStale(f.P, me, f.ids.B1!, 'accepted', [])), 'CONFLICT:marks_changed');
    check('text cannot be accepted while the number it reports is invalid', await outcome(() => graph.resolveStale(f.P, me, f.ids.B1!, 'accepted', b1Marks)), 'CONFLICT:upstream_not_current');
    check('an invalidated run cannot be accepted — it must be re-run', await outcome(() => f.resolve('R', 'accepted')), 'CONFLICT:rerun_required');
    check('an invalidated computed value cannot be accepted either', await outcome(() => f.resolve('V', 'accepted')), 'CONFLICT:upstream_not_current');
    check('only informational marks can be dismissed', await outcome(() => f.resolve('R', 'dismissed')), 'CONFLICT:dismiss_not_allowed');
    const b1 = await f.currency('B1');
    check('the text reads as invalid, resting on invalid evidence, its numbers not current', [b1.effective, b1.upstream, b1.verification], ['invalid', 'upstream_invalid', 'not_current']);
    check('nothing is regenerated until something is redone', await outcome(() => f.resolve('SEC', 'regenerated')), 'CONFLICT:upstream_not_current');
  }

  console.log('\nVersion pinning never hides a dependent (F-1)');
  {
    const f = await fixture();
    await f.update('C', { nameAr: 'الثقة' }); // cosmetic: new version, no marks
    const after = await f.preview('C', { kind: 'formative' });
    check('after a cosmetic edit, a real change still invalidates the model element', after.invalidates.includes('E1'), true);
    check('… and still asks the describing text for review', after.review.includes('B2'), true);
    check('the cosmetic edit moved the unaffected pins forward', (await f.edgeOf('E1', 'represents', 'C')).dstVersion, 2);
  }
  {
    const f = await fixture();
    await f.update('C', { definition: 'Belief in integrity' }); // B2 → review
    await f.resolve('B2', 'accepted');
    const after = await f.preview('C', { definition: 'Belief in benevolence' });
    check('after an accepted review, the next change flags the text again', after.review.includes('B2'), true);
  }
  {
    const f = await fixture();
    await f.update('I1', { wording: 'I fully trust the portal' }); // DV → info
    await f.resolve('DV', 'dismissed');
    const after = await f.preview('I1', { wording: 'I completely trust the portal' });
    check('after a dismissed note, the next change notes it again', after.info.includes('DV'), true);
  }
  {
    const f = await fixture();
    await f.update('A', { spec: { bootstrap: 10000 } }); // R stale, pinned to A v1
    const again = await f.preview('A', { spec: { bootstrap: 20000 } });
    const run = again.report.items.find((item) => item.nodeId === f.ids.R);
    check('a dependent already stale is flagged again, labelled as already stale', [run?.severity, run?.alreadyStale], ['invalidates', true]);
    check('a run keeps the version it executed', (await f.edgeOf('R', 'executes', 'A')).dstVersion, 1);
  }

  /* ------------------------------------------------------------------ */
  /*                     Regression scenarios A–I                       */
  /* ------------------------------------------------------------------ */

  console.log('\nA. Construct definition changes');
  {
    const f = await fixture();
    await f.update('C', { definition: 'Belief in the portal’s integrity' });
    check('the hypothesis, model element, items and describing text need review', sorted((await graph.listStale(f.P, me)).map((m) => f.name(m.nodeId))), sorted(['I1', 'I2', 'E1', 'H', 'CI', 'B2']));
    check('the model, analysis, run and result are provisional, not current', await Promise.all(['M', 'A', 'R', 'V'].map(async (k) => (await f.currency(k)).effective)), ['provisional', 'provisional', 'provisional', 'provisional']);
    check('the reported number reads as provisional, not verified', (await f.currency('B1')).verification, 'provisional');
    for (const key of ['E1', 'H', 'I1', 'I2', 'CI', 'B2']) await f.resolve(key, 'accepted');
    check('once reviewed and accepted, everything is current again', [(await f.currency('V')).effective, (await f.currency('B1')).verification], ['current', 'verified']);
  }

  console.log('\nB. Dataset version replaced');
  {
    const f = await fixture();
    await f.node('DV3', 'dataset_version', { version: 3, contentHash: 'ddd', rows: 285 });
    await f.link('DV3', 'derived_from', 'DV');
    const report = await acknowledged((ack) => graph.supersede(f.P, me, f.ids.DV2!, f.ids.DV3!, ack));
    const invalidated = sorted(report.items.filter((i) => i.severity === 'invalidates').map((i) => f.name(i.nodeId)));
    check('the run on the old data, its results and the text reporting them are invalidated', invalidated, sorted(['R', 'V', 'TBL', 'CL', 'B1']));
    check('the replacement itself is not flagged', report.items.some((i) => i.nodeId === f.ids.DV3), false);
    check('the old version is kept as superseded', await f.status('DV2'), 'superseded');
    check('the reported number is not current', (await f.currency('B1')).verification, 'not_current');
    check('the old data cannot be edited any more', await outcome(() => f.update('DV2', { description: 'x' })), 'CONFLICT:superseded');
    check('a new run on the old data is refused', await outcome(() => graph.recordRun(f.P, engine, { analysisId: f.ids.A!, datasetVersionIds: [f.ids.DV2!], run: {}, results: [] })), 'CONFLICT:stale_input');
  }

  console.log('\nC. Analysis re-run');
  {
    const f = await fixture();
    await f.update('A', { spec: { bootstrap: 10000 } });
    const rerun = await acknowledged((ack) =>
      graph.recordRun(f.P, engine, {
        analysisId: f.ids.A!,
        datasetVersionIds: [f.ids.DV2!],
        run: { engine: 'ts-pls', engineVersion: '1', seed: 7 },
        results: [{ key: 'V', type: 'result_value', data: { stat: 'beta', value: 0.4, p: 0.001 }, tests: [f.ids.H!] }],
        supersedesRunId: f.ids.R!,
        impactAcknowledged: ack,
      }),
    );
    f.remember('R2', rerun.run.id);
    f.remember('V2', rerun.outputs.V!.id);
    check('the old run is superseded but kept, with its record intact', [await f.status('R'), (await f.edgeOf('R', 'executes', 'A')).dstVersion], ['superseded', 1]);
    check('its value is unchanged and still traceable to it', [(await f.get('V')).data.value, (await graph.trace(f.P, me, f.ids.V!, 'up', 1)).nodes.some((n) => n.id === f.ids.R)], [0.42, true]);
    check('the new run is current, pinned to the new spec, and verified', [(await f.currency('R2')).effective, (await f.edgeOf('R2', 'executes', 'A')).dstVersion, (await f.currency('V2')).verification], ['current', 2, 'verified']);
    check('the old run’s record cannot be removed', await outcome(async () => graph.unlink(f.P, me, (await f.edgeOf('V', 'produced_by', 'R')).id)), 'CONFLICT:engine_record');
    check('the old value cannot be newly cited as current', await outcome(async () => { await f.node('B6', 'block', { text: 'β = .42' }); await f.link('B6', 'reports', 'V'); }), 'CONFLICT:stale_target');
    await f.link('B6', 'reports', 'V', { allowStaleTarget: true });
    check('… and when cited on purpose, the citing text is out of date at once (F-3)', [await f.status('B6'), (await f.currency('B6')).verification], ['stale', 'not_current']);

    // Re-pointing the manuscript to the new run.
    const oldReport = await f.edgeOf('CL', 'reports', 'V');
    await acknowledged((ack) => graph.unlink(f.P, me, oldReport.id, ack));
    await f.link('CL', 'reports', 'V2');
    await f.update('CL', { text: 'β = .40, p = .001' });
    await f.resolve('CL', 'regenerated');
    for (const key of ['B1', 'SEC']) await f.resolve(key, 'accepted');
    check('re-pointed and rewritten, the claim is current and verified again', [(await f.currency('CL')).effective, (await f.currency('CL')).verification, (await f.currency('B1')).verification], ['current', 'verified', 'verified']);
  }

  console.log('\nD. Result provenance removed');
  {
    const f = await fixture();
    const edge = await f.edgeOf('CL', 'reports', 'V');
    const refusal = await graph.unlink(f.P, me, edge.id).catch((error: unknown) => error);
    check('removing the link behind a reported number needs acknowledgement', refusal instanceof AppError && refusal.code, 'IMPACT_ACK_REQUIRED');
    const report = ((refusal as AppError).details as { report: graph.ImpactReport }).report;
    check('the claim is marked untraced, and the text around it flagged', [report.items[0]?.kind, f.name(report.items[0]!.nodeId), report.items.some((i) => i.nodeId === f.ids.B1)], ['untraced', 'CL', true]);
    await graph.unlink(f.P, me, edge.id, report.hash);
    check('the claim can no longer read as verified or current', [(await f.currency('CL')).effective, (await f.currency('CL')).verification, (await f.currency('B1')).verification], ['untraced', 'untraced', 'untraced']);
    check('it cannot be accepted without its evidence', await outcome(() => f.resolve('CL', 'accepted')), 'CONFLICT:provenance_required');
    check('nor marked regenerated without being redone', await outcome(() => f.resolve('CL', 'regenerated')), 'CONFLICT:not_regenerated');
    await f.link('CL', 'reports', 'V');
    await f.resolve('CL', 'regenerated');
    check('re-linked to its value, it is traced again', (await f.currency('CL')).verification, 'verified');
  }

  console.log('\nE. Moderation / mediation / measurement changes');
  {
    const f = await fixture();
    const moderation = await f.preview('EP', { role: 'moderation' });
    check('a direct path becoming a moderation invalidates the analysis and its run', ['A', 'R', 'V'].every((k) => moderation.invalidates.includes(k)), true);
    await f.node('EM', 'model_element', { kind: 'latent', measurement: 'reflective', name: 'Risk' });
    const mediator = await acknowledged((ack) => graph.link(f.P, me, { srcId: f.ids.EP!, rel: 'connects', dstId: f.ids.EM!, attrs: { as: 'mediator' }, impactAcknowledged: ack }));
    check('adding a mediator to the path invalidates the analysis', mediator.report?.items.find((i) => i.nodeId === f.ids.A)?.severity, 'invalidates');
    const indicator = await f.edgeOf('E1', 'indicated_by', 'I2');
    const dropped = await graph.unlink(f.P, me, indicator.id).catch((error: unknown) => ((error as AppError).details as { report: graph.ImpactReport }).report);
    check('dropping an indicator from the measurement model invalidates the analysis', (dropped as graph.ImpactReport).items.find((i) => i.nodeId === f.ids.A)?.severity, 'invalidates');
    const hypothesis = await f.preview('H', { kind: 'mediation' });
    check('turning a direct hypothesis into a mediation one invalidates the analysis', hypothesis.invalidates.includes('A'), true);
  }

  console.log('\nF. Cross-project edges');
  {
    const a = await fixture();
    const theirs = (await newProject('Other', stranger)).id;
    const foreign = await graph.createNode(theirs, { userId: stranger }, { type: 'construct', data: { name: 'Theirs' } });
    check('the service refuses to link another project’s node', await outcome(() => graph.link(a.P, me, { srcId: a.ids.C!, rel: 'defined_by', dstId: foreign.id })), 'NOT_FOUND');
    check('the database refuses a cross-project edge (F-12)', await databaseRefuses(() => db.insert(graphEdges).values({ projectId: a.P, srcId: a.ids.B1!, rel: 'reports', dstId: foreign.id, dependency: true })), true);
    check('… and a cross-project version or mark', await databaseRefuses(() => db.insert(nodeVersions).values({ projectId: a.P, nodeId: foreign.id, version: 9, payload: {}, hash: 'x' })), true);
    check('impact never crosses projects', (await graph.previewUpdate(theirs, { userId: stranger }, foreign.id, { name: 'Renamed' })).items.length, 0);
  }

  console.log('\nG. Old versions');
  {
    const f = await fixture();
    await f.update('H', { statement: 'Trust raises adoption' });
    check('an edit against the old version is refused', await outcome(() => graph.updateNode(f.P, me, f.ids.H!, { data: { statement: 'x', kind: 'direct', direction: 'positive' }, expectedVersion: 1 })), 'CONFLICT:version_conflict');
    check('stored versions cannot be rewritten in the database (F-7)', await databaseRefuses(() => db.update(nodeVersions).set({ payload: { statement: 'forged' } }).where(eq(nodeVersions.nodeId, f.ids.H!))), true);
    check('… nor deleted', await databaseRefuses(() => db.delete(nodeVersions).where(eq(nodeVersions.nodeId, f.ids.H!))), true);
  }

  console.log('\nH. Manually altering a traced result');
  {
    const f = await fixture();
    check('a computed value cannot be edited', await outcome(() => f.update('V', { value: 0.5 })), 'CONFLICT:immutable_result');
    check('nor changed in the database (trigger)', await databaseRefuses(() => db.update(graphNodes).set({ data: { stat: 'beta', value: 0.5 } }).where(eq(graphNodes.id, f.ids.V!))), true);
    check('a manual value cannot be relabelled as computed in the database', await databaseRefuses(async () => {
      const manual = await graph.createNode(f.P, me, { type: 'result_value', data: { stat: 'beta', value: 0.5 } });
      await db.update(graphNodes).set({ provenance: 'computed' }).where(eq(graphNodes.id, manual.id));
    }), true);
    check('a run cannot be created by hand', await outcome(() => graph.createNode(f.P, me, { type: 'analysis_run', data: {} })), 'FORBIDDEN:engine_only');
    check('nor recorded by anyone but the engine', await outcome(() => graph.recordRun(f.P, me, { analysisId: f.ids.A!, datasetVersionIds: [f.ids.DV2!], run: {}, results: [] })), 'FORBIDDEN:engine_only');
    const manual = await graph.createNode(f.P, me, { type: 'result_value', label: 'typed', data: { stat: 'beta', value: 0.51 } });
    f.remember('MV', manual.id);
    check('a typed-in value is classified manual', manual.provenance, 'manual');
    check('it cannot be attached to a run', await outcome(() => graph.link(f.P, me, { srcId: manual.id, rel: 'produced_by', dstId: f.ids.R! })), 'FORBIDDEN:engine_only');
    await f.node('B7', 'block', { text: 'β = .51 (from the pilot)' });
    await f.link('B7', 'reports', 'MV');
    check('text reporting it is shown as manual, never verified', (await f.currency('B7')).verification, 'manual');
    check('a value mixing manual and computed evidence is manual', await (async () => { await f.link('B7', 'reports', 'V'); return (await f.currency('B7')).verification; })(), 'manual');
    check('a manual value can be corrected and stays manual', [await outcome(() => f.update('MV', { value: 0.52 })), (await f.get('MV')).provenance], ['ok', 'manual']);
    check('a computed result cannot gain new dependencies', await outcome(() => graph.link(f.P, me, { srcId: f.ids.TBL!, rel: 'contains_value', dstId: manual.id })), 'CONFLICT:immutable_node');
    check('but a verdict can still be attached to it', await outcome(async () => { await f.node('H2', 'hypothesis', { statement: 'Trust reduces anxiety' }); await graph.link(f.P, me, { srcId: f.ids.V!, rel: 'tests', dstId: f.ids.H2! }); }), 'ok');
  }

  console.log('\nI. Cyclic replacement');
  {
    const f = await fixture();
    await f.node('D1', 'dataset_version', { version: 10, contentHash: 'e1', rows: 10 });
    await f.node('D2', 'dataset_version', { version: 11, contentHash: 'e2', rows: 10 });
    await f.node('D3', 'dataset_version', { version: 12, contentHash: 'e3', rows: 10 });
    await acknowledged((ack) => graph.supersede(f.P, me, f.ids.D1!, f.ids.D2!, ack));
    check('a replaced node cannot replace its successor', await outcome(() => graph.supersede(f.P, me, f.ids.D2!, f.ids.D1!)), 'CONFLICT:superseded');
    check('a node cannot be replaced twice', await outcome(() => graph.supersede(f.P, me, f.ids.D1!, f.ids.D3!)), 'CONFLICT:already_superseded');
    await acknowledged((ack) => graph.supersede(f.P, me, f.ids.D2!, f.ids.D3!, ack));
    check('a chain cannot loop back through its history', await outcome(() => graph.supersede(f.P, me, f.ids.D3!, f.ids.D1!)), 'CONFLICT:superseded');
    const [chain] = await db.execute<{ n: number }>(sql`select count(*)::int as n from graph_edges where project_id = ${f.P} and rel = 'supersedes'`);
    check('the replacement chain D3 → D2 → D1 is recorded', chain?.n, 2);
    // Defence in depth: even if an old node were (wrongly) current again, the chain check refuses the loop.
    await db.update(graphNodes).set({ status: 'active' }).where(eq(graphNodes.id, f.ids.D1!));
    check('the history check refuses a loop on its own', await outcome(() => graph.supersede(f.P, me, f.ids.D3!, f.ids.D1!)), 'CONFLICT:supersede_cycle');
    check('a run cannot be replaced by hand', await outcome(async () => { await graph.supersede(f.P, me, f.ids.R!, f.ids.R!); }), 'FORBIDDEN:engine_only');
    check('superseding needs the same type', await outcome(() => graph.supersede(f.P, me, f.ids.D3!, f.ids.C!)), 'VALIDATION');
  }

  /* ------------------------------------------------------------------ */

  console.log('\nTraceability: the chain end to end');
  {
    const f = f0;
    const up = await graph.trace(f.P, me, f.ids.B1!, 'up', 20);
    const reached = new Set(up.nodes.map((n) => f.name(n.id)));
    check(
      'a reported number traces back through claim, value, run, analysis, model, data and design to the research question',
      ['CL', 'V', 'R', 'A', 'M', 'E1', 'EP', 'H', 'C', 'I1', 'COL1', 'DV2', 'DV', 'T', 'RQ', 'G'].filter((k) => !reached.has(k)),
      [],
    );
    const evidence = await graph.trace(f.P, me, f.ids.B3!, 'up', 10);
    check('a claim traces to its citation, evidence and source', ['CL2', 'CI', 'EV', 'S2'].every((k) => evidence.nodes.some((n) => f.name(n.id) === k)), true);
    const down = await graph.trace(f.P, me, f.ids.S2!, 'down', 10);
    check('a source traces forward to every claim resting on it', ['CI', 'EV', 'CL2', 'B3', 'H'].every((k) => down.nodes.some((n) => f.name(n.id) === k)), true);
    check('a table traces to the values it shows', (await graph.trace(f.P, me, f.ids.TBL!, 'up', 1)).nodes.some((n) => n.id === f.ids.V), true);
  }

  console.log('\nEdge rules');
  {
    const f = f0;
    check('unknown relation', await outcome(() => graph.link(f.P, me, { srcId: f.ids.C!, rel: 'likes', dstId: f.ids.S! })), 'VALIDATION');
    check('wrong types for the relation', await outcome(() => graph.link(f.P, me, { srcId: f.ids.C!, rel: 'measures', dstId: f.ids.S! })), 'VALIDATION');
    check('self-dependency', await outcome(() => graph.link(f.P, me, { srcId: f.ids.C!, rel: 'defined_by', dstId: f.ids.C! })), 'VALIDATION');
    check('duplicate edge', await outcome(() => graph.link(f.P, me, { srcId: f.ids.C!, rel: 'defined_by', dstId: f.ids.S! })), 'CONFLICT:duplicate_edge');
    check('`supersedes` is set only by supersede', await outcome(() => graph.link(f.P, me, { srcId: f.ids.C!, rel: 'supersedes', dstId: f.ids.C2! })), 'VALIDATION');
    check('unknown node type', await outcome(() => graph.createNode(f.P, me, { type: 'banana' })), 'VALIDATION');
    check('frozen data keeps its links', await outcome(async () => graph.unlink(f.P, me, (await f.edgeOf('DV', 'includes', 'COL2')).id)), 'CONFLICT:immutable_node');
  }

  console.log('\nAuthorisation inside the service (F-24), roles, flag');
  {
    const f = f0;
    const them: graph.Actor = { userId: stranger };
    check('a stranger cannot read through the service', await outcome(() => graph.getNode(f.P, them, f.ids.C!)), 'NOT_FOUND');
    check('… list, trace or assess', [await outcome(() => graph.listNodes(f.P, them)), await outcome(() => graph.trace(f.P, them, f.ids.C!, 'up')), await outcome(() => graph.assess(f.P, them, f.ids.C!))], ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
    check('… or write', [await outcome(() => graph.createNode(f.P, them, { type: 'note' })), await outcome(() => graph.updateNode(f.P, them, f.ids.C!, { data: {}, expectedVersion: 1 }))], ['NOT_FOUND', 'NOT_FOUND']);
    check('the engine acting for a stranger is refused too', await outcome(() => graph.recordRun(f.P, { userId: stranger, origin: 'engine' }, { analysisId: f.ids.A!, datasetVersionIds: [f.ids.DV2!], run: {}, results: [] })), 'NOT_FOUND');
    await db.insert(projectMembers).values([
      { projectId: f.P, userId: viewer, role: 'VIEWER' },
      { projectId: f.P, userId: editor, role: 'EDITOR' },
    ]);
    check('a viewer can read', await outcome(() => graph.getNode(f.P, { userId: viewer }, f.ids.C!)), 'ok');
    check('a viewer cannot write', await outcome(() => graph.createNode(f.P, { userId: viewer }, { type: 'note' })), 'FORBIDDEN');
    check('a viewer cannot resolve', await outcome(() => graph.resolveStale(f.P, { userId: viewer }, f.ids.C!, 'accepted', [])), 'FORBIDDEN');
    check('an editor can write', await outcome(() => graph.createNode(f.P, { userId: editor }, { type: 'note' })), 'ok');
    check('an unknown project answers like a hidden one', await outcome(() => graph.getNode('no-such-project', me, f.ids.C!)), 'NOT_FOUND');
    process.env.FF_GRAPH = 'false';
    resetEnvCache();
    check('the feature flag is off by default', graphEnabled(), false);
    process.env.FF_GRAPH = 'true';
    resetEnvCache();
  }

  console.log('\nImpact engine');
  {
    const cycle: ImpactEdge[] = [
      { srcId: 'x', rel: 'produced_by', dstId: 'y', dstVersion: null },
      { srcId: 'y', rel: 'produced_by', dstId: 'x', dstVersion: null },
    ];
    const cyclic = await computeImpact(
      { nodeId: 'x', fromVersion: 1, kind: 'structural' },
      { dependentsOf: async (ids) => cycle.filter((edge) => ids.includes(edge.dstId)), dependenciesOf: async () => [] },
    );
    check('a cycle terminates and never flags the changed node', cyclic.items.map((i) => i.nodeId), ['y']);
  }

  console.log('\nCascade');
  {
    const doomed = (await newProject('to delete')).id;
    const n = await graph.createNode(doomed, me, { type: 'note', data: { notes: 'x' } });
    await graph.updateNode(doomed, me, n.id, { data: { notes: 'y' }, expectedVersion: 1 });
    await db.delete(researchProjects).where(eq(researchProjects.id, doomed));
    check('deleting a project removes its nodes and (immutable) versions by cascade', (await db.select().from(nodeVersions).where(eq(nodeVersions.nodeId, n.id))).length, 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
