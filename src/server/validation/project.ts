import { z } from 'zod';

import {
  ACADEMIC_FIELDS,
  DEGREES,
  DOC_TYPES,
  PROJECT_LANGUAGES,
  RESEARCH_TYPES,
  SECTION_KEYS,
} from '@/config/research';

export const createProjectSchema = z.object({
  academicField: z.enum(ACADEMIC_FIELDS),
  specialization: z.string().trim().max(160).optional().or(z.literal('')),
  degree: z.enum(DEGREES),
  language: z.enum(PROJECT_LANGUAGES),
  researchType: z.enum(RESEARCH_TYPES),
  docType: z.enum(DOC_TYPES).default('PAPER'),
  keywords: z.array(z.string().trim().min(2).max(60)).min(1).max(10),
  problemArea: z.string().trim().min(20, 'tooShort').max(2000),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    title: z.string().trim().min(3).max(400),
    specialization: z.string().trim().max(160),
    keywords: z.array(z.string().trim().min(2).max(60)).max(10),
    problemArea: z.string().trim().max(2000),
    docType: z.enum(DOC_TYPES),
    isArchived: z.boolean(),
  })
  .partial();

/**
 * A person's edit of a section (WS2 N3). The client may only save a draft or
 * its own edit: approval is a separate action (POST), AI_SUGGESTED is written
 * only by the server when a model drafts the section, and who wrote the text
 * is decided by the server, not sent by the client (an `origin` in the body is
 * dropped).
 */
export const updateSectionSchema = z.object({
  content: z.string().max(120_000),
  heading: z.string().trim().max(300).optional(),
  status: z.enum(['DRAFT', 'USER_EDITED']).optional(),
});

export const sectionKeySchema = z.enum(SECTION_KEYS);
