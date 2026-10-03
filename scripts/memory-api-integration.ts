/**
 * Memories end to end against PostgreSQL (P1-E, PR #5).
 *
 *   DATABASE_URL=…/academic_ai_test npm run db:migrate && npm run db:seed
 *   DATABASE_URL=…/academic_ai_test npm run test:memories:db
 *
 * The memory service behind the API (the role matrix, where a memory may be
 * addressed, fail-closed RLS), the request schemas, the agent's proposal tool
 * (proposals only; a person confirms), and memories in Context V2 (confirmed
 * only, authority by scope, cap and order, claim rendering, fail-safe). The
 * HTTP layer (flag, session, rate limits, the pages) is covered by
 * `e2e/memories.spec.ts`.
 */

import 'dotenv/config';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';

import { resetEnvCache } from '@/config/env';
import { buildContextPrompt } from '@/server/context/manager';
import type { TokenCounter } from '@/server/context/token-count';
import { buildContextV2 } from '@/server/context/v2/assembler';
import { hasClaimToken, UNRESOLVED_CLAIM_MARKER } from '@/server/context/v2/claims';
import { MAX_USER_MEMORIES } from '@/server/context/v2/memories';
import { db } from '@/server/db';
import { projectMembers } from '@/server/db/schema';
import * as graph from '@/server/graph/service';
import { AppError } from '@/server/http/errors';
import { setMemoryRlsProbeForTests } from '@/server/memory/db-scope';
import { createMemorySchema, editMemorySchema, MEMORY_BODY_BYTES, MEMORY_READ_LIMIT, MEMORY_WRITE_LIMIT, MEMORY_WRITE_USER_LIMIT, memoriesFlagged } from '@/server/memory/http';
import { createMemory, updateMemory } from '@/server/memory/repository';
import { archiveMemoryIn, confirmMemoryIn, createMemoryIn, deleteMemoryIn, editMemoryIn, listMemoriesIn, type MemoryPlace } from '@/server/memory/service';
import * as projectsRepo from '@/server/repositories/projects.repository';
import { toolByName } from '@/server/runs/registry';
import type { ToolContext } from '@/server/runs/types';
import { register } from '@/server/services/account.service';

const RUN = `memapi-${Date.now()}`;
let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    if (error instanceof AppError) {
      const reason = (error.details as { reason?: string } | undefined)?.reason;
      return reason ? `${error.code}:${reason}` : error.code;
    }
    return `error:${String(error).slice(0, 80)}`;
  }
}

function setFlags(flags: { v2?: boolean; graph?: boolean }) {
  process.env.FF_CONTEXT_V2 = flags.v2 ? 'true' : 'false';
  process.env.FF_GRAPH = flags.graph ? 'true' : 'false';
  process.env.FF_RUNS = 'false';
  resetEnvCache();
}

/** Every exported handler of the memory routes, with the source of its wrapper. */
function routeHandlers(): { file: string; method: string; source: string }[] {
  const roots = ['src/app/api/v1/me/memories', 'src/app/api/v1/projects/[projectId]/memories'];
  const files = roots.flatMap((root) => (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith('route.ts')).map((file) => join(root, file)));
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split(/^export const /m)
      .slice(1)
      .map((block) => {
        const [, method, source] = /^(GET|POST|PATCH|DELETE|PUT) = ([\s\S]*)$/.exec(block) ?? [];
        return { file, method: method ?? '?', source: (source ?? block).replace(/\s+/g, ' ').trim() };
      }),
  );
}

const perChar: TokenCounter = { provider: 'estimate', exact: true, count: (text) => text.length };

