import {
  PROPOSAL_SECTIONS,
  THESIS_CHAPTERS,
  WIZARD_STEPS,
  type SectionKey,
} from '@/config/research';
import { countWords } from '@/lib/text';
import type { ResearchProject, ResearchSection } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as projectsRepo from '@/server/repositories/projects.repository';
import type { CreateProjectInput } from '@/server/validation/project';

import { assertCanCreateProject, recordSimple } from './usage.service';

/** The section skeleton a project starts life with, decided by what is being written. */
function sectionPlan(docType: ResearchProject['docType']): SectionKey[] {
  if (docType === 'PROPOSAL') return PROPOSAL_SECTIONS;
  if (docType === 'THESIS') return THESIS_CHAPTERS.map((chapter) => chapter.key);
  return WIZARD_STEPS.map((step) => step.key);
}

/**
 * A placeholder title until the user picks a real one in the title generator.
 * Deliberately not AI-generated: creating a project must never depend on the AI
 * provider being reachable.
 */
function provisionalTitle(input: CreateProjectInput): string {
  const head = input.keywords.slice(0, 3).join(' · ');
  return head || input.problemArea.slice(0, 80);
}

export async function createProject(
  userId: string,
  input: CreateProjectInput,
): Promise<ResearchProject> {
  await assertCanCreateProject(userId);

  const project = await projectsRepo.create({
    userId,
    title: provisionalTitle(input),
    academicField: input.academicField,
    specialization: input.specialization || null,
    degree: input.degree,
    language: input.language,
    researchType: input.researchType,
    docType: input.docType,
    keywords: input.keywords,
    problemArea: input.problemArea,
  });

  const keys = sectionPlan(project.docType);
  await projectsRepo.insertSections(
    keys.map((key, index) => ({
      projectId: project.id,
      sectionKey: key,
      orderIndex: index,
      status: 'EMPTY' as const,
    })),
  );

  await recordSimple(userId, 'PROJECT', 1, project.id);
  return project;
}

/**
 * Changing what the researcher is writing adds the sections the new shape needs
 * and leaves the existing ones untouched — a problem statement written for a
 * paper is still the problem statement of the thesis.
 */
export async function switchDocType(
  projectId: string,
  userId: string,
  docType: ResearchProject['docType'],
): Promise<ResearchProject> {
  const project = await getOwnedProject(projectId, userId);
  if (project.docType === docType) return project;

  const existing = await projectsRepo.listSections(projectId);
  const existingKeys = new Set(existing.map((section) => section.sectionKey));
  const keys = sectionPlan(docType);

  await projectsRepo.insertSections(
    keys
      .filter((key) => !existingKeys.has(key))
      .map((key, index) => ({
        projectId,
        sectionKey: key,
        orderIndex: existing.length + index,
        status: 'EMPTY' as const,
      })),
  );

  const updated = await projectsRepo.update(projectId, { docType });
  if (!updated) throw AppError.notFound('project');
  return updated;
}

export async function listProjects(userId: string, limit?: number): Promise<ResearchProject[]> {
  return projectsRepo.listByUser(userId, limit);
}

export async function getOwnedProject(id: string, userId: string): Promise<ResearchProject> {
  const project = await projectsRepo.findOwned(id, userId);
  if (!project) throw AppError.notFound('project');
  return project;
}

export async function getProjectWithSections(id: string, userId: string) {
  const project = await getOwnedProject(id, userId);
  const sections = await projectsRepo.listSections(id);
  return { project, sections };
}

export async function updateProject(
  id: string,
  userId: string,
  values: Partial<ResearchProject>,
): Promise<ResearchProject> {
  await getOwnedProject(id, userId);
  const updated = await projectsRepo.update(id, values);
  if (!updated) throw AppError.notFound('project');
  return updated;
}

export async function deleteProject(id: string, userId: string): Promise<void> {
  await getOwnedProject(id, userId);
  await projectsRepo.remove(id);
}

/**
 * Progress is the share of sections that carry real content — approved sections
 * count fully, drafts count half. It is stored so the dashboard does not have to
 * load every section to draw a progress bar.
 */
export function computeProgress(sections: ResearchSection[]): number {
  if (sections.length === 0) return 0;
  const score = sections.reduce((total, section) => {
    if (section.status === 'APPROVED') return total + 1;
    if (section.status === 'EMPTY') return total;
    return total + 0.5;
  }, 0);
  return Math.round((score / sections.length) * 100);
}

export async function refreshProjectStats(projectId: string, userId: string): Promise<void> {
  const { sections } = await getProjectWithSections(projectId, userId);
  const totalWords = sections.reduce((sum, section) => sum + section.wordCount, 0);
  await projectsRepo.update(projectId, {
    progressPercent: computeProgress(sections),
    totalWords,
  });
}

export function wordCountOf(content: string): number {
  return countWords(content);
}
