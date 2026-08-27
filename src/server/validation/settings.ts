import { z } from 'zod';

import { ACADEMIC_FIELDS, CITATION_STYLES } from '@/config/research';

export const updateSettingsSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    locale: z.enum(['ar', 'en']),
    theme: z.enum(['LIGHT', 'DARK', 'SYSTEM']),
    citationStyle: z.enum(CITATION_STYLES),
    defaultAcademicField: z.enum(ACADEMIC_FIELDS),
    emailNotifications: z.boolean(),
  })
  .partial();

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
