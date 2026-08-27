import { z } from 'zod';

import { SECTION_KEYS, TOOL_KEYS } from '@/config/research';

export const generateTitlesSchema = z.object({
  projectId: z.string().min(1),
  count: z.number().int().min(3).max(12).default(10),
});

export const improveTitleSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(5).max(400),
});

export const compareTitlesSchema = z.object({
  projectId: z.string().min(1),
  titles: z.array(z.string().trim().min(5).max(400)).min(2).max(6),
});

export const selectTitleSchema = z.object({
  projectId: z.string().min(1),
  candidateId: z.string().min(1),
});

export const generateSectionSchema = z.object({
  projectId: z.string().min(1),
  sectionKey: z.enum(SECTION_KEYS),
  instruction: z.string().trim().max(1500).optional(),
});

export const chatSchema = z.object({
  projectId: z.string().min(1),
  message: z.string().trim().min(1).max(6000),
  sectionKey: z.enum(SECTION_KEYS).optional(),
});

export const toolRunSchema = z.object({
  toolKey: z.enum(TOOL_KEYS),
  projectId: z.string().min(1).optional(),
  input: z.string().trim().min(10).max(20_000),
  options: z.record(z.string(), z.string()).optional(),
});

export type GenerateTitlesInput = z.infer<typeof generateTitlesSchema>;
export type ImproveTitleInput = z.infer<typeof improveTitleSchema>;
export type CompareTitlesInput = z.infer<typeof compareTitlesSchema>;
export type SelectTitleInput = z.infer<typeof selectTitleSchema>;
export type GenerateSectionInput = z.infer<typeof generateSectionSchema>;
export type ChatInput = z.infer<typeof chatSchema>;
export type ToolRunInput = z.infer<typeof toolRunSchema>;
