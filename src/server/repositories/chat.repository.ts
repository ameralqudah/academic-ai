/**
 * Conversations as trees.
 *
 * The shape here is the one decision in this file that matters, and it is worth
 * setting out before the queries.
 *
 * A chat looks like a list. It is not one, as soon as a user can edit a message
 * or regenerate a reply. Editing the third message of a ten-message thread does
 * not change that message — it starts a different conversation from that point,
 * and the original still exists. A flat list can only model that by deleting
 * what came after, which throws away work the user may want back.
 *
 * So every message records its parent, and a conversation is a tree. The thread
 * on screen is the *active path*: start at the root, and at each step follow
 * whichever child is marked active. Editing a message adds a sibling and moves
 * the active flag; nothing is destroyed. Switching branches is an update to a
 * boolean.
 *
 * With no branches this is exactly a linked list and costs nothing. That is why
 * it was built now rather than retrofitted: the same structure that supports a
 * simple chat today supports editing, regeneration and branch switching later,
 * and adding it afterwards would mean backfilling every message and rewriting
 * every read.
 */

import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '@/server/db';
import {
  aiConversations,
  aiMessages,
  type AIConversation,
  type AIMessageRow,
  type NewAIConversation,
  type NewAIMessage,
} from '@/server/db/schema';

/** Conversations that have not been deleted. */
const live = () => isNull(aiConversations.archivedAt);

/* -------------------------------------------------------------------------- */
/*                               Conversations                                */
/* -------------------------------------------------------------------------- */

export async function create(values: NewAIConversation): Promise<AIConversation> {
  const [row] = await db.insert(aiConversations).values(values).returning();
  if (!row) throw new Error('Failed to create conversation');
  return row;
}

/**
 * The only way a request reaches a conversation.
 *
 * Ownership is part of the query rather than a check that follows it, for the
 * same reason it is on datasets: a two-step check is a race, and it is the kind
 * of thing a call site forgets.
 */
export async function findOwned(id: string, userId: string): Promise<AIConversation | undefined> {
  const [row] = await db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, userId), live()))
    .limit(1);
  return row;
}

/**
 * The sidebar list: this user's recent conversations, newest first.
 *
 * Ordered by `lastMessageAt` with `updatedAt` as the fallback, because a
 * conversation created but never used has no last message and should still
 * appear rather than sorting to the bottom as null.
 */
export async function listRecent(
  userId: string,
  options: { limit?: number; mode?: 'CHAT' | 'AGENT'; projectId?: string } = {},
): Promise<AIConversation[]> {
  const conditions = [eq(aiConversations.userId, userId), live()];
  if (options.mode) conditions.push(eq(aiConversations.mode, options.mode));
  if (options.projectId) conditions.push(eq(aiConversations.projectId, options.projectId));

  return db
    .select()
    .from(aiConversations)
    .where(and(...conditions))
    .orderBy(desc(sql`coalesce(${aiConversations.lastMessageAt}, ${aiConversations.updatedAt})`))
    .limit(options.limit ?? 30);
}

export async function rename(
  id: string,
  userId: string,
  title: string,
): Promise<AIConversation | undefined> {
  const [row] = await db
    .update(aiConversations)
    .set({ title: title.trim().slice(0, 200), updatedAt: new Date() })
    .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, userId)))
    .returning();
  return row;
}

/**
 * Hides a conversation without destroying it.
 *
 * The same reasoning as deleting a dataset: an accidental click should not be
 * irreversible, and a researcher who deletes a thread and then realises the
 * answer mattered should be able to get it back. A permanent purge is a
 * separate, deliberate call.
 */
export async function archive(id: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(aiConversations)
    .set({ archivedAt: new Date() })
    .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, userId)))
    .returning({ id: aiConversations.id });
  return rows.length > 0;
}

export async function unarchive(id: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(aiConversations)
    .set({ archivedAt: null })
    .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, userId)))
    .returning({ id: aiConversations.id });
  return rows.length > 0;
}

/** Irreversible. The foreign key takes the messages with it. */
export async function purge(id: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(aiConversations)
    .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, userId)))
    .returning({ id: aiConversations.id });
  return rows.length > 0;
}

/* -------------------------------------------------------------------------- */
/*                                  Messages                                  */
/* -------------------------------------------------------------------------- */

