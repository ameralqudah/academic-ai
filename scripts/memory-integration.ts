/**
 * Memories and thread summaries against PostgreSQL (P1-E, PR #1).
 *
 *   DATABASE_URL=…/academic_ai_test npm run db:migrate && npm run db:seed
 *   DATABASE_URL=…/academic_ai_test npm run test:memory:db
 *
 * Row-level security on `memories` and `thread_summaries` (migration 0018),
 * proven through the application's own scope (`withMemoryScope`, the
 * restricted role `academic_app`) and probed directly; the fail-closed start;
 * the guards; the cascades; and the Context V2 switches and token-counter
 * interface. No model, no network.
 */

import 'dotenv/config';

import { eq, sql } from 'drizzle-orm';

import { estimateTokens } from '@/ai/provider';
import { resetEnvCache } from '@/config/env';
import { contextV2Enabled, graphContextEnabled } from '@/server/context/flags';
import { estimateCounter, registerTokenCounter, tokenCounterFor } from '@/server/context/token-count';
import { db } from '@/server/db';
import { aiConversations, memories, projectMembers, researchProjects, threadSummaries } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import { assertMemoryRlsEnforced, forgetMemoryRlsCheck, setMemoryRlsProbeForTests, withMemoryScope } from '@/server/memory/db-scope';
import { appendThreadSummary, createMemory, deleteMemory, latestThreadSummary, listMemories, updateMemory } from '@/server/memory/repository';
import * as conversationsRepo from '@/server/repositories/conversations.repository';
import * as projectsRepo from '@/server/repositories/projects.repository';
import { register } from '@/server/services/account.service';

const RUN = `mem-${Date.now()}`;
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
    return 'db-refused';
  }
}

/** Whether PostgreSQL itself refuses a statement run inside the scope. */
async function refusedInScope(userId: string, work: Parameters<typeof withMemoryScope>[1]): Promise<boolean> {
  try {
    await withMemoryScope(userId, work);
    return false;
  } catch {
    return true;
  }
}

