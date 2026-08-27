import { ok, withApi } from '@/server/http/api';
import { generateSection } from '@/server/services/ai.service';
import { generateSectionSchema, type GenerateSectionInput } from '@/server/validation/ai';

export const maxDuration = 60;

export const POST = withApi<GenerateSectionInput>(
  {
    schema: generateSectionSchema,
    rateLimit: { key: 'ai-section', max: 30, windowSeconds: 300 },
  },
  async ({ user, body }) => {
    const section = await generateSection(
      user.id,
      body.projectId,
      body.sectionKey,
      body.instruction,
    );
    return ok(section);
  },
);
