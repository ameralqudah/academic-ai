/**
 * P1-A review: tests that expose gaps found in the Research Graph core
 * (docs/phase1/P1A_REVIEW.md). Each check asserts the behaviour the platform
 * needs; a FAIL is a confirmed gap, keyed to its finding (F-n) in the review.
 *
 *   DATABASE_URL=postgresql://…/academic_ai_test npm run test:graph:gaps
 *
 * Deliberately not in CI while the gaps are open: it is expected to fail. As
 * each finding is fixed, its checks move into `scripts/graph-integration.ts`,
 * which is in CI.
 */

import 'dotenv/config';

import { and, eq, sql } from 'drizzle-orm';

import { resetEnvCache } from '@/config/env';
import { db } from '@/server/db';
import { graphEdges, nodeVersions } from '@/server/db/schema';
import { EDGE_RULES } from '@/server/graph/rules';
import * as graph from '@/server/graph/service';
import { AppError } from '@/server/http/errors';
import * as projectsRepo from '@/server/repositories/projects.repository';
import { register } from '@/server/services/account.service';

const RUN = `gaps-${Date.now()}`;
const results: { finding: string; name: string; ok: boolean; detail: string }[] = [];

function expect(finding: string, name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ finding, name, ok, detail: ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` });
  console.log(`  ${ok ? 'ok  ' : 'GAP '} [${finding}] ${name}${ok ? '' : `\n         ${results.at(-1)!.detail}`}`);
}

async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'accepted';
  } catch (error) {
    return error instanceof AppError ? error.code : `error: ${String(error).slice(0, 120)}`;
  }
}

/** Runs a write, acknowledging whatever Impact Report it asks for. */
async function acknowledged<T>(work: (ack?: string) => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'IMPACT_ACK_REQUIRED') throw error;
    return work((error.details as { report: graph.ImpactReport }).report.hash);
  }
}

async function main() {
  process.env.FF_GRAPH = 'true';
  resetEnvCache();

  const owner = (
    await register({ name: 'Gaps', email: `${RUN}@example.test`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123', locale: 'en' })
  ).id;
  const actor = { userId: owner };
  const newProject = (title: string) =>
    projectsRepo.create({ userId: owner, title, academicField: 'Management', degree: 'MASTER', researchType: 'QUANTITATIVE' });

  /** A small fresh graph per scenario, so the scenarios cannot interfere. */
  async function fixture() {
    const P = (await newProject('gap fixture')).id;
    const ids: Record<string, string> = {};
    const node = async (key: string, type: string, data: Record<string, unknown> = {}) => {
      ids[key] = (await graph.createNode(P, actor, { type, label: key, data })).id;
    };
    const link = (src: string, rel: string, dst: string) =>
      acknowledged((ack) => graph.link(P, actor, { srcId: ids[src]!, rel, dstId: ids[dst]!, impactAcknowledged: ack }));
    const update = async (key: string, change: Record<string, unknown>) => {
      const current = await graph.getNode(P, ids[key]!);
      return acknowledged((ack) =>
        graph.updateNode(P, ids[key]!, actor, {
          data: { ...current.data, ...change },
          expectedVersion: current.currentVersion,
          impactAcknowledged: ack,
        }),
      );
    };
    const preview = async (key: string, change: Record<string, unknown>) => {
      const current = await graph.getNode(P, ids[key]!);
      const report = await graph.previewUpdate(P, ids[key]!, { ...current.data, ...change });
      const name = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
      return Object.fromEntries(report.items.map((item) => [name.get(item.nodeId), item.severity]));
    };
    const status = async (key: string) => (await graph.getNode(P, ids[key]!)).status;

    await node('C', 'construct', { name: 'Trust', definition: 'Willingness to be vulnerable', kind: 'reflective' });
    await node('E1', 'model_element', { kind: 'latent' });
    await node('E2', 'model_element', { kind: 'latent' });
    await node('EP', 'model_element', { kind: 'path', role: 'direct' });
    await node('M', 'conceptual_model', { name: 'Model' });
    await node('A', 'analysis', { name: 'PLS', method: 'pls_sem', spec: { bootstrap: 5000 } });
    await node('DV', 'dataset_version', { contentHash: 'aaa', rows: 300 });
    await node('R', 'analysis_run', { engine: 'ts-pls' });
    await node('V', 'result_value', { stat: 'beta', value: 0.42 });
    await node('SEC', 'section', { key: 'results' });
    await node('B1', 'block', { text: 'β = .42' });
    await node('B2', 'block', { text: 'Trust is defined as…' });
    await node('ABS', 'block', { text: 'Abstract: trust matters (β = .42).' });

    await link('E1', 'represents', 'C');
    await link('M', 'contains', 'E1');
    await link('M', 'contains', 'E2');
    await link('M', 'contains', 'EP');
    await link('A', 'specifies', 'M');
    await link('R', 'executes', 'A');
    await link('R', 'uses_data', 'DV');
    await link('V', 'produced_by', 'R');
    await link('B1', 'reports', 'V');
    await link('B1', 'part_of', 'SEC');
    await link('B2', 'describes', 'C');
    await link('ABS', 'summarizes', 'SEC');
    for (const mark of await graph.listStale(P)) await graph.resolveStale(P, mark.nodeId, actor, 'accepted');

    return { P, ids, node, link, update, preview, status };
  }

  console.log('\nVersioning: nothing may silently fall out of impact analysis');
  {
    const f = await fixture();
    await f.update('C', { nameAr: 'الثقة' }); // cosmetic: new version, no marks
    const after = await f.preview('C', { kind: 'formative' });
    expect('F-1', 'a cosmetic edit does not detach dependents from later impact', after.E1 ?? 'not flagged', 'invalidates');
    expect('F-1', '… nor the text describing the construct', after.B2 ?? 'not flagged', 'review');
  }
  {
    const f = await fixture();
    await f.update('C', { definition: 'Belief in integrity' }); // B2: review
    await graph.resolveStale(f.P, f.ids.B2!, actor, 'dismissed');
    const after = await f.preview('C', { definition: 'Belief in benevolence' });
    expect('F-1', 'a dismissed mark does not detach the node from later impact', after.B2 ?? 'not flagged', 'review');
  }

  console.log('\nCurrency: an old number must never read as current');
  {
    const f = await fixture();
    await f.update('A', { spec: { bootstrap: 10000 } }); // R, V, B1 invalidated
    const accepted = await outcome(() => graph.resolveStale(f.P, f.ids.B1!, actor, 'accepted'));
    expect('F-2', 'text cannot be accepted as current while the number it reports is invalid', accepted, 'CONFLICT');
  }
  {
    const f = await fixture();
    await f.node('R2', 'analysis_run', { engine: 'ts-pls' });
    await acknowledged((ack) => graph.supersede(f.P, f.ids.R!, f.ids.R2!, actor, ack));
    const accepted = await outcome(() => graph.resolveStale(f.P, f.ids.B1!, actor, 'accepted'));
    expect('F-2', 'text reporting a superseded run cannot be accepted as current', accepted, 'CONFLICT');

    await f.node('B3', 'block', { text: 'As reported, β = .42' });
    await f.link('B3', 'reports', 'V');
    expect('F-3', 'new text citing a superseded run’s value is flagged at once', await f.status('B3'), 'stale');

    const edit = await outcome(() => f.update('R', { engineVersion: '2' }));
    expect('F-4', 'a superseded node cannot be edited', edit, 'CONFLICT');
    const back = await outcome(() => graph.supersede(f.P, f.ids.R2!, f.ids.R!, actor));
    expect('F-4', 'supersede cannot form a cycle (both ends end up superseded)', back, 'CONFLICT');
  }
  {
    const f = await fixture();
    const [reports] = await db.select().from(graphEdges).where(and(eq(graphEdges.srcId, f.ids.B1!), eq(graphEdges.rel, 'reports')));
    await graph.unlink(f.P, reports!.id);
    expect('F-5', 'removing the link behind a reported number leaves a mark on the text', await f.status('B1'), 'stale');
  }

  console.log('\nIntegrity: engine outputs and data versions are immutable');
  {
    const f = await fixture();
    expect('F-6', 'a user cannot type in a result value', await outcome(() => graph.createNode(f.P, actor, { type: 'result_value', data: { stat: 'beta', value: 0.99 } })), 'FORBIDDEN');
    expect('F-6', 'a result value cannot be edited in place', await outcome(() => f.update('V', { value: 0.5 })), 'CONFLICT');
    expect('F-6', 'a dataset version’s content cannot be edited in place', await outcome(() => f.update('DV', { contentHash: 'zzz', rows: 250 })), 'CONFLICT');
    const tamper = await outcome(() =>
      db.update(nodeVersions).set({ payload: { stat: 'beta', value: 0.99 } }).where(eq(nodeVersions.nodeId, f.ids.V!)),
    );
    expect('F-7', 'stored versions cannot be rewritten, even with direct database access', tamper.startsWith('error'), true);
    expect(
      'F-8',
      'a node cannot hold a multi-megabyte payload',
      await outcome(() => graph.createNode(f.P, actor, { type: 'note', data: { notes: 'x'.repeat(19_000), blob: 'y'.repeat(3_000_000) } })),
      'VALIDATION',
    );
  }

  console.log('\nSemantics: model and manuscript changes');
  {
    const f = await fixture();
    const change = await f.preview('EP', { role: 'moderation' });
    expect('F-9', 'turning a direct path into a moderation invalidates the analysis', change.A ?? 'not flagged', 'invalidates');
  }
  {
    const f = await fixture();
    const change = await f.preview('B1', { text: 'β = .38' });
    expect('F-10', 'editing results text flags the abstract that summarises it', change.ABS ?? 'not flagged', 'review');
  }

  console.log('\nTraceability: the chain research question → … → manuscript claim');
  const linkable = (from: string, to: string) =>
    EDGE_RULES.some((rule) => rule.dependency && (rule.from as readonly string[]).includes(from) && (rule.to as readonly string[]).includes(to));
  expect('F-11', 'a construct can be tied to the research question it serves', linkable('construct', 'research_question') || linkable('research_question', 'construct'), true);
  expect('F-11', 'a hypothesis can be tied to the research question it answers', linkable('hypothesis', 'research_question'), true);
  expect('F-11', 'an indicator (item or column) can be tied to the model element it loads on', linkable('model_element', 'dataset_column') || linkable('model_element', 'instrument_item'), true);
  expect('F-11', 'an analysis can name the columns it uses', linkable('analysis', 'dataset_column') || linkable('analysis_run', 'dataset_column'), true);
  expect('F-11', 'a path element can be tied to the elements it connects', linkable('model_element', 'model_element'), true);
  expect('F-11', 'a results table can be tied to the values it contains', linkable('result_table', 'result_value'), true);
  expect('F-11', 'discussion text can be tied to the interpretation it presents', linkable('block', 'interpretation'), true);

  console.log('\nDatabase-level isolation');
  {
    const a = await fixture();
    const b = await fixture();
    const crossing = await outcome(() =>
      db.insert(graphEdges).values({ projectId: a.P, srcId: a.ids.B1!, rel: 'reports', dstId: b.ids.V!, dependency: true }),
    );
    expect('F-12', 'the database refuses an edge between two projects', crossing.startsWith('error'), true);
  }

  const gaps = results.filter((result) => !result.ok);
  const byFinding = [...new Set(gaps.map((gap) => gap.finding))];
  console.log(`\n${results.length - gaps.length} hold, ${gaps.length} gaps confirmed (${byFinding.join(', ') || 'none'})`);
  await db.execute(sql`select 1`);
  process.exit(gaps.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
