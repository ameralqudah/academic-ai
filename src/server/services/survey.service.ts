/**
 * Producing a questionnaire draft.
 *
 * The model writes the items; everything around it — the scale labels, the item
 * codes, the demographics, the steps before use — is fixed here. That division
 * is deliberate: item wording is the part that genuinely needs a language
 * model, and the rest would vary between runs for no benefit if it were
 * generated too.
 *
 * A researcher who generates an instrument here and later analyses the
 * responses gets the item codes the PLS builder already recognises — `SAT1`,
 * `SAT2` — so construct matching works without them naming anything twice.
 */

import { logger } from '@/lib/logger';
import { AppError } from '@/server/http/errors';
import {
  buildSurveyPrompt,
  parseGeneratedSurvey,
  type GeneratedSurvey,
  type SurveyRequest,
} from '@/server/survey/generator';
import { generateSurveyItems } from '@/server/services/ai.service';
import { recordTurn } from '@/server/services/chat.service';

export async function generateSurvey(input: {
  userId: string;
  request: SurveyRequest;
  conversationId?: string | null;
  projectId?: string | null;
}): Promise<GeneratedSurvey> {
  const prompt = buildSurveyPrompt(input.request);

  const reply = await generateSurveyItems({
    userId: input.userId,
    prompt,
    locale: input.request.locale,
    /*
     * Sized for the request rather than fixed. Eight constructs at ten items
     * each is eighty items, and a budget set for a small instrument would
     * truncate a large one mid-JSON — which parses as a failure rather than as
     * a partial result.
     */
    maxTokens: Math.min(
      4000,
      600 + input.request.constructs.length * input.request.itemsPerConstruct * 60,
    ),
  });

  const survey = parseGeneratedSurvey(reply, input.request);

  if (!survey) {
    /*
     * Reported as the generator's failure, not the researcher's. Their request
     * was valid; the reply did not follow the shape, and telling them their
     * input was wrong would send them rewriting something that was fine.
     */
    logger.warn('survey.parseFailed', {
      constructs: input.request.constructs.length,
      replyLength: reply.length,
    });

    throw new AppError(
      'INTERNAL',
      'The instrument could not be generated in a usable form. Try again, or reduce the number of constructs.',
      'تعذّر توليد الأداة بصيغة صالحة. أعد المحاولة، أو قلّل عدد المقاييس الفرعية.',
      { reasonKey: 'survey.error.generationFailed' },
    );
  }

  if (input.conversationId) {
    await recordTurn({
      conversationId: input.conversationId,
      userId: input.userId,
      userMessage: `${input.request.topic} — ${input.request.constructs.map((c) => c.name).join(', ')}`,
      assistantMessage: '',
      payload: {
        results: [{ kind: 'survey', payload: survey as unknown as Record<string, unknown> }],
      },
    }).catch((error: unknown) => {
      logger.error('survey.persistFailed', {
        conversationId: input.conversationId,
        error: String(error),
      });
    });
  }

  logger.info('survey.generated', {
    constructs: survey.constructs.length,
    items: survey.constructs.reduce((total, construct) => total + construct.items.length, 0),
    reversed: survey.reversedCodes.length,
  });

  return survey;
}

/**
 * The instrument as a CSV header row.
 *
 * The column names a researcher will have when the responses come back, so
 * their file matches the instrument without renaming anything — and so the
 * reverse-coded items are visible as a list rather than something to remember.
 */
export function surveyToColumns(survey: GeneratedSurvey): {
  columns: string[];
  reversed: string[];
} {
  return {
    columns: [
      ...survey.demographics.map((item) => item.code),
      ...survey.constructs.flatMap((construct) => construct.items.map((item) => item.code)),
    ],
    reversed: survey.reversedCodes,
  };
}
