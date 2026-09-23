/**
 * Who may see or change statistics records (P1-C).
 *
 * The existing authorisation, not a new one:
 * - a record that belongs to a project is governed by the project role
 *   (`requireProjectRole`: VIEWER to read, EDITOR to create or run);
 * - a record with no project belongs to its creator alone.
 * A record the caller may not see answers exactly like one that does not exist.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '@/analysis/engine/types';
import { requireProjectRole } from '@/server/graph/service';
import { AppError } from '@/server/http/errors';

export interface StatsActor {
  userId: string;
}

export type Need = 'VIEWER' | 'EDITOR';

const notFound = (what: string) => new AppError('NOT_FOUND', `The ${what} was not found.`, 'العنصر المطلوب غير موجود.');

export async function authorise(record: { userId: string; projectId: string | null } | undefined, actor: StatsActor, need: Need, what: string): Promise<void> {
  if (!record) throw notFound(what);
  if (record.projectId) {
    /* NOT_FOUND for a non-member, FORBIDDEN for a member below the needed role. */
    await requireProjectRole(record.projectId, actor.userId, need);
    return;
  }
  if (record.userId !== actor.userId) throw notFound(what);
}

/** When a caller names a project, every record it touches must belong to that project. */
export function sameProject(record: { projectId: string | null }, projectId: string | null | undefined, what: string): void {
  if (projectId !== undefined && (record.projectId ?? null) !== (projectId ?? null)) throw notFound(what);
}

export const sha256 = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
export const hashOf = (value: unknown) => sha256(canonicalJson(value));
