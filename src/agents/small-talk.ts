/**
 * Recognising the opening of a conversation, without a model.
 *
 * Kept apart from the classifier so it has no imports: the classifier reaches
 * the model router and through it the database, and a function this small
 * should be testable without either.
 */

/*
 * Arabic is compared without its diacritics, hamza forms or ta marbuta, so that
 * "مساء الخير", "مساء خير" and "مسا الخير" are one greeting rather than three.
 */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* `\b` is ASCII-only even with the `u` flag, so the word end is spelled out for Arabic. */
const GREETING =
  /^(السلام عليكم|سلام|مرحبا|مرحبتين|اهلا|اهلين|هلا|هاي|صباح|مساء|مسا|يسعد|كيفك|كيف حالك|شكرا|يسلمو|تسلم|يعطيك العافيه|تمام|اوك|اوكي|hi|hello|hey|good (morning|afternoon|evening)|thanks|thank you|ok|okay)(?=\s|$)/u;

/*
 * Any sign of work sends the message to the model. Deliberately broad: a false
 * match here costs one classification call, while a miss would answer a request
 * for an analysis with pleasantries.
 */
const WORK =
  /(حلل|تحليل|اكتب|كتاب|ابحث|بحث|خط[هة]|ملف|عنوان|عناوين|اقترح|مقترح|احسب|حساب|ترجم|لخص|تلخيص|راجع|مراجع|دراس|جدول|بيانات|استبان|فرضي|منهج|اعطني|اعطيني|بدي|اريد|ابغ|ساعدني|كيف |ما هو|ما هي|ليش|لماذا|وين|اين|analy|writ|search|plan|file|title|suggest|comput|calculat|translat|summar|review|table|data|survey|hypothes|method|how |what |why |where |\?|؟)/u;

/** Pure, so the boundary can be tested: the opening of a conversation, and nothing else. */
export function isSmallTalk(message: string): boolean {
  const text = plain(message);
  if (!text || text.split(' ').length > 6) return false;

  /* Tested on the original too: `plain` strips the question mark. */
  return GREETING.test(text) && !WORK.test(text) && !/[?؟]/.test(message);
}
