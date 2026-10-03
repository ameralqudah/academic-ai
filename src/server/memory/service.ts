/**
 * Memories for people (P1-E, PR #5): the service behind the memory API and
 * the "What Academic AI remembers" pages.
 *
 * Defence in depth, three layers:
 * 1. **Route:** `FF_CONTEXT_V2` (off: the API does not exist), session, rate
 *    limits, a strict body schema (`memory/http.ts`).
 * 2. **Service (here):** the project role (`requireProjectRole`, the rank the
 *    database uses; a stranger, a removed member or a missing project is
 *    NOT_FOUND), and that the memory addressed belongs to the path it is
 *    addressed through (a user memory through `/me`, a project memory through
 *    its own project): a memory id from another place is NOT_FOUND.
 * 3. **Database:** every statement runs through `withMemoryScope`, so the RLS
 *    policies of migration 0018 decide again, and the start fails closed when
 *    RLS cannot be enforced. No owner-connection path exists here.
 *
 * People create memories as `user`, confirmed. A proposal (an agent's, status
 * `proposed`) becomes confirmed only through `confirm` here, by a person.
 */

import { eq } from 'drizzle-orm';

import { db } from '@/server/db';
import { researchProjects } from '@/server/db/schema';
import { requireProjectRole, type ProjectRole } from '@/server/graph/service';
import { AppError } from '@/server/http/errors';

import * as repo from './repository';
import type { MemoryKind } from './repository';

import type { Memory } from '@/server/db/schema';

const RANK: Record<ProjectRole, number> = { VIEWER: 1, COMMENTER: 2, EDITOR: 3, OWNER: 4 };

export interface MemoryView extends Pick<Memory, 'id' | 'scope' | 'kind' | 'content' | 'source' | 'status' | 'pinned' | 'projectId'> {
  confirmedAt: string | null;
  updatedAt: string;
  createdAt: string;
  /** Whether the caller may change it (the API and the database still decide). */
  editable: boolean;
  /** The caller wrote it (or it was proposed on their behalf). */
  mine: boolean;
  /** For an agent's proposal: the run that proposed it. */
  proposedBy: { runId: string; stepId: string | null } | null;
}

const notFound = () => new AppError('NOT_FOUND', 'That memory was not found.', 'لم يُعثر على هذه الذاكرة.');

function view(memory: Memory, userId: string, editable: boolean): MemoryView {
  const origin = (memory.origin ?? {}) as { runId?: unknown; stepId?: unknown };
  return {
    id: memory.id,
    scope: memory.scope,
    kind: memory.kind,
    content: memory.content,
    source: memory.source,
    status: memory.status,
    pinned: memory.pinned,
    projectId: memory.projectId,
    confirmedAt: memory.confirmedAt?.toISOString() ?? null,
    updatedAt: memory.updatedAt.toISOString(),
    createdAt: memory.createdAt.toISOString(),
    editable,
    mine: memory.userId === userId,
    proposedBy: typeof origin.runId === 'string' ? { runId: origin.runId, stepId: typeof origin.stepId === 'string' ? origin.stepId : null } : null,
  };
}

/** Where a memory is addressed: the caller's own memories, or one project's. */
export type MemoryPlace = { scope: 'user' } | { scope: 'project'; projectId: string };

/** The caller's role in the project (VIEWER and up), or NOT_FOUND / FORBIDDEN. */
async function roleIn(place: MemoryPlace, userId: string, minimum: ProjectRole): Promise<ProjectRole | null> {
  if (place.scope === 'user') return null;
  return requireProjectRole(place.projectId, userId, minimum);
}

const editableIn = (memory: Memory, userId: string, role: ProjectRole | null) =>
  memory.scope === 'user' ? memory.userId === userId : role !== null && (RANK[role] >= RANK.OWNER || (memory.userId === userId && RANK[role] >= RANK.EDITOR));

/** FORBIDDEN unless the caller may change it (the database's update and delete policies decide again). */
function mayChange(memory: Memory, userId: string, role: ProjectRole | null): Memory {
  if (!editableIn(memory, userId, role)) {
    throw new AppError('FORBIDDEN', 'You cannot change this memory.', 'لا يمكنك تعديل هذه الذاكرة.', { reason: 'memory_policy' });
  }
  return memory;
}

