/**
 * Deciding what language to write in.
 *
 * A researcher asked in Arabic and received English. Nothing was broken: the
 * locale came from the interface, which was set to English, and the request
 * text was never consulted. Someone browsing in English who writes in Arabic
 * means Arabic, and the interface has no way to know that.
 *
 * So the language is read from the request itself, in a fixed order of
 * authority: what the user explicitly asked for, then what they wrote in, then
 * what the surrounding work is in, then the interface as a last resort.
 *
 * **Explicit instruction wins over script.** "اكتب البحث بالإنجليزية" is an
 * Arabic sentence asking for English output, and a detector that only counted
 * letters would get it exactly backwards.
 */

export type OutputLanguage = 'ar' | 'en';

export interface LanguageDecision {
  language: OutputLanguage;
  /** Which rule decided, so a wrong call can be traced rather than guessed at. */
  reason: 'explicit' | 'script' | 'context' | 'interface';
  /** 0 to 1. Low confidence is worth surfacing, not worth overriding. */
  confidence: number;
}

/**
 * A word boundary that works in every script.
 *
 * `\b` is defined by the ASCII word class, so it never matches between two
 * Arabic letters — `/عربي\b/` matched nothing at all, in any input, and did so
 * silently. Two patterns in this file were dead for that reason.
 *
 * The replacement asserts that what follows is not a letter or digit in any
 * script, which is what a word boundary means when the alphabet is not
 * Latin. Diacritics are excluded from the "letter" class deliberately, so
 * "عربيًا" still ends the word "عربي".
 */
const WORD_END = '(?![\\p{L}\\p{N}])';

/*
 * Phrases that name an output language directly.
 *
 * Written in both scripts because the request may name English in Arabic or
 * Arabic in English, and both are ordinary things for a bilingual researcher to
 * write.
 */
const WANTS_ENGLISH = [
  /\b(?:in|into|using)\s+english\b/i,
  /\benglish\s+(?:version|output|please|only)\b/i,
  /بالإنجليزي(?:ة|ه)?/,
  /بالانجليزي(?:ة|ه)?/,
  /باللغة\s*الإنجليزية/,
  /باللغة\s*الانجليزية/,
  new RegExp(`انجليزي${WORD_END}`, 'u'),
];

const WANTS_ARABIC = [
  /\b(?:in|into|using)\s+arabic\b/i,
  /\barabic\s+(?:version|output|please|only)\b/i,
  /بالعربي(?:ة|ه)?/,
  /باللغة\s*العربية/,
  new RegExp(`عربي${WORD_END}`, 'u'),
];

/** How much of the text is Arabic script, ignoring digits and punctuation. */
export function arabicShare(text: string): number {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return 0;

  const arabic = (letters.match(/[\u0600-\u06FF]/g) ?? []).length;
  return arabic / letters.length;
}
/**
 * The language the output should be written in.
 *
 * Order matters and is the whole design: an explicit request beats the script
 * it was written in, which beats the surrounding work, which beats the
 * interface. Each rule only applies when the one above it found nothing.
 */
export function decideOutputLanguage(input: {
  /** What the user just wrote. */
  request: string;
  /** Earlier user turns, most recent first. Used only when the request is short. */
  history?: string[];
  /** The language of the project or document being worked on. */
  contextLanguage?: OutputLanguage | null;
  /** What the interface is set to. The weakest signal. */
  interfaceLocale?: OutputLanguage;
}): LanguageDecision {
  const request = input.request ?? '';

  /*
   * An explicit instruction, whichever script it is written in. "اكتب البحث
   * بالإنجليزية" is Arabic text requesting English, and counting letters would
   * get it backwards.
   */
  for (const pattern of WANTS_ENGLISH) {
    if (pattern.test(request)) return { language: 'en', reason: 'explicit', confidence: 0.95 };
  }

  for (const pattern of WANTS_ARABIC) {
    if (pattern.test(request)) return { language: 'ar', reason: 'explicit', confidence: 0.95 };
  }

  const share = arabicShare(request);
  const letters = request.replace(/[^\p{L}]/gu, '').length;

  /*
   * A short message decides nothing on its own.
   *
   * "أكمل" is entirely Arabic and "continue" entirely English, and both are
   * follow-ups to whatever came before — reading them as a language choice
   * would flip a document's language on the word "next". Checked before the
   * script rule, because the script rule would otherwise answer confidently.
   */
  if (request.trim().length < 25) {
    for (const earlier of input.history ?? []) {
      const earlierShare = arabicShare(earlier);
      const earlierLetters = earlier.replace(/[^\p{L}]/gu, '').length;

      if (earlierLetters < 3) continue;
      if (earlierShare >= 0.5) return { language: 'ar', reason: 'context', confidence: 0.7 };
      if (earlierShare < 0.2) return { language: 'en', reason: 'context', confidence: 0.7 };
    }
  }

  /*
   * The script the request is written in. A clear majority decides; a mixed
   * message falls through, because "اعمل PLS-SEM analysis" is genuinely
   * ambiguous and guessing from a bare majority would be a coin toss dressed
   * as a decision.
   *
   * `letters > 0` matters: a request with no letters at all — "123 456" —
   * has a share of zero, which is not evidence of English.
   */
  if (letters > 0) {
    if (share >= 0.5) return { language: 'ar', reason: 'script', confidence: share };
    if (share < 0.2) return { language: 'en', reason: 'script', confidence: 1 - share };
  }

  /* The document being worked on: a chapter added to an Arabic thesis is Arabic. */
  if (input.contextLanguage) {
    return { language: input.contextLanguage, reason: 'context', confidence: 0.6 };
  }

  /*
   * The interface, last. It says what the user is reading, not what they are
   * writing, and treating it as authoritative is what produced an English
   * chapter for an Arabic request.
   */
  return { language: input.interfaceLocale ?? 'en', reason: 'interface', confidence: 0.4 };
}

/**
 * An instruction telling the model which language to answer in.
 *
 * Stated rather than implied. A prompt written in Arabic does not reliably
 * produce Arabic — this product watched a model answer an Arabic prompt in
 * English — so the requirement is made explicit and negative: not merely
 * "write in Arabic" but "do not write in English".
 */
export function languageInstruction(language: OutputLanguage): string {
  return language === 'ar'
    ? 'اكتب ردّك كاملًا بالعربية الفصحى. لا تكتب أي جملة بالإنجليزية إلا للمصطلحات التقنية التي لا مقابل لها.'
    : 'Write your entire response in English.';
}

