import type { SectionKey } from '@/config/research';
import { SECTION_BY_KEY } from '@/config/research';
import { truncate } from '@/lib/text';
import type { ResearchProject, ResearchSection } from '@/server/db/schema';

import type { ProjectContext } from '../types';

/**
 * Builds the project snapshot that travels with every AI request.
 *
 * The hard part is budget. Sending every section in full would make a late-stage
 * request enormous; sending none would make the assistant contradict itself. The
 * compromise: the sections the current one *depends on* get a generous excerpt,
 * everything else that has content gets a short one, and the total is capped.
 */

const TOTAL_BUDGET_CHARS = 12_000;
const DEPENDENCY_BUDGET_CHARS = 3_000;
const BACKGROUND_BUDGET_CHARS = 700;

export interface BuildContextOptions {
  /** The section being written — its dependencies get the larger excerpts. */
  focusSection?: SectionKey;
  /** Override the excerpt budget (used by the chat, which has more room). */
  totalBudgetChars?: number;
}

export function buildProjectContext(
  project: ResearchProject,
  sections: ResearchSection[],
  headingFor: (key: SectionKey) => string,
  options: BuildContextOptions = {},
): ProjectContext {
  const dependencies = new Set<SectionKey>(
    options.focusSection ? (SECTION_BY_KEY[options.focusSection]?.dependsOn ?? []) : [],
  );

  const budget = options.totalBudgetChars ?? TOTAL_BUDGET_CHARS;
  let spent = 0;

  const ordered = [...sections].sort((a, b) => {
    // Dependencies first, then approved sections, then everything else in order.
    const aDep = dependencies.has(a.sectionKey) ? 0 : 1;
    const bDep = dependencies.has(b.sectionKey) ? 0 : 1;
    if (aDep !== bDep) return aDep - bDep;

    const aApproved = a.status === 'APPROVED' ? 0 : 1;
    const bApproved = b.status === 'APPROVED' ? 0 : 1;
    if (aApproved !== bApproved) return aApproved - bApproved;

    return a.orderIndex - b.orderIndex;
  });

  const included: ProjectContext['sections'] = [];

  for (const section of ordered) {
    if (section.sectionKey === options.focusSection) continue;
    const content = section.content.trim();
    if (!content) continue;
    if (spent >= budget) break;

    const allowance = dependencies.has(section.sectionKey)
      ? DEPENDENCY_BUDGET_CHARS
      : BACKGROUND_BUDGET_CHARS;
    const excerpt = truncate(content, Math.min(allowance, budget - spent));
    spent += excerpt.length;

    included.push({
      key: section.sectionKey,
      heading: section.heading ?? headingFor(section.sectionKey),
      excerpt,
      approved: section.status === 'APPROVED',
    });
  }

  // Restore document order so the model reads the project the way a human would.
  included.sort((a, b) => {
    const aIndex = sections.find((section) => section.sectionKey === a.key)?.orderIndex ?? 0;
    const bIndex = sections.find((section) => section.sectionKey === b.key)?.orderIndex ?? 0;
    return aIndex - bIndex;
  });

  return {
    title: project.title,
    academicField: project.academicField,
    specialization: project.specialization,
    degree: project.degree,
    language: project.language,
    researchType: project.researchType,
    docType: project.docType,
    keywords: project.keywords,
    problemArea: project.problemArea,
    sections: included,
  };
}
