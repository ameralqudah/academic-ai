/**
 * Writing something longer than one model call.
 *
 * A researcher asked for a research paper and received a document that stopped
 * mid-sentence — "…and subject-specific", no full stop. The cap was two
 * thousand tokens, and raising it to four thousand would move the cliff rather
 * than remove it: a thesis chapter is longer than any number anyone picks.
 *
 * So generation continues until the model says it is finished, and every
 * boundary is checked. The two mechanisms are separate on purpose:
 *
 * - **Continuation** asks the model to carry on from where it stopped, up to a
 *   bounded number of rounds.
 * - **Detection** reads the provider's own stop reason, which says whether the
 *   text ended because the model finished or because it ran out of room.
 *
 * **Truncation is never silent.** Text cut short reads as finished to a
 * skimming eye, and a researcher who submits it learns otherwise from a
 * supervisor. When continuation cannot complete the work, the result says so
 * and the caller must not mark it complete.
 */

import { logger } from '@/lib/logger';
import type { AIProvider } from '@/ai/provider';

export interface GenerationResult {
  text: string;
  /** True when the model signalled it had finished, not run out of room. */
  complete: boolean;
  /** Model calls spent, for the task budget. */
  rounds: number;
  tokensIn: number;
  tokensOut: number;
  /**
   * Why it stopped, when it stopped early.
   *
   * `length` means the provider cut it; `rounds` means continuation hit its
   * own ceiling; `refused` means the model declined to continue. The three
   * need different responses from the caller, so they are distinguished.
   */
  incompleteReason?: 'length' | 'rounds' | 'refused';
}

/**
 * Provider stop reasons that mean "ran out of room" rather than "finished".
 *
 * Named per provider because they disagree: Google says MAX_TOKENS, OpenAI says
 * length, Anthropic says max_tokens. Reading the reason is far more reliable
 * than guessing from the text, which is what `looksTruncated` does and why it
 * remains only a fallback.
 */
const CUT_SHORT = new Set(['MAX_TOKENS', 'max_tokens', 'length', 'LENGTH']);

export interface GenerateLongInput {
  provider: AIProvider;
  system: string;
  prompt: string;
  locale: 'ar' | 'en';
  /**
   * How much to ask for per call.
   *
   * Not a limit on the output — a limit on each round. The total is whatever
   * the work needs, reached by continuing.
   */
  tokensPerRound?: number;
  /**
   * How many rounds are allowed.
   *
   * A ceiling exists because a model that never stops would spend a task's
   * whole budget on one section. Eight rounds is a long chapter; more than that
   * is a document that should have been planned as several steps.
   */
  maxRounds?: number;
  /** Called after each round, for progress. */
  onProgress?: (round: number, chars: number) => void;
}
export async function generateLongForm(input: GenerateLongInput): Promise<GenerationResult> {
  const tokensPerRound = input.tokensPerRound ?? (input.locale === 'ar' ? 3500 : 2500);
  const maxRounds = input.maxRounds ?? 6;

  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let round = 0;
  let lastStop: string | undefined;

  while (round < maxRounds) {
    round += 1;

    /*
     * The first round asks for the work; later rounds ask for the rest.
     *
     * The tail of what exists is sent rather than the whole draft: the model
     * needs to know where it stopped mid-sentence, not to re-read four thousand
     * words it just wrote, and sending the whole thing again would cost more on
     * every round than the round produces.
     */
    const continuing = text.length > 0;

    const messages = continuing
      ? [
          { role: 'user' as const, content: input.prompt },
          { role: 'assistant' as const, content: tailOf(text) },
          {
            role: 'user' as const,
            content:
              input.locale === 'ar'
                ? 'أكمل من حيث توقّفت بالضبط، بلا إعادة ما كُتب وبلا مقدّمة. إن كان النصّ قد اكتمل فاكتب: [تمّ]'
                : 'Continue from exactly where you stopped. Do not repeat what is written and do not add a preamble. If the text is complete, reply: [DONE]',
          },
        ]
      : [{ role: 'user' as const, content: input.prompt }];

    const result = await input.provider.complete({
      task: 'chat',
      system: input.system,
      messages,
      maxTokens: tokensPerRound,
      temperature: 0.6,
      locale: input.locale,
    });

    tokensIn += result.usage?.tokensIn ?? 0;
    tokensOut += result.usage?.tokensOut ?? 0;
    lastStop = result.stopReason;

    const chunk = result.text ?? '';

    /*
     * The model saying it is finished, which is believed over the stop reason.
     *
     * The two can disagree — a provider reports MAX_TOKENS while the text ends
     * with the completion marker — because the reason describes the transport
     * and the marker describes the work. Breaking out of the loop here would
     * fall through to the truncation check below and report finished work as
     * incomplete, so this returns directly.
     */
    if (/\[DONE\]|\[تمّ\]|\[تم\]/.test(chunk)) {
      const cleaned = chunk.replace(/\[DONE\]|\[تمّ\]|\[تم\]/g, '').trim();
      const full = text.length > 0 ? joinContinuation(text, cleaned) : cleaned;

      return { text: full, complete: true, rounds: round, tokensIn, tokensOut };
    }

    /*
     * A round that returns nothing means the model has no more to say, or is
     * refusing. Either way, continuing would spend calls on empty answers.
     */
    if (chunk.trim().length === 0) {
      logger.info('generation.emptyRound', { round });

      return {
        text,
        complete: text.length > 0,
        rounds: round,
        tokensIn,
        tokensOut,
        ...(text.length === 0 ? { incompleteReason: 'refused' as const } : {}),
      };
    }

    text = continuing ? joinContinuation(text, chunk) : chunk;
    input.onProgress?.(round, text.length);

    /*
     * The provider's own verdict. If it did not run out of room, the model
     * chose to stop — which means it is finished, and asking for more would
     * produce padding.
     */
    if (!CUT_SHORT.has(lastStop ?? '')) {
      return { text, complete: true, rounds: round, tokensIn, tokensOut };
    }
  }

  /*
   * Rounds exhausted while the provider was still cutting output short. The
   * work is genuinely incomplete, and saying otherwise is the failure this
   * whole module exists to prevent.
   */
  const cutShort = CUT_SHORT.has(lastStop ?? '');

  logger.warn('generation.incomplete', {
    rounds: round,
    chars: text.length,
    stopReason: lastStop,
  });

  return {
    text,
    complete: !cutShort,
    rounds: round,
    tokensIn,
    tokensOut,
    ...(cutShort ? { incompleteReason: round >= maxRounds ? ('rounds' as const) : ('length' as const) } : {}),
  };
}