/** The memory, only if it belongs to `place` and the caller can see it; NOT_FOUND otherwise. */
async function addressed(place: MemoryPlace, userId: string, memoryId: string): Promise<Memory> {
  const memory = await repo.getMemory(userId, memoryId);
  if (!memory) throw notFound();
  if (place.scope === 'user' ? memory.scope !== 'user' || memory.userId !== userId : memory.scope !== 'project' || memory.projectId !== place.projectId) throw notFound();
  return memory;
}

export async function listMemoriesIn(place: MemoryPlace, userId: string, filter: { status?: repo.MemoryStatus } = {}): Promise<{ memories: MemoryView[]; role: ProjectRole | null }> {
  const role = await roleIn(place, userId, 'VIEWER');
  const rows = await repo.listMemories(userId, place.scope === 'user' ? { scope: 'user', ...filter } : { scope: 'project', projectId: place.projectId, ...filter });
  const own = place.scope === 'user' ? rows.filter((memory) => memory.userId === userId) : rows;
  return { memories: own.map((memory) => view(memory, userId, editableIn(memory, userId, role))), role };
}

export async function createMemoryIn(place: MemoryPlace, userId: string, input: { kind: MemoryKind; content: string; pinned?: boolean }): Promise<MemoryView> {
  const role = await roleIn(place, userId, 'EDITOR');
  /* A person's memory: source `user`, confirmed. Status and source are never taken from a request. */
  const memory = await repo.createMemory(userId, {
    scope: place.scope,
    projectId: place.scope === 'project' ? place.projectId : null,
    kind: input.kind,
    content: input.content,
    source: 'user',
    status: 'confirmed',
    pinned: input.pinned ?? false,
  });
  return view(memory, userId, editableIn(memory, userId, role));
}

export async function editMemoryIn(place: MemoryPlace, userId: string, memoryId: string, patch: { content?: string; kind?: MemoryKind; pinned?: boolean }): Promise<MemoryView> {
  const role = await roleIn(place, userId, 'VIEWER');
  mayChange(await addressed(place, userId, memoryId), userId, role);
  const memory = await repo.updateMemory(userId, memoryId, patch);
  return view(memory, userId, editableIn(memory, userId, role));
}

/** A person confirms a proposal, or restores an archived memory. The only way a proposal becomes confirmed. */
export async function confirmMemoryIn(place: MemoryPlace, userId: string, memoryId: string): Promise<MemoryView> {
  return setStatus(place, userId, memoryId, 'confirmed');
}

export async function archiveMemoryIn(place: MemoryPlace, userId: string, memoryId: string): Promise<MemoryView> {
  return setStatus(place, userId, memoryId, 'archived');
}

async function setStatus(place: MemoryPlace, userId: string, memoryId: string, status: 'confirmed' | 'archived'): Promise<MemoryView> {
  const role = await roleIn(place, userId, 'VIEWER');
  const current = mayChange(await addressed(place, userId, memoryId), userId, role);
  if (current.status === status) return view(current, userId, editableIn(current, userId, role));
  const memory = await repo.updateMemory(userId, memoryId, { status });
  return view(memory, userId, editableIn(memory, userId, role));
}

export async function deleteMemoryIn(place: MemoryPlace, userId: string, memoryId: string): Promise<void> {
  const role = await roleIn(place, userId, 'VIEWER');
  mayChange(await addressed(place, userId, memoryId), userId, role);
  await repo.deleteMemory(userId, memoryId);
}

/**
 * The project's title for a member (VIEWER and up): the memories page is
 * member-scoped, not creator-only. NOT_FOUND for anyone else, read by id only
 * after the role check.
 */
export async function projectTitleForMember(projectId: string, userId: string): Promise<{ title: string; role: ProjectRole }> {
  const role = await requireProjectRole(projectId, userId, 'VIEWER');
  const [project] = await db.select({ title: researchProjects.title }).from(researchProjects).where(eq(researchProjects.id, projectId)).limit(1);
  if (!project) throw AppError.notFound('project');
  return { title: project.title, role };
}