async function main() {
  setFlags({ v2: true });
  const user = async (name: string) =>
    (await register({ name, email: `${RUN}-${name}@example.test`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123', locale: 'en' })).id;
  const owner = await user('owner');
  const editor = await user('editor');
  const editor2 = await user('editor2');
  const viewer = await user('viewer');
  const stranger = await user('stranger');
  const demoted = await user('demoted');
  const removed = await user('removed');
  const project = await projectsRepo.create({ userId: owner, title: 'Memory project', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  const other = await projectsRepo.create({ userId: owner, title: 'Owner’s other project', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  await db.insert(projectMembers).values([
    { projectId: project.id, userId: editor, role: 'EDITOR' },
    { projectId: project.id, userId: editor2, role: 'EDITOR' },
    { projectId: project.id, userId: viewer, role: 'VIEWER' },
    { projectId: project.id, userId: demoted, role: 'EDITOR' },
    { projectId: project.id, userId: removed, role: 'EDITOR' },
  ]);
  const me: MemoryPlace = { scope: 'user' };
  const P: MemoryPlace = { scope: 'project', projectId: project.id };
  const Q: MemoryPlace = { scope: 'project', projectId: other.id };
  const missing: MemoryPlace = { scope: 'project', projectId: '00000000-0000-4000-8000-000000000000' };

  /* ------------------------------------------------------------------ */
  console.log('\nrequest schemas (the API validates before the service)');
  check('a memory needs a kind and non-empty content', [createMemorySchema.safeParse({ kind: 'fact', content: '  ' }).success, createMemorySchema.safeParse({ content: 'x' }).success], [false, false]);
  check('content is at most 2000 characters', createMemorySchema.safeParse({ kind: 'fact', content: 'x'.repeat(2001) }).success, false);
  check('a client cannot set status, source, scope, owner or project (unknown fields refused)', ['status', 'source', 'scope', 'userId', 'projectId'].map((field) => createMemorySchema.safeParse({ kind: 'fact', content: 'x', [field]: field === 'status' ? 'confirmed' : 'agent' }).success), [false, false, false, false, false]);
  check('an edit names something to change, and never the status', [editMemorySchema.safeParse({}).success, editMemorySchema.safeParse({ status: 'confirmed' }).success, editMemorySchema.safeParse({ pinned: true }).success], [false, false, true]);
  check('the routes carry their limits and a body cap', [MEMORY_READ_LIMIT.max > 0, MEMORY_WRITE_LIMIT.max > 0, MEMORY_WRITE_USER_LIMIT.max > 0, MEMORY_BODY_BYTES], [true, true, true, 8192]);

  /* ------------------------------------------------------------------ */
  console.log('\nroute wiring (flag gate, limits, body cap on every handler)');
  const routes = routeHandlers();
  check('eight route files, twelve handlers', [new Set(routes.map((route) => route.file)).size, routes.length], [8, 12]);
  check('every handler is behind the flag gate', routes.filter((route) => !route.source.startsWith('memoriesFlagged(')).map((route) => `${route.file} ${route.method}`), []);
  check('every handler has an address limit and a per-user limit', routes.filter((route) => !/rateLimit: MEMORY_(READ|WRITE)_LIMIT, userRateLimit: MEMORY_(READ|WRITE)_USER_LIMIT/.test(route.source)).map((route) => `${route.file} ${route.method}`), []);
  check('every write uses the write limits; reads the read limits', routes.filter((route) => (route.method === 'GET') !== /rateLimit: MEMORY_READ_LIMIT, userRateLimit: MEMORY_READ_USER_LIMIT/.test(route.source)).map((route) => `${route.file} ${route.method}`), []);
  check('every handler with a body has a strict schema and the body cap', routes.filter((route) => route.source.includes('schema:') !== route.source.includes('maxBodyBytes: MEMORY_BODY_BYTES')).map((route) => `${route.file} ${route.method}`), []);
  check('a body is accepted only on create and edit', routes.filter((route) => route.source.includes('schema:')).map((route) => `${route.file.replace(/^.*memories/, '')} ${route.method}`).sort(), ['/[memoryId]/route.ts PATCH', '/[memoryId]/route.ts PATCH', '/route.ts POST', '/route.ts POST']);
  setFlags({ v2: false });
  const gated = await memoriesFlagged(async () => new Response('reached', { status: 200 }))(new Request('http://localhost/api/v1/me/memories'));
  check('with FF_CONTEXT_V2 off, the gate answers 404 before the handler', [gated.status, (await gated.text()).includes('"code":"NOT_FOUND"')], [404, true]);
  setFlags({ v2: true });
  check('with it on, the handler runs', (await memoriesFlagged(async () => new Response('reached', { status: 200 }))(new Request('http://localhost/api/v1/me/memories'))).status, 200);

  /* ------------------------------------------------------------------ */
  console.log('\nuser memories: the owner alone');
  const mine = await createMemoryIn(me, owner, { kind: 'preference', content: 'Cite in APA 7th edition.' });
  check('created as the user’s own, confirmed, source user', [mine.scope, mine.status, mine.source, mine.mine, mine.editable], ['user', 'confirmed', 'user', true, true]);
  check('listed for its user', (await listMemoriesIn(me, owner)).memories.some((memory) => memory.id === mine.id), true);
  check('another user lists none of it', (await listMemoriesIn(me, stranger)).memories.some((memory) => memory.id === mine.id), false);
  check('another user cannot edit, confirm, archive or delete it (not found: nothing is revealed)', [
    await outcome(() => editMemoryIn(me, stranger, mine.id, { content: 'Hijacked' })),
    await outcome(() => confirmMemoryIn(me, stranger, mine.id)),
    await outcome(() => archiveMemoryIn(me, stranger, mine.id)),
    await outcome(() => deleteMemoryIn(me, stranger, mine.id)),
  ], ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
  check('a user memory cannot be addressed through a project, even by its owner', await outcome(() => editMemoryIn(P, owner, mine.id, { content: 'x' })), 'NOT_FOUND');
  check('the owner edits, archives, restores and pins it', [
    (await editMemoryIn(me, owner, mine.id, { content: 'Cite in APA 7.' })).content,
    (await archiveMemoryIn(me, owner, mine.id)).status,
    (await confirmMemoryIn(me, owner, mine.id)).status,
    (await editMemoryIn(me, owner, mine.id, { pinned: true })).pinned,
  ], ['Cite in APA 7.', 'archived', 'confirmed', true]);
  const temporary = await createMemoryIn(me, owner, { kind: 'fact', content: 'Temporary.' });
  await deleteMemoryIn(me, owner, temporary.id);
  check('… and deletes one', (await listMemoriesIn(me, owner)).memories.some((memory) => memory.id === temporary.id), false);

  /* ------------------------------------------------------------------ */
  console.log('\nproject memories: the role matrix');
  const byEditor = await createMemoryIn(P, editor, { kind: 'decision', content: 'We use PLS-SEM.' });
  check('an EDITOR adds a project memory, confirmed', [byEditor.scope, byEditor.status, byEditor.projectId === project.id], ['project', 'confirmed', true]);
  check('a VIEWER cannot add one (forbidden); a stranger, or a project that does not exist, is not found', [
    await outcome(() => createMemoryIn(P, viewer, { kind: 'fact', content: 'x' })),
    await outcome(() => createMemoryIn(P, stranger, { kind: 'fact', content: 'x' })),
    await outcome(() => createMemoryIn(missing, owner, { kind: 'fact', content: 'x' })),
  ], ['FORBIDDEN', 'NOT_FOUND', 'NOT_FOUND']);
  const viewed = await listMemoriesIn(P, viewer);
  check('every member reads them, a VIEWER included, and is told what they may change', [viewed.role, viewed.memories.find((memory) => memory.id === byEditor.id)?.editable], ['VIEWER', false]);
  check('a stranger cannot list them; nor anything of a project that does not exist', [await outcome(() => listMemoriesIn(P, stranger)), await outcome(() => listMemoriesIn(missing, stranger))], ['NOT_FOUND', 'NOT_FOUND']);
  check('the author (EDITOR) and the OWNER may change it; another EDITOR and a VIEWER may not', [
    (await listMemoriesIn(P, editor)).memories.find((memory) => memory.id === byEditor.id)?.editable,
    (await listMemoriesIn(P, owner)).memories.find((memory) => memory.id === byEditor.id)?.editable,
    await outcome(() => editMemoryIn(P, editor2, byEditor.id, { content: 'Changed' })),
    await outcome(() => archiveMemoryIn(P, viewer, byEditor.id)),
    await outcome(() => deleteMemoryIn(P, editor2, byEditor.id)),
  ], [true, true, 'FORBIDDEN:memory_policy', 'FORBIDDEN:memory_policy', 'FORBIDDEN:memory_policy']);
  check('the OWNER edits and archives another member’s memory', [(await editMemoryIn(P, owner, byEditor.id, { content: 'We use PLS-SEM (SmartPLS).' })).content, (await archiveMemoryIn(P, owner, byEditor.id)).status], ['We use PLS-SEM (SmartPLS).', 'archived']);
  await confirmMemoryIn(P, owner, byEditor.id);
  const byDemoted = await createMemoryIn(P, demoted, { kind: 'fact', content: 'Written while an editor.' });
  await db.update(projectMembers).set({ role: 'VIEWER' }).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, demoted)));
  check('a member demoted to VIEWER keeps reading but can no longer change their own memory', [
    (await listMemoriesIn(P, demoted)).memories.some((memory) => memory.id === byDemoted.id),
    await outcome(() => editMemoryIn(P, demoted, byDemoted.id, { content: 'x' })),
    await outcome(() => deleteMemoryIn(P, demoted, byDemoted.id)),
  ], [true, 'FORBIDDEN:memory_policy', 'FORBIDDEN:memory_policy']);
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, removed)));
  check('a removed member loses the project’s memories at once', await outcome(() => listMemoriesIn(P, removed)), 'NOT_FOUND');
  check('a project memory addressed through another project, or through /me, is not found', [
    await outcome(() => editMemoryIn(Q, owner, byEditor.id, { content: 'x' })),
    await outcome(() => deleteMemoryIn(me, editor, byEditor.id)),
    (await listMemoriesIn(Q, owner)).memories.some((memory) => memory.id === byEditor.id),
  ], ['NOT_FOUND', 'NOT_FOUND', false]);
  check('a user’s list never shows project memories', (await listMemoriesIn(me, editor)).memories.every((memory) => memory.scope === 'user'), true);

  /* ------------------------------------------------------------------ */
  console.log('\nRLS fails closed');
  setMemoryRlsProbeForTests(() => async () => {
    throw Object.assign(new Error('role "academic_app" does not exist'), { code: '42704' });
  });
  check('with RLS not enforceable, reads and writes are refused (no application-only fallback)', [
    await outcome(() => listMemoriesIn(me, owner)),
    await outcome(() => createMemoryIn(me, owner, { kind: 'fact', content: 'x' })),
    await outcome(() => listMemoriesIn(P, owner)),
  ], ['UNAVAILABLE:rls_unavailable', 'UNAVAILABLE:rls_unavailable', 'UNAVAILABLE:rls_unavailable']);
  setMemoryRlsProbeForTests(null);
  check('… and with it back, they work again', await outcome(() => listMemoriesIn(me, owner)), 'ok');

  /* ------------------------------------------------------------------ */
  console.log('\nagent proposals: proposed only, a person confirms');
  const tool = toolByName('proposeMemory')!;
  check('the proposal tool is registered, writes, keyed, needs EDITOR, needs no approval', [tool.sideEffect, tool.idempotency, tool.requiredRole, tool.contexts], ['write', 'keyed', 'EDITOR', ['run']]);
  check('its input cannot carry a status or a source', [tool.input.safeParse({ scope: 'user', kind: 'fact', content: 'x', status: 'confirmed' }).success, tool.input.safeParse({ scope: 'user', kind: 'fact', content: 'x', source: 'user' }).success], [false, false]);
  const runId = '11111111-1111-4111-8111-111111111111';
  const ctx = (userId: string, stepId: string): ToolContext => ({ userId, projectId: project.id, tier: 'paid', execution: 'run', runId, stepId, idempotencyKey: `k-${stepId}`, signal: new AbortController().signal });
  const proposed = await tool.execute({ scope: 'project', kind: 'decision', content: 'Report effect sizes with every test.' }, ctx(editor, '22222222-2222-4222-8222-222222222222'));
  const proposal = (await listMemoriesIn(P, editor)).memories.find((memory) => memory.id === (proposed.output as { memoryId: string }).memoryId)!;
  check('a run proposes a project memory: status proposed, source agent, the run and step recorded', [proposal.status, proposal.source, proposal.proposedBy], ['proposed', 'agent', { runId, stepId: '22222222-2222-4222-8222-222222222222' }]);
  const retried = await tool.execute({ scope: 'project', kind: 'decision', content: 'Report effect sizes with every test.' }, ctx(editor, '22222222-2222-4222-8222-222222222222'));
  check('a retried step proposes nothing new', [(retried.output as { memoryId: string; created: boolean }).memoryId === proposal.id, (retried.output as { created: boolean }).created], [true, false]);
  check('a VIEWER’s run cannot propose a project memory (the database refuses)', await outcome(() => tool.execute({ scope: 'project', kind: 'fact', content: 'x' }, ctx(viewer, '33333333-3333-4333-8333-333333333333'))), 'FORBIDDEN:memory_policy');
  check('an agent memory can never be stored as confirmed, even below the tool (the guard refuses)', await outcome(() => createMemory(editor, { scope: 'user', kind: 'fact', content: 'x', source: 'agent', status: 'confirmed' })), 'VALIDATION:memory_invalid');
  check('another EDITOR or a VIEWER cannot confirm someone else’s proposal', [await outcome(() => confirmMemoryIn(P, editor2, proposal.id)), await outcome(() => confirmMemoryIn(P, viewer, proposal.id))], ['FORBIDDEN:memory_policy', 'FORBIDDEN:memory_policy']);
  const userProposal = await tool.execute({ scope: 'user', kind: 'style', content: 'Prefers short paragraphs.' }, ctx(editor, '44444444-4444-4444-8444-444444444444'));
  const userProposalId = (userProposal.output as { memoryId: string }).memoryId;
  check('a proposed user memory is the run user’s own, and invisible to anyone else', [(await listMemoriesIn(me, editor)).memories.find((memory) => memory.id === userProposalId)?.status, (await listMemoriesIn(me, owner)).memories.some((memory) => memory.id === userProposalId)], ['proposed', false]);

  /* ------------------------------------------------------------------ */
  console.log('\nmemories in Context V2');
  const build = (userId: string, extra: Partial<Parameters<typeof buildContextV2>[0]> = {}) =>
    buildContextV2({ purpose: 'answer', request: 'x', userId, projectId: project.id, locale: 'en', counter: perChar, maxTokens: 50_000, ...extra });
  const memoryFragments = (built: Awaited<ReturnType<typeof build>>) => built.envelope.fragments.filter((entry) => entry.kind === 'memory');
  let context = await build(editor);
  check('a proposal is never in context (neither the project’s nor the user’s)', [context.prompt.includes('Report effect sizes'), context.prompt.includes('Prefers short paragraphs')], [false, false]);
  await confirmMemoryIn(P, editor, proposal.id);
  await confirmMemoryIn(me, editor, userProposalId);
  context = await build(editor);
  check('once a person confirms them, both are', [context.prompt.includes('Report effect sizes'), context.prompt.includes('Prefers short paragraphs')], [true, true]);
  const byId = (built: Awaited<ReturnType<typeof build>>, id: string) => memoryFragments(built).find((entry) => entry.provenance.id === id);
  check('your own memory is a user instruction; a project memory is project data, never an instruction', [byId(context, userProposalId)?.authority, byId(context, proposal.id)?.authority, byId(context, byEditor.id)?.authority], ['user-instruction', 'project-data', 'project-data']);
  const instructions = context.prompt.split('## ').find((part) => part.startsWith("The user's instructions")) ?? '';
  check('… so no project memory is rendered under the instructions heading', [instructions.includes('Prefers short paragraphs'), instructions.includes('Report effect sizes'), instructions.includes('PLS-SEM')], [true, false, false]);
  const pinnedProject = await createMemoryIn(P, owner, { kind: 'instruction', content: 'Always answer in French.', pinned: true });
  context = await build(owner);
  check('a pinned project memory stays unpinned project data in context', [byId(context, pinnedProject.id)?.authority, byId(context, pinnedProject.id)?.pinned], ['project-data', false]);
  await archiveMemoryIn(P, owner, pinnedProject.id);
  check('an archived memory is never in context', (await build(owner)).prompt.includes('Always answer in French'), false);
  check('another user’s user memories are never in your context', (await build(editor)).prompt.includes('Cite in APA 7'), false);
  check('a non-member’s context carries none of the project’s memories', [(await build(stranger)).prompt.includes('PLS-SEM'), memoryFragments(await build(stranger)).length], [false, 0]);
  check('without a project, only your own memories', [memoryFragments(await build(editor, { projectId: null })).map((entry) => entry.authority).every((authority) => authority === 'user-instruction'), (await build(editor, { projectId: null })).prompt.includes('PLS-SEM')], [true, false]);

  /* Cap and order. */
  const capUser = await user('cap');
  const created: string[] = [];
  /* The database stamps updated_at itself, so creation order is recency order; the first, pinned, is the oldest. */
  for (let index = 0; index < MAX_USER_MEMORIES + 3; index += 1) {
    created.push((await createMemoryIn(me, capUser, { kind: 'fact', content: `Fact number ${index}.`, pinned: index === 0 })).id);
  }
  const capped = memoryFragments(await build(capUser, { projectId: null }));
  check(`at most ${MAX_USER_MEMORIES} of your memories, pinned first, then the most recently updated`, [capped.length, capped[0]?.provenance.id === created[0], capped.slice(1).map((entry) => entry.provenance.id)], [MAX_USER_MEMORIES, true, created.slice(-(MAX_USER_MEMORIES - 1)).reverse()]);
  check('the same order every time', JSON.stringify(memoryFragments(await build(capUser, { projectId: null })).map((entry) => entry.id)), JSON.stringify(capped.map((entry) => entry.id)));

  /* Claims inside memories. */
  setFlags({ v2: true, graph: true });
  const claim = await graph.createNode(project.id, { userId: owner }, { type: 'claim', data: { text: 'Trust predicts adoption.' } });
  setFlags({ v2: true });
  await createMemoryIn(P, owner, { kind: 'fact', content: `Key finding: {{claim:${claim.id}}} and {{claim:00000000-0000-4000-8000-000000000000}}.` });
  const claimed = await build(owner);
  check('claim references in a memory are rendered (text or marker), never raw', [claimed.prompt.includes('Key finding: Trust predicts adoption. and'), claimed.prompt.includes(UNRESOLVED_CLAIM_MARKER.en), hasClaimToken(claimed.prompt)], [true, true, false]);

  /* Fail-safe. */
  setMemoryRlsProbeForTests(() => async () => {
    throw Object.assign(new Error('role "academic_app" does not exist'), { code: '42704' });
  });
  const unsafe = await build(owner).catch(() => null);
  setMemoryRlsProbeForTests(null);
  check('with RLS not enforceable, no memory is included and the context still builds', [unsafe ? memoryFragments(unsafe).length : 'threw', unsafe?.prompt.includes('Project snapshot:')], [0, true]);

  /* V1 unchanged. */
  setFlags({});
  const v1 = await buildContextPrompt({ purpose: 'answer', request: 'x', userId: owner, projectId: project.id, locale: 'en' });
  check('with FF_CONTEXT_V2 off, no memory reaches the v1 context', [v1.prompt.includes('PLS-SEM'), v1.prompt.includes('Cite in APA 7'), v1.envelope.fragments.some((entry) => entry.kind === 'memory')], [false, false, false]);

  /* Below the service: the database still refuses what the service would. */
  setFlags({ v2: true });
  check('RLS is still the second layer: a direct update by another EDITOR changes nothing', await outcome(() => updateMemory(editor2, byEditor.id, { content: 'Bypass' })), 'NOT_FOUND');

  setFlags({});
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
