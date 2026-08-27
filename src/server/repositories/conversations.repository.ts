import { and, asc, desc, eq } from 'drizzle-orm';

import type { SectionKey, ToolKey } from '@/config/research';
import { db } from '@/server/db';
import {
  aiConversations,
  aiMessages,
  type AIConversation,
  type AIMessageRow,
} from '@/server/db/schema';

export async function listForProject(projectId: string): Promise<AIConversation[]> {
  return db
    .select()
    .from(aiConversations)
    .where(eq(aiConversations.projectId, projectId))
    .orderBy(desc(aiConversations.updatedAt));
}

export async function findById(id: string): Promise<AIConversation | undefined> {
  const [row] = await db.select().from(aiConversations).where(eq(aiConversations.id, id)).limit(1);
  return row;
}

export async function findOwned(
  id: string,
  userId: string,
): Promise<AIConversation | undefined> {
  const [row] = await db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, userId)))
    .limit(1);
  return row;
}

/** One conversation per (project, scope, key) so the user always returns to the same thread. */
export async function findOrCreate(input: {
  userId: string;
  projectId: string | null;
  scope: 'PROJECT' | 'SECTION' | 'TOOL';
  sectionKey?: SectionKey | null;
  toolKey?: ToolKey | null;
  title?: string;
}): Promise<AIConversation> {
  const conditions = [
    eq(aiConversations.userId, input.userId),
    eq(aiConversations.scope, input.scope),
  ];
  if (input.projectId) conditions.push(eq(aiConversations.projectId, input.projectId));
  if (input.sectionKey) conditions.push(eq(aiConversations.sectionKey, input.sectionKey));
  if (input.toolKey) conditions.push(eq(aiConversations.toolKey, input.toolKey));

  const [existing] = await db
    .select()
    .from(aiConversations)
    .where(and(...conditions))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(aiConversations)
    .values({
      userId: input.userId,
      projectId: input.projectId,
      scope: input.scope,
      sectionKey: input.sectionKey ?? null,
      toolKey: input.toolKey ?? null,
      title: input.title ?? null,
    })
    .returning();

  if (!created) throw new Error('Failed to create conversation');
  return created;
}

export async function listMessages(conversationId: string, limit = 40): Promise<AIMessageRow[]> {
  const rows = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(desc(aiMessages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function listMessagesAsc(conversationId: string): Promise<AIMessageRow[]> {
  return db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(asc(aiMessages.createdAt));
}

export async function addMessage(values: typeof aiMessages.$inferInsert): Promise<AIMessageRow> {
  const [row] = await db.insert(aiMessages).values(values).returning();
  if (!row) throw new Error('Failed to store message');
  await db
    .update(aiConversations)
    .set({ updatedAt: new Date() })
    .where(eq(aiConversations.id, values.conversationId));
  return row;
}