async function main() {
  resetEnvCache();
  const user = async (name: string) =>
    (await register({ name, email: `${RUN}-${name}@example.test`, password: 'Passw0rd123', confirmPassword: 'Passw0rd123', locale: 'en' })).id;
  const owner = await user('owner');
  const editor = await user('editor');
  const editor2 = await user('editor2');
  const viewer = await user('viewer');
  const stranger = await user('stranger');
  const project = await projectsRepo.create({ userId: owner, title: 'P1-E', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  const other = await projectsRepo.create({ userId: editor, title: 'Elsewhere', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  await db.insert(projectMembers).values([
    { projectId: project.id, userId: editor, role: 'EDITOR' },
    { projectId: project.id, userId: editor2, role: 'EDITOR' },
    { projectId: project.id, userId: viewer, role: 'VIEWER' },
  ]);

  /* ------------------------------------------------------------------ */
  console.log('\nRLS is enforced, and memory fails closed without it');
  await assertMemoryRlsEnforced();
  check('the memory scope is the restricted role, not the owner connection', await withMemoryScope(owner, async (tx) => ((await tx.execute(sql`select current_user as u`)) as unknown as { u: string }[])[0]?.u), 'academic_app');
  const rls = (await db.execute(sql`select relname, relrowsecurity from pg_class where relname in ('memories', 'thread_summaries') order by relname`)) as unknown as { relname: string; relrowsecurity: boolean }[];
  check('RLS is on for both tables', rls.map((r) => [r.relname, r.relrowsecurity]), [['memories', true], ['thread_summaries', true]]);
  const policies = (await db.execute(sql`select tablename, policyname, cmd from pg_policies where tablename in ('memories', 'thread_summaries') order by tablename, policyname`)) as unknown as { tablename: string; policyname: string; cmd: string }[];
  check('the policies are the approved seven', policies.map((p) => `${p.tablename}.${p.policyname}:${p.cmd}`), [
    'memories.memories_create:INSERT', 'memories.memories_delete:DELETE', 'memories.memories_read:SELECT', 'memories.memories_update:UPDATE',
    'thread_summaries.thread_summaries_create:INSERT', 'thread_summaries.thread_summaries_delete:DELETE', 'thread_summaries.thread_summaries_read:SELECT',
  ]);
  const grants = (await db.execute(sql`select table_name, string_agg(privilege_type, ',' order by privilege_type) as p from information_schema.role_table_grants where grantee = 'academic_app' and table_name in ('memories', 'thread_summaries') group by table_name order by table_name`)) as unknown as { table_name: string; p: string }[];
  check('the restricted role may not edit a summary (no UPDATE grant)', grants.map((g) => [g.table_name, g.p]), [['memories', 'DELETE,INSERT,SELECT,UPDATE'], ['thread_summaries', 'DELETE,INSERT,SELECT']]);

  await db.execute(sql`alter role academic_app bypassrls`);
  forgetMemoryRlsCheck();
  check('if the role could bypass RLS, memory refuses to start (no application-only fallback)', await outcome(() => assertMemoryRlsEnforced()), 'UNAVAILABLE:rls_unavailable');
  check('… and so does every scoped read', await outcome(() => listMemories(owner)), 'UNAVAILABLE:rls_unavailable');
  await db.execute(sql`alter role academic_app nobypassrls`);
  forgetMemoryRlsCheck();
  await db.execute(sql`alter table memories disable row level security`);
  check('if RLS is off on a memory table, memory refuses to start', await outcome(() => assertMemoryRlsEnforced()), 'UNAVAILABLE:rls_unavailable');
  await db.execute(sql`alter table memories enable row level security`);
  forgetMemoryRlsCheck();
  await db.execute(sql`alter role academic_app rename to academic_app_p1e_gone`);
  let probes = 0;
  setMemoryRlsProbeForTests((real) => async () => {
    probes += 1;
    return real();
  });
  const gone = await outcome(() => assertMemoryRlsEnforced());
  await db.execute(sql`alter role academic_app_p1e_gone rename to academic_app`);
  check('a missing role is definitive: rls_unavailable after one probe', [gone, probes], ['UNAVAILABLE:rls_unavailable', 1]);
  probes = 0;
  setMemoryRlsProbeForTests(() => async () => {
    probes += 1;
    throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  });
  check('a database it cannot reach is refused as infra_unavailable after bounded retries, claiming nothing about RLS', [await outcome(() => assertMemoryRlsEnforced()), probes], ['UNAVAILABLE:infra_unavailable', 3]);
  setMemoryRlsProbeForTests(null);
  check('with the database back, RLS is proven again', await outcome(() => assertMemoryRlsEnforced()), 'ok');
  check('no scope without a user', await outcome(() => withMemoryScope('', async () => undefined)), 'UNAUTHORIZED');

  /* ------------------------------------------------------------------ */
  console.log('\nuser memories belong to their user alone');
  const mine = await createMemory(owner, { scope: 'user', kind: 'preference', content: 'Prefers APA 7.' });
  check('a user stores a memory of their own, confirmed and stamped', [mine.scope, mine.userId === owner, mine.projectId, mine.status, Boolean(mine.confirmedAt)], ['user', true, null, 'confirmed', true]);
  check('… and sees it', (await listMemories(owner, { scope: 'user' })).some((m) => m.id === mine.id), true);
  check('another user sees none of it — not even through a project they share', [(await listMemories(editor)).some((m) => m.id === mine.id), (await listMemories(stranger)).length], [false, 0]);
  check('… cannot edit it, nor delete it', [await outcome(() => updateMemory(editor, mine.id, { content: 'Hijacked.' })), await outcome(() => deleteMemory(editor, mine.id))], ['NOT_FOUND', 'NOT_FOUND']);
  check('… cannot write a memory in its name (the database refuses)', await refusedInScope(stranger, (tx) => tx.insert(memories).values({ scope: 'user', userId: owner, kind: 'fact', content: 'Planted.' })), true);
  check('… and a raw read under their scope returns nothing', (await withMemoryScope(stranger, (tx) => tx.select().from(memories).where(eq(memories.id, mine.id)))).length, 0);
  check('a user memory cannot name a project', await outcome(() => createMemory(owner, { scope: 'user', projectId: project.id, kind: 'fact', content: 'Mixed.' })) !== 'ok', true);
  const edited = await updateMemory(owner, mine.id, { content: 'Prefers APA 7th edition.', pinned: true });
  check('its user edits and pins it', [edited.content, edited.pinned], ['Prefers APA 7th edition.', true]);
  const archived = await updateMemory(owner, mine.id, { status: 'archived' });
  const restored = await updateMemory(owner, mine.id, { status: 'confirmed' });
  check('… archives and restores it (confirming stamps it again)', [archived.status, restored.status, restored.confirmedAt!.getTime() >= archived.confirmedAt!.getTime()], ['archived', 'confirmed', true]);
  check('… but a memory never goes back to proposed', await outcome(() => updateMemory(owner, mine.id, { status: 'proposed' })), 'VALIDATION:memory_invalid');
  check('content must be 1–2000 characters', [await outcome(() => createMemory(owner, { scope: 'user', kind: 'fact', content: '   ' })), await outcome(() => createMemory(owner, { scope: 'user', kind: 'fact', content: 'x'.repeat(2001) }))], ['VALIDATION:memory_invalid', 'VALIDATION:memory_invalid']);
  await deleteMemory(owner, mine.id);
  check('its user deletes it', (await listMemories(owner, { scope: 'user' })).some((m) => m.id === mine.id), false);

  /* ------------------------------------------------------------------ */
  console.log('\nproject memories are member-scoped (WS4 A2), written by editors');
  const shared = await createMemory(editor, { scope: 'project', projectId: project.id, kind: 'instruction', content: 'The supervisor requires Harvard style.' });
  const readers = await Promise.all([owner, editor, editor2, viewer, stranger].map(async (u) => (await listMemories(u, { projectId: project.id })).some((m) => m.id === shared.id)));
  check('an EDITOR stores one; every member reads it (owner, editors, viewer), a non-member does not', readers, [true, true, true, true, false]);
  check('a VIEWER cannot store one; nor can a non-member', [await outcome(() => createMemory(viewer, { scope: 'project', projectId: project.id, kind: 'fact', content: 'x' })), await outcome(() => createMemory(stranger, { scope: 'project', projectId: project.id, kind: 'fact', content: 'x' }))], ['FORBIDDEN:memory_policy', 'FORBIDDEN:memory_policy']);
  check('… nor can an editor store one in someone else’s name', await refusedInScope(editor, (tx) => tx.insert(memories).values({ scope: 'project', projectId: project.id, userId: editor2, kind: 'fact', content: 'Planted.' })), true);
  check('its author edits it', (await updateMemory(editor, shared.id, { content: 'The supervisor requires Harvard style, 2nd edition.' })).content, 'The supervisor requires Harvard style, 2nd edition.');
  check('another EDITOR may not edit it, nor delete it; a VIEWER neither', [await outcome(() => updateMemory(editor2, shared.id, { pinned: true })), await outcome(() => deleteMemory(editor2, shared.id)), await outcome(() => updateMemory(viewer, shared.id, { pinned: true }))], ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
  check('the project OWNER may edit it', (await updateMemory(owner, shared.id, { pinned: true })).pinned, true);
  await db.update(projectMembers).set({ role: 'VIEWER' }).where(eq(projectMembers.userId, editor));
  check('an author demoted to VIEWER can no longer edit or delete it, but still reads it', [await outcome(() => updateMemory(editor, shared.id, { pinned: false })), await outcome(() => deleteMemory(editor, shared.id)), (await listMemories(editor, { projectId: project.id })).length], ['NOT_FOUND', 'NOT_FOUND', 1]);
  await db.update(projectMembers).set({ role: 'EDITOR' }).where(eq(projectMembers.userId, editor));
  check('a memory cannot be moved to another project, even one its author edits', await refusedInScope(editor, (tx) => tx.update(memories).set({ projectId: other.id }).where(eq(memories.id, shared.id))), true);
  check('… nor turned into a user memory, nor given to another user (also refused on the owner connection)', [
    await outcome(() => db.update(memories).set({ scope: 'user', projectId: null }).where(eq(memories.id, shared.id))),
    await outcome(() => db.update(memories).set({ userId: stranger }).where(eq(memories.id, shared.id))),
  ], ['db-refused', 'db-refused']);
  const proposal = await createMemory(editor, { scope: 'project', projectId: project.id, kind: 'decision', content: 'Use PLS-SEM for H1–H3.', source: 'agent' });
  check('an agent only proposes: stored as proposed, unconfirmed', [proposal.source, proposal.status, proposal.confirmedAt], ['agent', 'proposed', null]);
  check('… an agent memory cannot be stored as confirmed', await outcome(() => createMemory(editor, { scope: 'project', projectId: project.id, kind: 'fact', content: 'x', source: 'agent', status: 'confirmed' })), 'VALIDATION:memory_invalid');
  const confirmed = await updateMemory(editor, proposal.id, { status: 'confirmed' });
  check('… and its author confirms it, stamped', [confirmed.status, Boolean(confirmed.confirmedAt)], ['confirmed', true]);
  check('the project OWNER deletes a member’s memory', [await outcome(() => deleteMemory(owner, shared.id)), (await listMemories(viewer, { projectId: project.id })).some((m) => m.id === shared.id)], ['ok', false]);
  const doomed = await projectsRepo.create({ userId: owner, title: 'Doomed', academicField: 'x', degree: 'MASTER', researchType: 'QUANTITATIVE' });
  const doomedMemory = await createMemory(owner, { scope: 'project', projectId: doomed.id, kind: 'fact', content: 'Goes with the project.' });
  await db.delete(researchProjects).where(eq(researchProjects.id, doomed.id));
  check('deleting a project deletes its memories', (await db.select().from(memories).where(eq(memories.id, doomedMemory.id))).length, 0);

  /* ------------------------------------------------------------------ */
  console.log('\nthread summaries are private to the conversation’s owner, and never edited');
  const thread = await conversationsRepo.findOrCreate({ userId: owner, projectId: project.id, scope: 'TOOL', toolKey: 'rewriter' as never });
  const v1 = await appendThreadSummary(owner, { conversationId: thread.id, summary: 'Agreed the topic.', messageCount: 10 });
  const v2 = await appendThreadSummary(owner, { conversationId: thread.id, summary: 'Agreed the topic and the method.', messageCount: 20 });
  check('the owner appends versions 1, 2 and reads the latest', [v1.version, v2.version, (await latestThreadSummary(owner, thread.id))?.id === v2.id], [1, 2, true]);
  check('another member of its project reads none of it', [await latestThreadSummary(editor, thread.id), (await withMemoryScope(editor, (tx) => tx.select().from(threadSummaries).where(eq(threadSummaries.conversationId, thread.id)))).length], [null, 0]);
  check('… and cannot append to it, under their own name or the owner’s', [(await outcome(() => appendThreadSummary(editor, { conversationId: thread.id, summary: 'Planted.' }))) !== 'ok', await refusedInScope(editor, (tx) => tx.insert(threadSummaries).values({ conversationId: thread.id, userId: owner, version: 9, summary: 'Planted.' }))], [true, true]);
  check('… (the refusal is a policy or guard refusal, never a write)', [(await db.select().from(threadSummaries).where(eq(threadSummaries.conversationId, thread.id))).length, ['FORBIDDEN:memory_policy', 'VALIDATION:memory_invalid'].includes(await outcome(() => appendThreadSummary(stranger, { conversationId: thread.id, summary: 'x' })))], [2, true]);
  check('a summary is never edited: the restricted role has no UPDATE, and the owner connection is refused by the guard', [await refusedInScope(owner, (tx) => tx.update(threadSummaries).set({ summary: 'Rewritten.' }).where(eq(threadSummaries.id, v1.id))), await outcome(() => db.update(threadSummaries).set({ summary: 'Rewritten.' }).where(eq(threadSummaries.id, v1.id)))], [true, 'db-refused']);
  check('… nor written for a user who does not own the conversation, even on the owner connection', await outcome(() => db.insert(threadSummaries).values({ conversationId: thread.id, userId: editor, version: 3, summary: 'x' })), 'db-refused');
  check('a version is taken once', await outcome(() => db.insert(threadSummaries).values({ conversationId: thread.id, userId: owner, version: 2, summary: 'Again.' })), 'db-refused');
  check('another user cannot delete it; its owner can', [
    (await withMemoryScope(stranger, (tx) => tx.delete(threadSummaries).where(eq(threadSummaries.id, v1.id)).returning({ id: threadSummaries.id }))).length,
    (await withMemoryScope(owner, (tx) => tx.delete(threadSummaries).where(eq(threadSummaries.id, v1.id)).returning({ id: threadSummaries.id }))).length,
  ], [0, 1]);
  await db.delete(aiConversations).where(eq(aiConversations.id, thread.id));
  check('deleting a conversation deletes its summaries', (await db.select().from(threadSummaries).where(eq(threadSummaries.conversationId, thread.id))).length, 0);

  /* ------------------------------------------------------------------ */
  console.log('\nContext V2 switches (off by default) and the token-counter interface');
  const saved = { v2: process.env.FF_CONTEXT_V2, graph: process.env.FF_GRAPH };
  const flags = (v2: string | undefined, graph: string | undefined) => {
    if (v2 === undefined) delete process.env.FF_CONTEXT_V2;
    else process.env.FF_CONTEXT_V2 = v2;
    if (graph === undefined) delete process.env.FF_GRAPH;
    else process.env.FF_GRAPH = graph;
    resetEnvCache();
    return [contextV2Enabled(), graphContextEnabled()];
  };
  check('unset: Context V2 off, and no graph context', flags(undefined, undefined), [false, false]);
  check('Context V2 on, graph off: no graph context', flags('true', 'false'), [true, false]);
  check('graph on, Context V2 off: no graph context either', flags('false', 'true'), [false, false]);
  check('graph context needs both', flags('true', 'true'), [true, true]);
  flags(saved.v2, saved.graph);
  const text = 'Prefers APA 7. يفضّل أسلوب APA.';
  check('every provider counts offline with the conservative estimate until an exact counter is chosen', (['anthropic', 'openai', 'google'] as const).map((p) => [tokenCounterFor(p).provider, tokenCounterFor(p).exact, tokenCounterFor(p).count(text) === estimateTokens(text)]), [['estimate', false, true], ['estimate', false, true], ['estimate', false, true]]);
  registerTokenCounter('anthropic', { provider: 'anthropic', exact: true, count: (t) => t.length });
  check('an exact offline counter, once registered, is used for its provider only', [tokenCounterFor('anthropic').count('abcd'), tokenCounterFor('openai') === estimateCounter], [4, true]);
  registerTokenCounter('anthropic', null);
  check('… and clearing it restores the estimate', tokenCounterFor('anthropic') === estimateCounter, true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
