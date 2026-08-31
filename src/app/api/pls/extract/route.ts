import { z } from 'zod';

import {
  buildDraftFromStructure,
  parseProposedStructure,
  STRUCTURE_EXTRACTION_PROMPT,
} from '@/analysis/inference/pls/extract';
import { ok, withApi } from '@/server/http/api';
import { AppError } from '@/server/http/errors';
import { loadForAnalysis } from '@/server/services/dataset.service';
import { extractModelStructure } from '@/server/services/ai.service';

/**
 * Turns a sentence into a proposed model.
 *
 * The response is a draft for the builder, never a model that runs. Estimation
 * is a separate request the researcher makes after reading what was proposed —
 * because a model states what a study claims, and a language model guessing at
 * someone's construct definitions is guessing at their research question.
 */
const schema = z.object({
  datasetId: z.string(),
  locale: z.enum(['ar', 'en']).default('en'),
  description: z.string().min(10).max(2000),
});

type Body = z.infer<typeof schema>;

export const POST = withApi<Body>(
  { schema, rateLimit: { max: 30, windowSeconds: 300, key: 'pls.extract' } },
  async ({ user, body }) => {
    const loaded = await loadForAnalysis(body.datasetId, user.id);

    const reply = await extractModelStructure({
      userId: user.id,
      description: body.description,
      locale: body.locale,
      system: STRUCTURE_EXTRACTION_PROMPT,
    });

    const structure = parseProposedStructure(reply.text);

    if (!structure) {
      /*
       * A failure to parse is reported as "I could not read that", not as a
       * validation error about the researcher's sentence. The fault is the
       * extraction's, and telling them their description was invalid would send
       * them rewriting a sentence that was fine.
       */
      throw new AppError(
        'VALIDATION',
        'I could not work out a model from that description. Try naming each concept and how it affects the others.',
        'تعذّر استخراج نموذج من هذا الوصف. جرّب تسمية كل مفهوم وكيف يؤثّر في غيره.',
        { reasonKey: 'analysis.pls.extract.failed' },
      );
    }

    const extracted = buildDraftFromStructure(structure, loaded.data.columns);

    return ok({
      draft: extracted.draft,
      unmatchedConstructs: extracted.unmatchedConstructs,
      matchedIndicators: extracted.matchedIndicators,
      /*
       * Stated in the response rather than assumed by the client: this is a
       * proposal, and the interface must present it as one.
       */
      requiresConfirmation: true,
    });
  },
);
