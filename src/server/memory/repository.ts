/**
 * Memories and thread summaries (P1-E, PR #1): the storage layer only.
 *
 * Every statement runs inside `withMemoryScope`, so the database decides who
 * may read or change what (migration 0018); nothing here re-implements those
 * rules. What the database refuses is mapped to the application's errors:
 * a policy refusal is FORBIDDEN, a row the user cannot see is NOT_FOUND, a
 * constraint or guard is VALIDATION. No API, UI or model call lives here.
 */

import { and, asc, desc, eq, max, sql, type SQL } from 'drizzle-orm';

import { memories, threadSummaries, type Memory, type ThreadSummary } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';

import { withMemoryScope } from './db-scope';

export type MemoryScope = 'user' | 'project';
export type MemoryKind = 'preference' | 'fact' | 'instruction' | 'style' | 'decision';
export type MemoryStatus = 'proposed' | 'confirmed' | 'archived';

/** The SQLSTATE of a database error (drizzle wraps the driver's as `cause`). */
function sqlState(error: unknown): string | null {
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** What the database refused, as an application error; anything else is rethrown. */
function refused(error: unknown): never {
  const code = sqlState(error);
  if (code === '42501') {
    throw new AppError('FORBIDDEN', 'You cannot do that with this memory.', 'لا يمكنك تنفيذ ذلك على هذه الذاكرة.', { reason: 'memory_policy' });
  }
  if (code === '23514' || code === 'P0001' || code === '23502') {
    throw new AppError('VALIDATION', 'The memory is not valid.', 'الذاكرة غير صالحة.', { reason: 'memory_invalid' });
  }
  if (code === '23503') {
    throw new AppError('NOT_FOUND', 'The project or conversation was not found.', 'لم يُعثر على المشروع أو المحادثة.');
  }
  if (code === '23505') {
    throw new AppError('CONFLICT', 'A summary of this version already exists.', 'يوجد ملخّص بهذا الإصدار مسبقًا.', { reason: 'summary_version_taken' });
  }
  throw error;
}

const notFound = () => new AppError('NOT_FOUND', 'That memory was not found.', 'لم يُعثر على هذه الذاكرة.');

export interface NewMemory {
  scope: MemoryScope;
  /** Required for a project memory; absent for a user memory. */
  projectId?: string | null;
  kind: MemoryKind;
  content: string;
  source?: 'user' | 'agent';
  status?: MemoryStatus;
  pinned?: boolean;
  origin?: Record<string, unknown>;
}

/** Stores a memory as `userId` (its subject, or its author for a project memory). */
export async function createMemory(userId: string, input: NewMemory): Promise<Memory> {
  try {
    return await withMemoryScope(userId, async (tx) => {
      const [row] = await tx
        .insert(memories)
        .values({
          scope: input.scope,
          userId,
          projectId: input.projectId ?? null,
          kind: input.kind,
          content: input.content,
          source: input.source ?? 'user',
          status: input.status ?? (input.source === 'agent' ? 'proposed' : 'confirmed'),
          pinned: input.pinned ?? false,
          origin: input.origin ?? {},
        })
        .returning();
      return row!;
    });
  } catch (error) {
    return refused(error);
  }
}

/** The memories `userId` may see: their own, and their projects' (optionally narrowed). */
export async function listMemories(
  userId: string,
  filter: { scope?: MemoryScope; projectId?: string; status?: MemoryStatus } = {},
): Promise<Memory[]> {
  return withMemoryScope(userId, async (tx) => {
    const conditions: SQL[] = [];
    if (filter.scope) conditions.push(eq(memories.scope, filter.scope));
    if (filter.projectId) conditions.push(eq(memories.projectId, filter.projectId));
    if (filter.status) conditions.push(eq(memories.status, filter.status));
    return tx
      .select()
      .from(memories)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(memories.pinned), desc(memories.updatedAt), asc(memories.id));
  });
}

/** One memory `userId` can see (the read policy decides), or null. */
export async function getMemory(userId: string, id: string): Promise<Memory | null> {
  return withMemoryScope(userId, async (tx) => {
    const [row] = await tx.select().from(memories).where(eq(memories.id, id)).limit(1);
    return row ?? null;
  });
}

/** The memory a run step already proposed, if a previous attempt of the step got that far (P1-E, PR #5). */
export async function findByStep(userId: string, stepId: string): Promise<Memory | null> {
  return withMemoryScope(userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(memories)
      .where(and(eq(memories.userId, userId), sql`${memories.origin} ->> 'stepId' = ${stepId}`))
      .limit(1);
    return row ?? null;
  });
}

/** Edits a memory `userId` may edit; NOT_FOUND when they cannot see it or may not change it. */
export async function updateMemory(
  userId: string,
  id: string,
  patch: { content?: string; kind?: MemoryKind; status?: MemoryStatus; pinned?: boolean },
): Promise<Memory> {
  try {
    return await withMemoryScope(userId, async (tx) => {
      const [row] = await tx.update(memories).set(patch).where(eq(memories.id, id)).returning();
      if (!row) throw notFound();
      return row;
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    return refused(error);
  }
}

/** Deletes a memory `userId` may delete; NOT_FOUND otherwise. */
export async function deleteMemory(userId: string, id: string): Promise<void> {
  const deleted = await withMemoryScope(userId, (tx) => tx.delete(memories).where(eq(memories.id, id)).returning({ id: memories.id }));
  if (deleted.length === 0) throw notFound();
}

export interface NewThreadSummary {
  conversationId: string;
  /**
   * The version this summary must be (P1-E PR #4: the one its idempotency key
   * names). A summary already at that version is refused as CONFLICT by the
   * unique index, never written twice. Absent: the next version.
   */
  version?: number;
  summary: string;
  throughMessageId?: string | null;
  messageCount?: number;
  model?: Record<string, unknown> | null;
}

/** Appends the next version of a conversation's summary, as its owner. */
export async function appendThreadSummary(userId: string, input: NewThreadSummary): Promise<ThreadSummary> {
  try {
    return await withMemoryScope(userId, async (tx) => {
      const [current] = await tx
        .select({ version: max(threadSummaries.version) })
        .from(threadSummaries)
        .where(eq(threadSummaries.conversationId, input.conversationId));
      const [row] = await tx
        .insert(threadSummaries)
        .values({
          conversationId: input.conversationId,
          userId,
          version: input.version ?? (current?.version ?? 0) + 1,
          summary: input.summary,
          throughMessageId: input.throughMessageId ?? null,
          messageCount: input.messageCount ?? 0,
          model: input.model ?? null,
        })
        .returning();
      return row!;
    });
  } catch (error) {
    return refused(error);
  }
}

/** The current summary of a conversation `userId` owns, or null. */
export async function latestThreadSummary(userId: string, conversationId: string): Promise<ThreadSummary | null> {
  return withMemoryScope(userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(threadSummaries)
      .where(eq(threadSummaries.conversationId, conversationId))
      .orderBy(desc(threadSummaries.version))
      .limit(1);
    return row ?? null;
  });
}