/**
 * Appends a message and moves the conversation to the top of the sidebar.
 *
 * Both writes happen together because a message that exists while the
 * conversation still claims its last activity was yesterday is a list that
 * lies. Wrapped in a transaction so a failure leaves neither.
 */
export async function addMessage(values: NewAIMessage): Promise<AIMessageRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(aiMessages).values(values).returning();
    if (!row) throw new Error('Failed to add message');

    await tx
      .update(aiConversations)
      .set({ lastMessageAt: row.createdAt, updatedAt: new Date() })
      .where(eq(aiConversations.id, values.conversationId));

    return row;
  });
}

/**
 * The thread as the user sees it: the active path from the root.
 *
 * Every message on an unbranched conversation is active, so this returns the
 * whole thing in creation order — which is what it should do. Once branches
 * exist, the inactive ones are excluded here and nowhere else, so no caller has
 * to know the tree exists.
 */
export async function activeThread(conversationId: string): Promise<AIMessageRow[]> {
  return db
    .select()
    .from(aiMessages)
    .where(and(eq(aiMessages.conversationId, conversationId), eq(aiMessages.isActive, true)))
    .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id));
}

/** Every message including inactive branches — for export and for debugging. */
export async function allMessages(conversationId: string): Promise<AIMessageRow[]> {
  return db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    /*
     * Id as a tie-break, because the timestamp alone is not one.
     *
     * Two messages written in the same millisecond — an edit made moments after
     * the original, or any two rows inserted in one transaction — come back in
     * whatever order the planner chose. That made "version 1 of 2" point at a
     * different sibling between reads, and stepping forward could land back
     * where it started.
     *
     * The ids are UUIDs and carry no order themselves, but they are stable, and
     * a stable arbitrary order is what sibling navigation needs: the same list
     * every time.
     */
    .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id));
}

export async function findMessage(
  id: string,
  conversationId: string,
): Promise<AIMessageRow | undefined> {
  const [row] = await db
    .select()
    .from(aiMessages)
    .where(and(eq(aiMessages.id, id), eq(aiMessages.conversationId, conversationId)))
    .limit(1);
  return row;
}

/**
 * Rewrites a message by adding a sibling rather than overwriting it.
 *
 * This is the operation the tree exists for. The user edits their third
 * message; the original stays, a new message joins it under the same parent,
 * and the active flag moves to the new one along with everything that follows
 * it on the old path being deactivated.
 *
 * Nothing is deleted. The previous branch is still there and can be returned
 * to, which is the difference between editing a message and losing the
 * conversation that came after it.
 */
export async function branchFrom(input: {
  conversationId: string;
  /** The message being replaced. Its parent becomes the new message's parent. */
  replacingMessageId: string;
  content: string;
  role: NewAIMessage['role'];
}): Promise<AIMessageRow> {
  return db.transaction(async (tx) => {
    const [original] = await tx
      .select()
      .from(aiMessages)
      .where(
        and(
          eq(aiMessages.id, input.replacingMessageId),
          eq(aiMessages.conversationId, input.conversationId),
        ),
      )
      .limit(1);

    if (!original) throw new Error('Message not found');

    /*
     * Everything from the replaced message onward leaves the active path.
     * Identified by creation time rather than by walking the tree: within one
     * conversation, anything created at or after the message being replaced is
     * downstream of it on the current path, and the comparison is one indexed
     * predicate rather than a recursive query.
     */
    await tx
      .update(aiMessages)
      .set({ isActive: false })
      .where(
        and(
          eq(aiMessages.conversationId, input.conversationId),
          eq(aiMessages.isActive, true),
          /*
           * `gte` rather than a raw `sql` fragment.
           *
           * A raw fragment passes the JavaScript `Date` straight to the driver,
           * which cannot serialise it and fails at bind time — the query looks
           * correct and never runs. Drizzle's comparison operators know the
           * column's type and convert the value for it, which is the whole
           * reason to use them over hand-written SQL for anything but a
           * genuinely dynamic expression.
           */
          gte(aiMessages.createdAt, original.createdAt),
        ),
      );

    const [created] = await tx
      .insert(aiMessages)
      .values({
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        parentMessageId: original.parentMessageId,
        isActive: true,
        editedAt: new Date(),
      })
      .returning();

    if (!created) throw new Error('Failed to branch');

    await tx
      .update(aiConversations)
      .set({ lastMessageAt: created.createdAt, updatedAt: new Date() })
      .where(eq(aiConversations.id, input.conversationId));

    return created;
  });
}

