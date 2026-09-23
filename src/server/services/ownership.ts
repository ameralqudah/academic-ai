/**
 * Checks for ids a request names but does not own by construction (P1-C
 * audit): a `projectId` or `conversationId` in an upload, an analysis or an
 * attach request used to be stored without being checked, so a result could be
 * filed under someone else's project. Each is now checked against the caller:
 * the project through the existing project roles (editor, since it writes),
 * the conversation by ownership. Unknown and foreign answer alike: NOT_FOUND.
 */

import { requireProjectRole } from '@/server/graph/service';
import { AppError } from '@/server/http/errors';
import * as conversationsRepo from '@/server/repositories/conversations.repository';

export async function assertProjectLink(userId: string, projectId: string | null | undefined): Promise<void> {
  if (!projectId) return;
  await requireProjectRole(projectId, userId, 'EDITOR');
}

export async function assertConversationLink(userId: string, conversationId: string | null | undefined): Promise<void> {
  if (!conversationId) return;
  if (!(await conversationsRepo.findOwned(conversationId, userId))) {
    throw new AppError('NOT_FOUND', 'The conversation was not found.', 'لم يُعثر على المحادثة.');
  }
}
