import { SECTION_BY_KEY, type SectionKey } from '@/config/research';
import { countWords } from '@/lib/text';
import type { ResearchSection } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
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
    });
  }

  await refreshProjectStats(input.projectId, input.userId);
  return section;
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
