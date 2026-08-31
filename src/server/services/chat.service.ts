/**
 * Conversations, as the application uses them.
 *
 * The layer between the tree in the database and the thread the interface
 * shows. Its jobs are ownership, titles, and turning "the user edited message
 * three" into the right set of writes.
 *
 * Titles deserve a note because the obvious implementation is wrong. Asking a
 * model to name each conversation costs a call per thread and produces titles
 * that vary between runs; taking the first forty characters of the first
 * message costs nothing and is right almost always, because people open a chat
 * by saying what they want. The cheap version is used, and a rename is one
 * click away for the times it is not.
 */

import { logger } from '@/lib/logger';
import type { AIConversation, AIMessageRow } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as chatRepo from '@/server/repositories/chat.repository';

/** Above this a user is keeping more threads than any sidebar can serve. */
const MAX_CONVERSATIONS = 500;

export interface BranchPoint {
  /** The message currently on the active path. */
  messageId: string;
  /** Its position among its siblings, oldest first. */
  index: number;
  total: number;
  /** Sibling ids in the same order, so the interface can step through them. */
  siblingIds: string[];
}

export interface ThreadView {
  conversation: AIConversation;
  messages: AIMessageRow[];
  /**
   * Where this thread forks, and which version is showing.
   *
   * A list of ids was not enough: the interface has to say "2 of 3" and offer
   * the neighbours, and asking the server about every message to find out would
   * be one request per message. Everything needed is computed in the same pass
   * that already reads the whole conversation.
   *
   * Empty for a thread nobody has edited, which is most of them.
   */
  branchPoints: BranchPoint[];
}

/* -------------------------------------------------------------------------- */
/*                                  Reading                                   */
/* -------------------------------------------------------------------------- */

export async function requireOwned(id: string, userId: string): Promise<AIConversation> {
  const conversation = await chatRepo.findOwned(id, userId);

  if (!conversation) {
    /*
     * The same message whether it does not exist or belongs to someone else.
     * Distinguishing them lets anyone with an id confirm whether it is real.
     */
    throw new AppError('NOT_FOUND', 'That conversation was not found.', 'لم يُعثر على المحادثة.');
  }

  return conversation;
}

export async function getThread(id: string, userId: string): Promise<ThreadView> {
  const conversation = await requireOwned(id, userId);
  const messages = await chatRepo.activeThread(id);

  /*
   * Branch points found from the full message set rather than by querying per
   * message: one read, and the arithmetic is a grouping by parent.
   */
  const all = await chatRepo.allMessages(id);
  const childrenByParent = new Map<string | null, number>();

  for (const message of all) {
    const key = message.parentMessageId;
    childrenByParent.set(key, (childrenByParent.get(key) ?? 0) + 1);
  }

  /*
   * Siblings grouped by parent, in creation order. `null` is a real key here —
   * the first message of a thread has no parent, and editing it forks the
   * conversation at the root like anywhere else.
   */
  const siblingsByParent = new Map<string | null, string[]>();
  for (const message of all) {
    const key = message.parentMessageId;
    const group = siblingsByParent.get(key);
    if (group) group.push(message.id);
    else siblingsByParent.set(key, [message.id]);
  }

  const branchPoints: BranchPoint[] = messages
    .filter((message) => (childrenByParent.get(message.parentMessageId) ?? 0) > 1)
    .map((message) => {
      const siblingIds = siblingsByParent.get(message.parentMessageId) ?? [message.id];
      return {
        messageId: message.id,
        index: siblingIds.indexOf(message.id),
        total: siblingIds.length,
        siblingIds,
      };
    });

  return { conversation, messages, branchPoints };
}

export async function listRecent(
  userId: string,
  options: { limit?: number; mode?: 'CHAT' | 'AGENT'; projectId?: string } = {},
): Promise<AIConversation[]> {
  return chatRepo.listRecent(userId, options);
}

/* -------------------------------------------------------------------------- */
/*                                  Writing                                   */
/* -------------------------------------------------------------------------- */

export async function startConversation(input: {
  userId: string;
  projectId?: string | null;
  firstMessage?: string;
  mode?: 'CHAT' | 'AGENT';
}): Promise<AIConversation> {
  if ((await chatRepo.countForUser(input.userId)) >= MAX_CONVERSATIONS) {
    throw new AppError(
      'VALIDATION',
      `You have reached the maximum of ${MAX_CONVERSATIONS} conversations. Delete some to start a new one.`,
      `وصلت إلى الحد الأقصى وهو ${MAX_CONVERSATIONS} محادثة. احذف بعضها لبدء محادثة جديدة.`,
    );
  }

  return chatRepo.create({
    userId: input.userId,
    projectId: input.projectId ?? null,
    scope: 'PROJECT',
    mode: input.mode ?? 'AGENT',
    title: input.firstMessage ? titleFrom(input.firstMessage) : null,
  });
}

/**
 * Records a turn: what the user said and what came back.
 *
 * Both in one call because a conversation holding a question with no answer, or
 * an answer with no question, is a conversation that renders wrong. The user
 * message is written first so that if the assistant's reply fails, the question
 * is still there to retry from.
 */
