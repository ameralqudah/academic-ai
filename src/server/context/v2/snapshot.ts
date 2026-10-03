/**
 * The project summary snapshot (P1-E, Context V2).
 *
 * Always present when Context V2 is on, so a model never has to guess whether
 * it is working inside a project: it either reads what the project is, or
 * reads that there is none.
 *
 * **Member-scoped (WS4 A2).** Access is the project role
 * (`requireProjectRole`, the same rank the database policies use): any member,
 * from VIEWER up, sees the snapshot of a project they belong to; anyone else
 * gets exactly the no-project snapshot, which says nothing about whether the
 * project exists. The creator-only project reader of v1 (`findOwned`) is not
 * used, and no legacy creator-only record (datasets, analysis runs, tasks,
 * artifacts) is read here or stands in for membership.
 *
 * **No graph content here.** The snapshot is built from v1 project data only:
 * the project's fields and its sections' keys and status (never their
 * bodies). Its graph section is appended by the assembler, only with
 * `FF_CONTEXT_V2` and `FF_GRAPH` both on (`graph-context.ts`).
 *
 * **Integrity counts (R7).** Per section, the counts the numeric guard
 * recorded with the section's latest saved version (WS2 D2): numbers it
 * quarantined in model text, and research numbers in a person's text that
 * trace to no analysis (untraced). Counts only, read from the stored record:
 * nothing is recomputed, and no number, finding or source is copied in.
 *
 * **No active dataset.** Datasets are legacy creator-only records (WS4 A2),
 * so the member-scoped snapshot does not mention them.
 */

import { eq } from 'drizzle-orm';

import { db } from '@/server/db';
import { researchProjects } from '@/server/db/schema';
import { requireProjectRole, type ProjectRole } from '@/server/graph/service';
import { AppError } from '@/server/http/errors';
import * as projectsRepo from '@/server/repositories/projects.repository';

import { type ContextFragment } from '../envelope';

export const SNAPSHOT_ID = 'project-snapshot';

export interface ProjectSnapshot {
  /** The project the caller may read, or null (none given, or not a member). */
  projectId: string | null;
  role: ProjectRole | null;
  fragment: ContextFragment;
}

const NONE = {
  en: 'Project snapshot: no research project is attached to this conversation.',
  ar: 'لمحة المشروع: لا يرتبط بهذه المحادثة أي مشروع بحثي.',
} as const;

/** The caller's role in the project, or null when they are not a member (or it does not exist). */
export async function memberRole(projectId: string, userId: string): Promise<ProjectRole | null> {
  try {
    return await requireProjectRole(projectId, userId, 'VIEWER');
  } catch (error) {
    if (error instanceof AppError && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) return null;
    throw error;
  }
}

function snapshotFragment(content: string, projectId: string | null): ContextFragment {
  return {
    id: SNAPSHOT_ID,
    kind: 'project',
    authority: 'project-data',
    content,
    provenance: { source: 'project.snapshot', id: projectId ?? 'none' },
    relevance: 1,
    /* Always present: budgeting never drops it. */
    pinned: true,
    tokens: 0,
  };
}

/** A count the guard stored, or 0 when the record has none (never trusted beyond a non-negative integer). */
const counted = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0);

const numbers = (count: number, what: string) => `${count} ${what} number${count === 1 ? '' : 's'}`;

/** Per section id, the quarantined and untraced counts recorded with its latest saved version. */
async function integrityCounts(sectionIds: readonly string[]): Promise<Map<string, { quarantined: number; untraced: number }>> {
  const counts = new Map<string, { quarantined: number; untraced: number }>();
  for (const version of await projectsRepo.latestVersions(sectionIds)) {
    if (!version.integrity) continue;
    counts.set(version.sectionId, { quarantined: counted(version.integrity.quarantined), untraced: counted(version.integrity.manual) });
  }
  return counts;
}

function describeSection(section: { sectionKey: string; status: string | null }, integrity?: { quarantined: number; untraced: number }): string {
  const facts = [
    section.status ?? '',
    integrity?.quarantined ? numbers(integrity.quarantined, 'quarantined') : '',
    integrity?.untraced ? numbers(integrity.untraced, 'untraced') : '',
  ].filter(Boolean);
  return facts.length > 0 ? `${section.sectionKey} (${facts.join('; ')})` : section.sectionKey;
}

/** The snapshot for `userId`, member-scoped. Never throws for a project the caller cannot read. */
export async function projectSnapshot(input: { userId: string; projectId?: string | null; locale: 'ar' | 'en' }): Promise<ProjectSnapshot> {
  const none = (): ProjectSnapshot => ({ projectId: null, role: null, fragment: snapshotFragment(NONE[input.locale], null) });
  if (!input.projectId) return none();

  const role = await memberRole(input.projectId, input.userId);
  if (!role) return none();

  /*
   * Read by id only after the role check above, here rather than as a
   * repository export: an unscoped project lookup with no check in front of
   * it is what WS4 A5 removed.
   */
  const [project] = await db.select().from(researchProjects).where(eq(researchProjects.id, input.projectId)).limit(1);
  if (!project) return none();
  const sections = await projectsRepo.listSections(project.id);
  const integrity = await integrityCounts(sections.map((section) => section.id));

  const lines = [
    'Project snapshot:',
    `Title: ${project.title}`,
    project.problemArea ? `Problem area: ${project.problemArea}` : '',
    `Field: ${project.academicField}${project.specialization ? ` — ${project.specialization}` : ''}`,
    `Type: ${project.docType} (${project.degree}), language ${project.language}`,
    `Your role: ${role}`,
    sections.length > 0
      ? `Sections (${sections.length}): ${sections.map((section) => describeSection(section, integrity.get(section.id))).join(', ')}`
      : 'Sections: none written yet',
  ].filter(Boolean);

  return { projectId: project.id, role, fragment: snapshotFragment(lines.join('\n'), project.id) };
}