/**
 * Switches to a different branch at a fork.
 *
 * Deactivates the currently active path from the fork onward, then activates
 * the chosen message. Its own descendants are reactivated by their creation
 * time, which reconstructs the branch the user had before they moved away.
 */
export async function switchBranch(
  conversationId: string,
  messageId: string,
): Promise<AIMessageRow | undefined> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.conversationId, conversationId));

    const target = rows.find((row) => row.id === messageId);
    if (!target) return undefined;

    /*
     * The active path is recomputed by walking the tree, not by comparing
     * timestamps.
     *
     * Time was the wrong tool and failed in the ordinary case. An edit and the
     * message it replaces are siblings created seconds apart, and
     * "deactivate everything at or after this instant" cannot separate them —
     * so switching left both branches active at once, and the thread showed
     * whichever the ordering happened to return. Navigation appeared to work
     * going back and silently did nothing going forward.
     *
     * Structure answers the question that time cannot: from the root, follow
     * the chosen message where its fork is reached and the earliest child
     * everywhere else. Exactly one child of each parent ends up active, which
     * is the invariant the whole design rests on.
     */
    const childrenOf = new Map<string | null, typeof rows>();
    for (const row of rows) {
      const key = row.parentMessageId;
      const group = childrenOf.get(key);
      if (group) group.push(row);
      else childrenOf.set(key, [row]);
    }

    const byCreation = (list: typeof rows) =>
      [...list].sort((a, b) => {
        const time = a.createdAt.getTime() - b.createdAt.getTime();
        return time !== 0 ? time : a.id.localeCompare(b.id);
      });

    /* Ancestors of the target, so the walk knows where to turn. */
    const byId = new Map(rows.map((row) => [row.id, row]));
    const onTargetPath = new Set<string>([messageId]);
    let ancestor = target.parentMessageId;
    for (let step = 0; step < rows.length && ancestor; step += 1) {
      onTargetPath.add(ancestor);
      ancestor = byId.get(ancestor)?.parentMessageId ?? null;
    }

    const active = new Set<string>();
    let cursor: string | null = null;

    for (let step = 0; step < rows.length; step += 1) {
      const children = childrenOf.get(cursor);
      if (!children || children.length === 0) break;

      /*
       * At the fork containing the target, take the target. Elsewhere take the
       * earliest child, which reproduces the path as it was written.
       */
      const chosen =
        children.find((child) => onTargetPath.has(child.id)) ?? byCreation(children)[0];

      if (!chosen) break;
      active.add(chosen.id);
      cursor = chosen.id;
    }

    const inactive = rows.filter((row) => !active.has(row.id)).map((row) => row.id);

    if (active.size > 0) {
      await tx
        .update(aiMessages)
        .set({ isActive: true })
        .where(inArray(aiMessages.id, [...active]));
    }
    if (inactive.length > 0) {
      await tx.update(aiMessages).set({ isActive: false }).where(inArray(aiMessages.id, inactive));
    }

    return byId.get(messageId);
  });
}

/** Siblings of a message — how the interface knows a fork exists and offers it. */
export async function siblingsOf(
  conversationId: string,
  messageId: string,
): Promise<AIMessageRow[]> {
  const [message] = await db
    .select()
    .from(aiMessages)
    .where(and(eq(aiMessages.id, messageId), eq(aiMessages.conversationId, conversationId)))
    .limit(1);

  if (!message) return [];

  return db
    .select()
    .from(aiMessages)
    .where(
      and(
        eq(aiMessages.conversationId, conversationId),
        message.parentMessageId === null
          ? isNull(aiMessages.parentMessageId)
          : eq(aiMessages.parentMessageId, message.parentMessageId),
      ),
    )
    .orderBy(asc(aiMessages.createdAt));
}

/** The newest message on the active path — the parent for whatever comes next. */
export async function activeLeaf(conversationId: string): Promise<AIMessageRow | undefined> {
  const [row] = await db
    .select()
    .from(aiMessages)
    .where(and(eq(aiMessages.conversationId, conversationId), eq(aiMessages.isActive, true)))
    .orderBy(desc(aiMessages.createdAt))
    .limit(1);
  return row;
}

/** How many live conversations a user has, for plan limits and the sidebar. */
export async function countForUser(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(aiConversations)
    .where(and(eq(aiConversations.userId, userId), live()));
  return row?.value ?? 0;
}
