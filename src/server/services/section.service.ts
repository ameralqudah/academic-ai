import { SECTION_BY_KEY, type SectionKey } from '@/config/research';
import { countWords } from '@/lib/text';
import type { ResearchSection } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import { allowedFromLegacyResults, checkNumbers } from '@/server/integrity/numbers';
import { sectionIntegrity, type SectionIntegrity } from '@/server/integrity/section';
import * as analysisRunsRepo from '@/server/repositories/analysis-runs.repository';
import * as projectsRepo from '@/server/repositories/projects.repository';

import { getOwnedProject, refreshProjectStats } from './project.service';

export interface SaveSectionInput {
  projectId: string;
  userId: string;
  sectionKey: SectionKey;
  content: string;
  heading?: string;
  status?: 'DRAFT' | 'AI_SUGGESTED' | 'USER_EDITED' | 'APPROVED';
  origin: 'AI' | 'USER';
  note?: string;
  /** What the numeric guard found in this text (WS2 D2), stored with the version. */
  integrity?: SectionIntegrity;
}

/**
 * Saving a section always writes a version first.
 *
 * That is what makes "rewrite this ten times" safe, and it is also what keeps the
 * AI's output distinguishable from the researcher's own words — an integrity
 * requirement, not a convenience.
 */
export async function saveSection(input: SaveSectionInput): Promise<ResearchSection> {
  await getOwnedProject(input.projectId, input.userId);

  const wordCount = countWords(input.content);
  const existing = await projectsRepo.findSection(input.projectId, input.sectionKey);

  const section = await projectsRepo.upsertSection({
    projectId: input.projectId,
    sectionKey: input.sectionKey,
    orderIndex: existing?.orderIndex ?? SECTION_BY_KEY[input.sectionKey]?.order ?? 0,
    heading: input.heading ?? existing?.heading ?? null,
    content: input.content,
    status: input.status ?? (input.origin === 'AI' ? 'AI_SUGGESTED' : 'USER_EDITED'),
    wordCount,
    ...(input.status === 'APPROVED' ? { approvedAt: new Date() } : {}),
  });

  if (input.content.trim().length > 0) {
    await projectsRepo.addVersion({
      sectionId: section.id,
      content: input.content,
      origin: input.origin,
      wordCount,
      note: input.note ?? null,
      integrity: input.integrity ?? null,
    });
  }

  await refreshProjectStats(input.projectId, input.userId);
  return section;
}

export interface UserEditInput {
  projectId: string;
  userId: string;
  sectionKey: SectionKey;
  content: string;
  heading?: string;
  status?: 'DRAFT' | 'USER_EDITED';
}

/**
 * A person's edit of a section, from the editor (WS2 N3). Their words are
 * always recorded as theirs (`origin: USER`), whatever the client says, and
 * the status can only be a draft or their edit — approval stays a separate,
 * deliberate action (`approveSection`).
 *
 * Editing an approved section revokes its approval (D4): what was approved is
 * no longer what is there, so the researcher approves it again. Saving the
 * same text is not an edit, so the editor's Save button on an unchanged,
 * approved section leaves the approval in place.
 */
export async function saveUserEdit(input: UserEditInput): Promise<ResearchSection> {
  await getOwnedProject(input.projectId, input.userId);
  const existing = await projectsRepo.findSection(input.projectId, input.sectionKey);
  if (existing?.status === 'APPROVED') {
    const sameHeading = input.heading === undefined || existing.heading === null || input.heading === existing.heading;
    if (existing.content === input.content && sameHeading) return existing;
  }
  const revoked = existing?.status === 'APPROVED';
  /*
   * A person's numbers are recorded, never changed (WS2 D2): the text is
   * scanned in person mode against the analyses attached to this section
   * (windowed runs excluded, D3), and the numbers that trace to none are
   * counted as manual. Nothing here blocks the save or a later approval.
   */
  const legacy = allowedFromLegacyResults(await analysisRunsRepo.listForSection(input.projectId, input.userId, input.sectionKey));
  const check = checkNumbers(input.content, { mode: 'person', allowed: legacy.values });
  return saveSection({
    projectId: input.projectId,
    userId: input.userId,
    sectionKey: input.sectionKey,
    content: input.content,
    heading: input.heading,
    status: input.status ?? (input.content.trim() ? 'USER_EDITED' : 'DRAFT'),
    origin: 'USER',
    ...(revoked ? { note: 'Edited after approval: approval revoked' } : {}),
    integrity: sectionIntegrity({ mode: 'person', check, legacy }),
  });
}

export async function approveSection(
  projectId: string,
  userId: string,
  sectionKey: SectionKey,
): Promise<ResearchSection> {
  await getOwnedProject(projectId, userId);

  const section = await projectsRepo.findSection(projectId, sectionKey);
  if (!section) throw AppError.notFound('section');
  if (!section.content.trim()) {
    throw AppError.conflict(
      'An empty section cannot be approved.',
      'لا يمكن اعتماد قسم فارغ.',
    );
  }

  const updated = await projectsRepo.updateSection(section.id, {
    status: 'APPROVED',
    approvedAt: new Date(),
  });
  if (!updated) throw AppError.notFound('section');

  await refreshProjectStats(projectId, userId);
  return updated;
}

export async function getSection(
  projectId: string,
  userId: string,
  sectionKey: SectionKey,
): Promise<ResearchSection> {
  await getOwnedProject(projectId, userId);
  const section = await projectsRepo.findSection(projectId, sectionKey);
  if (!section) throw AppError.notFound('section');
  return section;
}

export async function listVersions(projectId: string, userId: string, sectionKey: SectionKey) {
  const section = await getSection(projectId, userId, sectionKey);
  return projectsRepo.listVersions(section.id);
}

/**
 * When an early section changes, the sections derived from it may no longer fit.
 * Rather than silently rewriting them, we return the list so the UI can ask.
 */
export function dependentsOf(sectionKey: SectionKey): SectionKey[] {
  return Object.values(SECTION_BY_KEY)
    .filter((definition) => definition?.dependsOn.includes(sectionKey))
    .map((definition) => definition!.key);
}