export async function recordTurn(input: {
  conversationId: string;
  userId: string;
  userMessage: string;
  assistantMessage?: string;
  payload?: Record<string, unknown> | null;
  provider?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
}): Promise<{ user: AIMessageRow; assistant?: AIMessageRow }> {
  await requireOwned(input.conversationId, input.userId);

  const parent = await chatRepo.activeLeaf(input.conversationId);

  const user = await chatRepo.addMessage({
    conversationId: input.conversationId,
    role: 'USER',
    content: input.userMessage,
    parentMessageId: parent?.id ?? null,
  });

  if (input.assistantMessage === undefined) return { user };

  const assistant = await chatRepo.addMessage({
    conversationId: input.conversationId,
    role: 'ASSISTANT',
    content: input.assistantMessage,
    parentMessageId: user.id,
    payload: input.payload ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    tokensIn: input.tokensIn ?? 0,
    tokensOut: input.tokensOut ?? 0,
  });

  /*
   * A conversation started without a first message — opened from the sidebar
   * before anything was typed — gets its title from the first thing said in it.
   */
  const conversation = await chatRepo.findOwned(input.conversationId, input.userId);
  if (conversation && !conversation.title) {
    await chatRepo.rename(input.conversationId, input.userId, titleFrom(input.userMessage));
  }

  return { user, assistant };
}

/**
 * Rewrites a user message, keeping the original.
 *
 * The edit becomes a sibling of the message it replaces, and everything that
 * followed leaves the active path. The old branch is still there — which is the
 * whole difference between editing a message and losing the conversation that
 * came after it.
 */
export async function editMessage(input: {
  conversationId: string;
  userId: string;
  messageId: string;
  content: string;
}): Promise<AIMessageRow> {
  await requireOwned(input.conversationId, input.userId);

  const original = await chatRepo.findMessage(input.messageId, input.conversationId);
  if (!original) {
    throw new AppError('NOT_FOUND', 'That message was not found.', 'لم يُعثر على الرسالة.');
  }

  /*
   * Only the user's own messages. Rewriting what the assistant said would let a
   * conversation record an answer that was never given — and that record is
   * what a results chapter or a citation might later be built from.
   */
  if (original.role !== 'USER') {
    throw new AppError(
      'VALIDATION',
      'Only your own messages can be edited. Use regenerate for a different answer.',
      'يمكن تعديل رسائلك أنت فقط. استخدم إعادة التوليد للحصول على إجابة أخرى.',
    );
  }

  logger.info('chat.messageEdited', { conversationId: input.conversationId });

  return chatRepo.branchFrom({
    conversationId: input.conversationId,
    replacingMessageId: input.messageId,
    content: input.content,
    role: 'USER',
  });
}

/**
 * Prepares a regeneration: the assistant's reply leaves the active path and the
 * question it answered is returned, ready to be asked again.
 *
 * The old answer is kept as an inactive branch, so a user who preferred it can
 * go back — which is why regeneration is not a deletion.
 */
export async function prepareRegeneration(input: {
  conversationId: string;
  userId: string;
  messageId: string;
}): Promise<{ prompt: string; parentMessageId: string | null }> {
  await requireOwned(input.conversationId, input.userId);

  const target = await chatRepo.findMessage(input.messageId, input.conversationId);
  if (!target || target.role !== 'ASSISTANT') {
    throw new AppError(
      'VALIDATION',
      'Only an assistant reply can be regenerated.',
      'يمكن إعادة توليد ردّ المساعد فقط.',
    );
  }

  const question = target.parentMessageId
    ? await chatRepo.findMessage(target.parentMessageId, input.conversationId)
    : undefined;

  if (!question) {
    throw new AppError(
      'VALIDATION',
      'The message this replied to is missing.',
      'الرسالة التي يردّ عليها غير موجودة.',
    );
  }

  await chatRepo.switchBranch(input.conversationId, target.id);
  await chatRepo.branchFrom({
    conversationId: input.conversationId,
    replacingMessageId: target.id,
    content: '',
    role: 'ASSISTANT',
  });

  return { prompt: question.content, parentMessageId: question.id };
}

export async function renameConversation(
  id: string,
  userId: string,
  title: string,
): Promise<AIConversation> {
  const renamed = await chatRepo.rename(id, userId, title);
  if (!renamed) {
    throw new AppError('NOT_FOUND', 'That conversation was not found.', 'لم يُعثر على المحادثة.');
  }
  return renamed;
}

export async function deleteConversation(
  id: string,
  userId: string,
  permanent = false,
): Promise<void> {
  const done = permanent
    ? await chatRepo.purge(id, userId)
    : await chatRepo.archive(id, userId);

  if (!done) {
    throw new AppError('NOT_FOUND', 'That conversation was not found.', 'لم يُعثر على المحادثة.');
  }

  logger.info('chat.conversationDeleted', { conversationId: id, permanent });
}

export async function switchToBranch(
  conversationId: string,
  userId: string,
  messageId: string,
): Promise<ThreadView> {
  await requireOwned(conversationId, userId);

  const switched = await chatRepo.switchBranch(conversationId, messageId);
  if (!switched) {
    throw new AppError('NOT_FOUND', 'That message was not found.', 'لم يُعثر على الرسالة.');
  }

  return getThread(conversationId, userId);
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * A title from the first message.
 *
 * No model call. People open a conversation by saying what they want, so the
 * opening words are already a good name for it — and a generated title costs a
 * request per thread, varies between runs, and is no better. Cut at a word
 * boundary so the result reads as a phrase rather than a truncation.
 */
export function titleFrom(message: string, maxLength = 60): string {
  const cleaned = message.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'New conversation';
  if (cleaned.length <= maxLength) return cleaned;

  const cut = cleaned.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}
