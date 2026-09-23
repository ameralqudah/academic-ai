/**
 * Research Graph core (P1-A), against a real PostgreSQL.
 *
 *   DATABASE_URL=postgresql://…/academic_ai_test npm run db:migrate
 *   DATABASE_URL=postgresql://…/academic_ai_test npm run test:graph
 *
 * Builds one fixture project that covers the R6 table (design, instrument,
 * data, analysis, literature, manuscript), then checks the stale set of a
 * change to each of the nine object types, the write path (versions,
 * acknowledgement, conflicts, marks, resolution, pinning, supersede),
 * provenance tracing, edge validation, project isolation, roles and the
 * feature flag.
 */

import 'dotenv/config';

import { and, eq, isNull } from 'drizzle-orm';

import { resetEnvCache } from '@/config/env';
import { db } from '@/server/db';
import { graphEdges, graphNodes, nodeVersions, projectMembers, staleMarks } from '@/server/db/schema';
import { graphAccess } from '@/server/graph/access';
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

async function errorCode(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'no error';
  } catch (error) {
    return error instanceof AppError ? error.code : `unexpected: ${String(error)}`;
  }
}

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
  const actor = { userId: owner };

  const project = await projectsRepo.create({
    userId: owner,
    title: 'Graph fixture',
    academicField: 'Management',
    degree: 'MASTER',
    researchType: 'QUANTITATIVE',
  });
  const other = await projectsRepo.create({
    userId: stranger,
    title: 'Someone else',
    academicField: 'Management',
    degree: 'MASTER',
    researchType: 'QUANTITATIVE',
  });
  const P = project.id;

  console.log('\nMembership');
  const members = await db.select().from(projectMembers).where(eq(projectMembers.projectId, P));
  check('creating a project makes its creator OWNER', members.map((m) => [m.userId === owner, m.role]), [[true, 'OWNER']]);

  /* ------------------------------------------------------------------ */
  /*                             Fixture                                */
  /* ------------------------------------------------------------------ */

  const names = new Map<string, string>();
  const ids: Record<string, string> = {};
  async function node(key: string, type: string, data: Record<string, unknown> = {}) {
    const created = await graph.createNode(P, actor, { type, label: key, data });
    ids[key] = created.id;
    names.set(created.id, key);
    return created;
  }

  /** Links, acknowledging whatever the link itself changes (the fixture is built bottom-up). */
  async function link(src: string, rel: string, dst: string) {
    const input = { srcId: ids[src]!, rel, dstId: ids[dst]! };
    try {
      await graph.link(P, actor, input);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'IMPACT_ACK_REQUIRED') throw error;
      const report = (error.details as { report: { hash: string } }).report;
      await graph.link(P, actor, { ...input, impactAcknowledged: report.hash });
    }
  }

  await node('G', 'gap', { statement: 'No evidence on trust in e-government in Jordan' });
  await node('RQ', 'research_question', { text: 'Does trust drive adoption?' });
  await node('O', 'objective', { text: 'Measure the effect of trust' });
  await node('S', 'source', { title: 'Mayer et al. 1995' });
  await node('S2', 'source', { title: 'Gefen 2003' });
  await node('C', 'construct', { name: 'Trust', definition: 'Willingness to be vulnerable', kind: 'reflective' });
  await node('C2', 'construct', { name: 'Adoption', definition: 'Intention to use', kind: 'reflective' });
  await node('I1', 'instrument_item', { code: 'TR1', wording: 'I trust the portal', scaleMin: 1, scaleMax: 5 });
  await node('I2', 'instrument_item', { code: 'TR2', wording: 'The portal is reliable', scaleMin: 1, scaleMax: 5 });
  await node('I3', 'instrument_item', { code: 'AD1', wording: 'I intend to use it', scaleMin: 1, scaleMax: 5 });
  await node('INS', 'instrument', { title: 'Survey v1' });
  await node('M', 'conceptual_model', { name: 'Research model' });
  await node('E1', 'model_element', { kind: 'latent' });
  await node('E2', 'model_element', { kind: 'latent' });
  await node('EP', 'model_element', { kind: 'path' });
  await node('H', 'hypothesis', { code: 'H1', statement: 'Trust increases adoption', kind: 'direct', direction: 'positive' });
  await node('A', 'analysis', { name: 'PLS model', method: 'pls_sem', spec: { bootstrap: 5000 } });
  await node('DV', 'dataset_version', { version: 1, contentHash: 'aaa', rows: 300 });
  await node('COL1', 'dataset_column', { name: 'TR1' });
  await node('COL2', 'dataset_column', { name: 'TR2' });
  await node('COL3', 'dataset_column', { name: 'AD1' });
  await node('T', 'transform_step', { op: 'drop_straightliners' });
  await node('DV2', 'dataset_version', { version: 2, contentHash: 'bbb', rows: 287 });
  await node('R', 'analysis_run', { engine: 'ts-pls', engineVersion: '1' });
  await node('V', 'result_value', { stat: 'beta', value: 0.42, p: 0.001 });
  await node('TBL', 'result_table', { title: 'Path coefficients' });
  await node('CI', 'citation', { claim: 'Trust is willingness to be vulnerable', support: 'supports' });
  await node('SEC', 'section', { key: 'results', text: 'Results…' });
  await node('B1', 'block', { text: 'H1 was supported (β = .42, p < .001).' });
  await node('B2', 'block', { text: 'Trust is defined as…' });
  await node('B3', 'block', { text: 'As Gefen (2003) shows…' });
  await node('B4', 'block', { text: 'We hypothesise that trust…' });
  await node('B5', 'block', { text: 'Item TR1 asked…' });
  await node('ABS', 'block', { text: 'Abstract…' });
  await node('XR', 'block', { text: 'See Table 2 in the Results.' });
  await node('SUB', 'submission', { journal: 'JIS' });
  await node('RESP', 'response', { text: 'We revised the results.' });

  const links: [string, string, string][] = [
    ['RQ', 'addresses', 'G'],
    ['O', 'operationalizes', 'RQ'],
    ['C', 'defined_by', 'S'],
    ['I1', 'measures', 'C'],
    ['I2', 'measures', 'C'],
    ['I3', 'measures', 'C2'],
    ['INS', 'has_item', 'I1'],
    ['INS', 'has_item', 'I2'],
    ['INS', 'has_item', 'I3'],
    ['E1', 'represents', 'C'],
    ['E2', 'represents', 'C2'],
    ['M', 'contains', 'E1'],
    ['M', 'contains', 'E2'],
    ['M', 'contains', 'EP'],
    ['H', 'relates', 'C'],
    ['H', 'relates', 'C2'],
    ['H', 'posits', 'EP'],
    ['CI', 'of_source', 'S2'],
    ['CI', 'about', 'C'],
    ['H', 'grounded_in', 'CI'],
    ['A', 'specifies', 'M'],
    ['A', 'specifies', 'H'],
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
    ['R', 'executes', 'A'],
    ['R', 'uses_data', 'DV2'],
    ['V', 'produced_by', 'R'],
    ['TBL', 'produced_by', 'R'],
    ['V', 'tests', 'H'],
    ['B1', 'reports', 'V'],
    ['B1', 'part_of', 'SEC'],
    ['B2', 'describes', 'C'],
    ['B3', 'cites', 'CI'],
    ['B4', 'describes', 'H'],
    ['B5', 'describes', 'I1'],
    ['ABS', 'summarizes', 'SEC'],
    ['XR', 'refers_to', 'TBL'],
    ['XR', 'refers_to', 'SEC'],
    ['SUB', 'snapshot_of', 'SEC'],
    ['RESP', 'changes', 'SEC'],
  ];
  for (const [src, rel, dst] of links) await link(src, rel, dst);

  // Building the fixture flagged things (a model gaining elements, …). Start clean.
  for (const mark of await graph.listStale(P)) await graph.resolveStale(P, mark.nodeId, actor, 'accepted');
  check('fixture starts with no open stale marks', (await graph.listStale(P)).length, 0);

  /* ------------------------------------------------------------------ */
  /*                     R6: the stale set per change                   */
  /* ------------------------------------------------------------------ */

  type Expected = { invalidates?: string[]; review?: string[]; info?: string[] };
  const sorted = (list: string[] = []) => [...list].sort();

  async function expectImpact(title: string, key: string, change: Record<string, unknown>, expected: Expected) {
    const current = await db.select().from(graphNodes).where(eq(graphNodes.id, ids[key]!));
    const report = await graph.previewUpdate(P, ids[key]!, { ...current[0]!.data, ...change });
    const bySeverity = (severity: string) =>
      sorted(report.items.filter((item) => item.severity === severity).map((item) => names.get(item.nodeId) ?? '?'));
    check(`${title}: invalidates`, bySeverity('invalidates'), sorted(expected.invalidates));
    check(`${title}: review`, bySeverity('review'), sorted(expected.review));
    check(`${title}: info`, bySeverity('info'), sorted(expected.info));
    return report;
  }

  console.log('\nConstruct');
  await expectImpact('construct kind (structural)', 'C', { kind: 'formative' }, {
    invalidates: ['E1', 'M', 'A', 'R', 'V', 'TBL', 'B1'],
    review: ['I1', 'I2', 'H', 'CI', 'B2', 'XR'],
  });
  await expectImpact('construct definition (substantive)', 'C', { definition: 'Belief in integrity' }, {
    review: ['I1', 'I2', 'E1', 'H', 'CI', 'B2'],
  });
  const cosmetic = await expectImpact('construct Arabic name (cosmetic)', 'C', { nameAr: 'الثقة' }, {});
  check('cosmetic change needs no acknowledgement', cosmetic.requiresAcknowledgement, false);

  console.log('\nHypothesis');
  await expectImpact('hypothesis direction (structural)', 'H', { direction: 'negative' }, {
    invalidates: ['A', 'R', 'V', 'TBL', 'B1'],
    review: ['EP', 'B4', 'XR'],
  });
  await expectImpact('hypothesis wording (substantive)', 'H', { statement: 'Trust raises adoption' }, {
    review: ['EP', 'A', 'V', 'B4'],
  });

  console.log('\nQuestionnaire item');
  await expectImpact('item reverse-coded (structural)', 'I1', { reverseCoded: true }, {
    invalidates: ['COL1', 'DV', 'T', 'DV2', 'R', 'V', 'TBL', 'B1'],
    review: ['C', 'INS', 'B5', 'XR'],
  });
  await expectImpact('item wording (substantive)', 'I1', { wording: 'I fully trust the portal' }, {
    review: ['C', 'INS', 'COL1', 'B5'],
    info: ['DV'],
  });

  console.log('\nDataset column');
  await expectImpact('column recode (structural)', 'COL1', { recode: { '6': null } }, {
    invalidates: ['DV', 'T', 'DV2', 'R', 'V', 'TBL', 'B1'],
    review: ['XR'],
  });

  console.log('\nDataset version');
  await expectImpact('dataset content (structural)', 'DV2', { contentHash: 'ccc', rows: 280 }, {
    invalidates: ['R', 'V', 'TBL', 'B1'],
    review: ['XR'],
  });

  console.log('\nStatistical model / analysis');
  await expectImpact('analysis spec (structural)', 'A', { spec: { bootstrap: 10000 } }, {
    invalidates: ['R', 'V', 'TBL', 'B1'],
    review: ['XR'],
  });
  await expectImpact('analysis description (cosmetic)', 'A', { description: 'The main model' }, {});

  console.log('\nAnalysis result');
  await expectImpact('result value corrected (structural)', 'V', { value: 0.41 }, {
    invalidates: ['B1'],
  });

  console.log('\nCitation and source');
  await expectImpact('citation contradicted (structural)', 'CI', { support: 'contradicts' }, {
    invalidates: ['B3'],
    review: ['H'],
  });
  await expectImpact('citation partial (substantive)', 'CI', { support: 'partial' }, {
    review: ['B3', 'H'],
  });
  await expectImpact('source retracted (structural)', 'S2', { retracted: true }, {
    invalidates: ['CI', 'B3'],
    review: ['H'],
  });

  console.log('\nManuscript section');
  await expectImpact('section text (substantive)', 'SEC', { text: 'Results, revised…' }, {
    review: ['ABS', 'XR', 'RESP'],
    info: ['SUB'],
  });

  /* ------------------------------------------------------------------ */
  /*                            Write path                              */
  /* ------------------------------------------------------------------ */

  console.log('\nUpdating with an Impact Report');
  const before = await graph.getNode(P, ids.C!);
  const proposed = { ...before.data, kind: 'formative' };

  const refusal = await graph
    .updateNode(P, ids.C!, actor, { data: proposed, expectedVersion: 1 })
    .then(() => null)
    .catch((error: unknown) => error);
  check('a change with consequences is refused without acknowledgement', refusal instanceof AppError && refusal.code, 'IMPACT_ACK_REQUIRED');
  check('refusal returns the report (HTTP 428)', refusal instanceof AppError && refusal.status, 428);
  const report = (refusal as AppError).details as { report: graph.ImpactReport };

  check(
    'a wrong acknowledgement is refused',
    await errorCode(() => graph.updateNode(P, ids.C!, actor, { data: proposed, expectedVersion: 1, impactAcknowledged: 'f'.repeat(64) })),
    'IMPACT_ACK_REQUIRED',
  );
  check(
    'an acknowledgement for a different proposal is refused',
    await errorCode(() =>
      graph.updateNode(P, ids.C!, actor, { data: { ...proposed, definition: 'x' }, expectedVersion: 1, impactAcknowledged: report.report.hash }),
    ),
    'IMPACT_ACK_REQUIRED',
  );

  const updated = await graph.updateNode(P, ids.C!, actor, {
    data: proposed,
    expectedVersion: 1,
    changeNote: 'Formative, per supervisor',
    impactAcknowledged: report.report.hash,
  });
  check('acknowledged change is accepted and versioned', updated.node.currentVersion, 2);
  const versions = await graph.listVersions(P, ids.C!);
  check('node_versions keeps both versions', versions.map((v) => v.version), [2, 1]);
  check('the new version records its kind and the acknowledged report', [versions[0]!.changeKind, versions[0]!.impactReportHash], ['structural', report.report.hash]);
  check('the old version is unchanged', versions[1]!.payload.kind, 'reflective');

  const marks = await db.select().from(staleMarks).where(and(eq(staleMarks.causeNodeId, ids.C!), isNull(staleMarks.resolvedAt)));
  check('one stale mark per affected node', marks.length, report.report.items.length);
  const b1Mark = marks.find((mark) => mark.nodeId === ids.B1);
  check('marks record the propagation path', b1Mark?.path.map((id) => names.get(id)), ['C', 'E1', 'M', 'A', 'R', 'V', 'B1']);
  check('marks record the version that was replaced', b1Mark?.causeVersion, 1);
  const statusOf = async (key: string) => (await graph.getNode(P, ids[key]!)).status;
  check('flagged nodes become stale', [await statusOf('R'), await statusOf('B1'), await statusOf('H')], ['stale', 'stale', 'stale']);
  check('unaffected nodes stay active', [await statusOf('C2'), await statusOf('DV')], ['active', 'active']);

  check(
    'an edit against an old version is refused',
    await errorCode(() => graph.updateNode(P, ids.C!, actor, { data: { ...proposed, definition: 'y' }, expectedVersion: 1 })),
    'CONFLICT',
  );

  const same = await graph.updateNode(P, ids.C!, actor, { data: proposed, expectedVersion: 2 });
  check('an unchanged payload creates no version', same.node.currentVersion, 2);
  const typo = await graph.updateNode(P, ids.C!, actor, { data: { ...proposed, nameAr: 'الثقة' }, expectedVersion: 2 });
  check('a cosmetic change is versioned without acknowledgement', [typo.node.currentVersion, typo.report?.items.length], [3, 0]);
  check(
    'invalid payloads are refused',
    await errorCode(() => graph.updateNode(P, ids.C!, actor, { data: { ...proposed, kind: 'banana' }, expectedVersion: 3 })),
    'VALIDATION',
  );

  console.log('\nResolving staleness');
  const listed = await graph.listStale(P);
  check('the stale list shows the open marks', listed.filter((m) => m.causeNodeId === ids.C).length, marks.length);
  const resolved = await graph.resolveStale(P, ids.B1!, actor, 'accepted');
  check('accepting clears the node’s marks', resolved.resolved, 1);
  check('and returns it to active', await statusOf('B1'), 'active');
  const reopened = (await graph.listStale(P, { includeResolved: true })).find((m) => m.nodeId === ids.B1 && m.causeNodeId === ids.C);
  check('the resolution is kept for audit', reopened?.resolution, 'accepted');

  console.log('\nVersion pinning');
  const a = await graph.getNode(P, ids.A!);
  const specChange = await graph.previewUpdate(P, ids.A!, { ...a.data, spec: { bootstrap: 10000 } });
  await graph.updateNode(P, ids.A!, actor, {
    data: { ...a.data, spec: { bootstrap: 10000 } },
    expectedVersion: a.currentVersion,
    impactAcknowledged: specChange.hash,
  });
  const again = await graph.previewUpdate(P, ids.A!, { ...a.data, spec: { bootstrap: 20000 } });
  check('a run pinned to the old spec is not flagged again by the next change', again.items.some((i) => i.nodeId === ids.R), false);
  await graph.resolveStale(P, ids.R!, actor, 'accepted');
  const [executes] = await db.select().from(graphEdges).where(and(eq(graphEdges.srcId, ids.R!), eq(graphEdges.rel, 'executes')));
  check('accepting re-pins the run to the current spec', executes?.dstVersion, a.currentVersion + 1);
  const afterAccept = await graph.previewUpdate(P, ids.A!, { ...a.data, spec: { bootstrap: 20000 } });
  check('so the next change flags it again', afterAccept.items.find((i) => i.nodeId === ids.R)?.severity, 'invalidates');

  console.log('\nSupersede (new dataset version, newer run)');
  await node('DV3', 'dataset_version', { version: 3, contentHash: 'ddd', rows: 285 });
  await link('DV3', 'derived_from', 'DV2');
  const superseding = await graph
    .supersede(P, ids.DV2!, ids.DV3!, actor)
    .then(() => null)
    .catch((error: unknown) => error);
  const supersedeReport = ((superseding as AppError).details as { report: graph.ImpactReport }).report;
  const supersedeSet = (severity: string) =>
    sorted(supersedeReport.items.filter((i) => i.severity === severity).map((i) => names.get(i.nodeId) ?? '?'));
  check('new dataset version: runs on the old one, and what reports them, need review', supersedeSet('review'), sorted(['R', 'V', 'TBL', 'B1', 'XR']));
  check('the replacement itself is not flagged', supersedeReport.items.some((i) => i.nodeId === ids.DV3), false);
  await graph.supersede(P, ids.DV2!, ids.DV3!, actor, supersedeReport.hash);
  check('the old version is marked superseded', await statusOf('DV2'), 'superseded');
  const [supersedes] = await db.select().from(graphEdges).where(and(eq(graphEdges.srcId, ids.DV3!), eq(graphEdges.rel, 'supersedes')));
  check('and linked from its replacement', supersedes?.dstId === ids.DV2, true);

  await node('R2', 'analysis_run', { engine: 'ts-pls', engineVersion: '1' });
  const runReport = await graph
    .supersede(P, ids.R!, ids.R2!, actor)
    .catch((error: unknown) => ((error as AppError).details as { report: graph.ImpactReport }).report);
  const runSet = sorted((runReport as graph.ImpactReport).items.map((i) => `${names.get(i.nodeId)}:${i.severity}`));
  check('newer run: blocks reporting the old values need review', runSet, sorted(['V:review', 'TBL:review', 'B1:review', 'XR:review']));

  /* ------------------------------------------------------------------ */
  /*                         Trace and edges                            */
  /* ------------------------------------------------------------------ */

  console.log('\nProvenance trace');
  const up = await graph.trace(P, ids.B1!, 'up', 10);
  const upNames = new Set(up.nodes.map((n) => names.get(n.id)));
  check(
    'a reported number traces back to its run, data, analysis, model, hypothesis and construct',
    ['V', 'R', 'DV2', 'DV', 'A', 'M', 'H', 'E1', 'C', 'I1', 'COL1'].every((key) => upNames.has(key)),
    true,
  );
  const down = await graph.trace(P, ids.S2!, 'down', 10);
  check('a source traces forward to the text that cites it', ['CI', 'B3', 'H'].every((key) => down.nodes.some((n) => names.get(n.id) === key)), true);

  console.log('\nEdge rules');
  check('unknown relation', await errorCode(() => graph.link(P, actor, { srcId: ids.C!, rel: 'likes', dstId: ids.S! })), 'VALIDATION');
  check('wrong types for the relation', await errorCode(() => graph.link(P, actor, { srcId: ids.C!, rel: 'measures', dstId: ids.S! })), 'VALIDATION');
  check('self-dependency', await errorCode(() => graph.link(P, actor, { srcId: ids.C!, rel: 'defined_by', dstId: ids.C! })), 'VALIDATION');
  check('duplicate edge', await errorCode(() => graph.link(P, actor, { srcId: ids.C!, rel: 'defined_by', dstId: ids.S! })), 'CONFLICT');
  check('unknown node type', await errorCode(() => graph.createNode(P, actor, { type: 'banana' })), 'VALIDATION');

  // Accepting re-pins every dependency to the current versions, so the next
  // change is measured against the whole graph again.
  for (const mark of await graph.listStale(P)) await graph.resolveStale(P, mark.nodeId, actor, 'accepted');
  const [measures] = await db.select().from(graphEdges).where(and(eq(graphEdges.srcId, ids.I2!), eq(graphEdges.rel, 'measures')));
  const unlinkRefusal = await graph
    .unlink(P, measures!.id)
    .then(() => null)
    .catch((error: unknown) => error);
  check('removing an item from a construct needs acknowledgement', unlinkRefusal instanceof AppError && unlinkRefusal.code, 'IMPACT_ACK_REQUIRED');
  const unlinkReport = ((unlinkRefusal as AppError).details as { report: graph.ImpactReport }).report;
  check('because it changes the construct’s measurement', unlinkReport.items.find((i) => i.nodeId === ids.E1)?.severity, 'invalidates');
  await graph.unlink(P, measures!.id, unlinkReport.hash);
  check('acknowledged, the edge is gone', (await db.select().from(graphEdges).where(eq(graphEdges.id, measures!.id))).length, 0);

  /* ------------------------------------------------------------------ */
  /*                     Isolation, roles, flag                         */
  /* ------------------------------------------------------------------ */

  console.log('\nIsolation and roles');
  const foreign = await graph.createNode(other.id, { userId: stranger }, { type: 'construct', data: { name: 'Theirs' } });
  check('a stranger cannot see the project', await errorCode(() => graphAccess(P, stranger, 'VIEWER')), 'NOT_FOUND');
  check('an unknown project looks the same', await errorCode(() => graphAccess('no-such-project', owner, 'VIEWER')), 'NOT_FOUND');
  check('a node from another project cannot be read through this one', await errorCode(() => graph.getNode(P, foreign.id)), 'NOT_FOUND');
  check('or linked into it', await errorCode(() => graph.link(P, actor, { srcId: ids.C!, rel: 'defined_by', dstId: foreign.id })), 'NOT_FOUND');
  check('or updated through it', await errorCode(() => graph.updateNode(P, foreign.id, actor, { data: { name: 'x' }, expectedVersion: 1 })), 'NOT_FOUND');
  const foreignImpact = await graph.previewUpdate(other.id, foreign.id, { name: 'Theirs, renamed' });
  check('impact never crosses projects', foreignImpact.items.length, 0);

  await db.insert(projectMembers).values([
    { projectId: P, userId: viewer, role: 'VIEWER' },
    { projectId: P, userId: editor, role: 'EDITOR' },
  ]);
  check('a viewer can read', await graphAccess(P, viewer, 'VIEWER'), 'VIEWER');
  check('a viewer cannot edit', await errorCode(() => graphAccess(P, viewer, 'EDITOR')), 'FORBIDDEN');
  check('an editor can edit', await graphAccess(P, editor, 'EDITOR'), 'EDITOR');
  check('an editor is not an owner', await errorCode(() => graphAccess(P, editor, 'OWNER')), 'FORBIDDEN');

  process.env.FF_GRAPH = 'false';
  resetEnvCache();
  check('with FF_GRAPH off the API does not exist', await errorCode(() => graphAccess(P, owner, 'VIEWER')), 'NOT_FOUND');
  process.env.FF_GRAPH = 'true';
  resetEnvCache();

  console.log('\nImpact engine');
  const cycle: ImpactEdge[] = [
    { srcId: 'x', rel: 'produced_by', dstId: 'y', dstVersion: null },
    { srcId: 'y', rel: 'produced_by', dstId: 'x', dstVersion: null },
  ];
  const cyclic = await computeImpact(
    { nodeId: 'x', fromVersion: 1, kind: 'structural' },
    {
      dependentsOf: async (nodeIds) => cycle.filter((edge) => nodeIds.includes(edge.dstId)),
      dependenciesOf: async () => [],
    },
  );
  check('a cycle terminates and never flags the changed node', cyclic.map((i) => i.nodeId), ['y']);

  console.log('\nCascade');
  await db.delete(graphNodes).where(eq(graphNodes.projectId, other.id));
  check('deleting nodes removes their versions', (await db.select().from(nodeVersions).where(eq(nodeVersions.nodeId, foreign.id))).length, 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
