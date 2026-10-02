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

/**
 * WS4 A3: a record already filed under one project is not used or re-filed
 * under another. The legacy paths load a dataset (or a run) by its owner and
 * then record the result under the project the request names; without this,
 * an owner's data from project X could be filed under project Y. A record with
 * no project, or a request that names none, is unaffected: legacy records stay
 * creator-only (WS4 A2), and attaching one's own unfiled data to a project one
 * may edit is what the editor check above already allows.
 */
export function assertSameProject(
  record: { projectId: string | null },
  projectId: string | null | undefined,
  what: 'dataset' | 'analysis',
): void {
  if (!projectId || !record.projectId || record.projectId === projectId) return;
  throw what === 'dataset'
    ? new AppError('NOT_FOUND', 'The dataset was not found in this project.', 'لم يُعثر على مجموعة البيانات في هذا المشروع.')
    : new AppError('NOT_FOUND', 'That analysis was not found in this project.', 'لم يُعثر على التحليل في هذا المشروع.');
}
