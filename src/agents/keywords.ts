/**
 * Recognising a request from its words, before any model is involved.
 *
 * This exists because of a failure that only appeared in production. The model
 * classifier returned nothing usable, the code fell back to "I did not
 * understand", and every request — however plainly worded — got the same reply.
 * A user typing "أريد تحليل PLS-SEM" was told the request was unclear, which is
 * both wrong and impossible to argue with.
 *
 * The deeper problem was not the model. It was that a request naming its
 * analysis outright never needed one. "PLS-SEM", "ألفا كرونباخ", "الانحدار
 * اللوجستي" are not sentences to be interpreted; they are names. Sending them to
 * a language model to find out what they mean adds latency, adds cost, and adds
 * a way for the whole thing to fail.
 *
 * So the obvious cases are matched here, deterministically, and the model is
 * consulted only for what is genuinely ambiguous. Three consequences follow, all
 * of them good: the clearest requests become the fastest, they cost nothing, and
 * they keep working when the model provider does not.
 *
 * **Order matters and is deliberate.** Specific analyses are tested before
 * general ones, because "نمذجة المعادلات البنائية بطريقة المربعات الجزئية"
 * contains the word "معادلات" and would otherwise match something looser. The
 * most specific true match wins.
 *
 * **A weak match returns null rather than guessing.** Falling through to the
 * model is the correct outcome for anything this file is not certain about.
 * Matching loosely to avoid an API call would trade a slow correct answer for a
 * fast wrong one.
 */

import type { IntentKey } from './registry';

interface Rule {
  intent: IntentKey;
  /** Any one of these is enough. Matched case-insensitively. */
  patterns: RegExp[];
}

/**
 * Checked in order. Specific before general — reordering this list changes
 * behaviour, so the sequence is part of the logic rather than presentation.
 */
const RULES: Rule[] = [
  /* ------------------- named methods that are not built ------------------- */

  /*
   * Explanations and definitions, matched FIRST.
   *
   * The ordering here is the whole logic, and it took a failing test to get
   * right. "اشرح لي الانحدار الخطي" contains "الانحدار", so a regression rule
   * placed above this one claims it — and routes a request for teaching to an
   * analysis that demands a file the user never had. "ما الفرق بين Pearson و
   * Spearman" fails the same way.
   *
   * The distinguishing signal is the verb, not the noun: "اشرح" and "ما الفرق"
   * ask to be taught, while "شغّل" and "احسب" ask for computation. Since the
   * verb usually opens the sentence and the statistical term follows it, asking
   * about the verb first is both simpler and more reliable than trying to
   * exclude every term from every analysis rule.
   */
  {
    intent: 'general.question',
    patterns: [
      /*
       * No \b on the Arabic patterns.
       *
       * JavaScript's word boundary is defined against [A-Za-z0-9_], so every
       * Arabic letter counts as a non-word character and \b matches in places
       * that make no sense — and fails in the places that do. These rules
       * anchor on the start of the string or on whitespace instead, which is
       * what a word boundary actually means here.
       *
       * This cost a failing test to find: "اشرح لي الانحدار الخطي" was being
       * routed to a regression analysis because the \b-anchored explanation
       * pattern never matched and the statistics rule below did.
       */
      /(^|\s)(اشرح|وضّ?ح|فسّ?ر|عرّ?ف)(\s|$)/,
      /*
       * "ما هو التحليل الإحصائي المناسب" opens with "ما هو" and is not a
       * request to be taught — it is a request to choose a test for the user's
       * data, which needs their file. The negative lookahead keeps that phrasing
       * with the recommender rather than letting the explanation rule claim it
       * by virtue of coming first.
       */
      /*
       * Two exclusions, both learned from real phrasings rather than invented
       * ones. "ما هو التحليل المناسب" asks the recommender to choose a test,
       * and "ما هي الدراسات السابقة" asks a database for papers — neither is a
       * request to be taught, and the explanation rule would claim both simply
       * by coming first.
       */
      /(^|\s)ما(?!\s+(هو\s+)?(التحليل|الاختبار)(\s+\S+){0,2}\s+(المناسب|الأنسب))(?!\s+(هي\s+)?(ال)?(دراسات|أبحاث|بحوث|أدبيات))\s+(هو|هي|معنى|تعريف)(\s|$)/,
      /(^|\s)ما\s+(هو\s+)?الفرق\s+بين(\s|$)/,
      /(^|\s)متى\s+(أستخدم|نستخدم|يُستخدم)(\s|$)/,
      /(^|\s)أيهما\s+(أفضل|أنسب)(\s|$)/,
      /(^|\s)كيف\s+(أفسّ?ر|نفسّ?ر|أقرأ|نقرأ)(\s|$)/,
      /(^|\s)لماذا(\s|$)/,
      /*
       * Ordinary questions, which the rules above do not cover.
       *
       * Everything before this anchors on a teaching verb — "اشرح", "ما الفرق",
       * "متى أستخدم" — because the rules were written for a researcher asking
       * about statistics. A user asked "الأردن أين موقعها" and got a request
       * for clarification: the sentence matched nothing, fell below the
       * confidence floor, and became `general.unclear`.
       *
       * That is the wrong failure. The assistant answers general questions —
       * the general prompt has handled knowledge limits since it was written —
       * and a plain question should reach it rather than being interrogated.
       *
       * These patterns are deliberately broad. The cost of a false positive is
       * a question answered conversationally that could have been an analysis
       * request; the cost of a false negative is the product refusing to
       * understand a sentence any person would. The second is worse, and the
       * analysis rules are checked first anyway.
       */
      /*
       * A question word, but not one opening small talk or a capability
       * question.
       *
       * "مرحبا كيف حالك" and "ماذا تستطيع أن تفعل" are conversation, not
       * questions with answers — they belong to the model, which handles them
       * better than a rule can. The exclusions are the phrasings that actually
       * appear rather than an attempt to enumerate politeness.
       */
      /(^|\s)(أين|متى|كم|هل)(\s|$)/,
      /(^|\s)من\s+(هو|هي|هم|كان|اخترع|كتب|أسّ?س)(\s|$)/,
      /(^|\s)كيف(?!\s+حالك)\s+(يمكن|أستطيع|نستطيع|تعمل|يعمل|أصبح|صار|تمّ?)(\s|$)/,
      /(^|\s)ماذا(?!\s+(تستطيع|يمكنك|تفعل))\s+(يعني|تعني|حدث|يحدث|قال|تقول)(\s|$)/,
      /(^|\s)ما\s+(اسم|أهم|أفضل|أشهر|أبرز)(\s|$)/,
      /(^|\s)(حدّ?ثني|أخبرني|قل\s+لي)(\s|$)/,
      /^\s*(explain|define|describe|tell me about)\b/i,
      /\bwhat\s+(is|are|does|do)\b/i,
      /\bwhat('s| is)\s+the\s+difference\s+between\b/i,
      /\bwhen\s+(should|do)\s+i\s+use\b/i,
      /\bhow\s+do\s+i\s+(interpret|read)\b/i,
      /\bwhy\s+(is|are|does|do)\b/i,
      /* The English equivalents, for the same reason. */
      /*
       * `who wrote`, `where did`, `which came` — a question word followed by a
       * plain past-tense verb rather than an auxiliary. Written as two patterns
       * because merging them into one alternation makes it unreadable and
       * makes a later change to either half risk the other.
       */
      /\b(where|when|who|which|how many|how much)\s+(is|are|was|were|do|does|did|can|should|will|would)\b/i,
      /*
       * A question word opening the sentence.
       *
       * The narrower version matched a following verb by its ending, and
       * English's irregular verbs defeat that immediately: `who wrote`, `which
       * came`. Anchoring on the opening word instead is simpler and catches
       * them all — and it is safe here because every analysis rule is checked
       * before this one, so "who" opening a sentence has already failed to be
       * a request to compute something.
       */
      /*
       * A question word opening the sentence, minus the two shapes that are not
       * questions about the world.
       *
       * "what can you do" is a capability question and belongs to the model,
       * which knows what it can do. "which test should I use" is a request for
       * the recommender, which needs the user's file — routing it here would
       * answer conversationally about tests in general when the researcher
       * wanted one chosen for their data.
       */
      /^\s*(who|whose|whom|where|when)\b/i,
      /^\s*which(?!\s+(test|analysis|method|statistic))\b/i,
      /^\s*what(?!\s+(can|could|do)\s+you)(?!\s+(test|analysis|method))\b/i,
      /\bis\s+(there|it|the)\b/i,
      /\bcan\s+you\s+(tell|explain|describe)\b/i,
    ],
  },

  {
    intent: 'stats.plsSem',
    patterns: [
      /\bpls[\s-]?sem\b/i,
      /\bsmart\s?pls\b/i,
      /*
       * `PLS` on its own, which is how researchers usually write it — "اعمل
       * تحليل PLS لبياناتي". The strict form required "pls-sem" together and
       * missed the common case entirely.
       *
       * The guard above already keeps questions *about* PLS out of here, so a
       * bare mention reaching this point is a request to run one.
       */
      /\bpls\b/i,
      /\bpartial\s+least\s+squares\b/i,
      /المربعات\s+الجزئية/,
      /بي\s?إل\s?إس/,
    ],
  },
  {
    intent: 'stats.cbSem',
    patterns: [
      /\bcb[\s-]?sem\b/i,
      /\bamos\b/i,
      /\bconfirmatory\s+factor\s+analysis\b/i,
      /\bcfa\b/i,
      /التحليل\s+العاملي\s+التوكيدي/,
      /نمذجة\s+المعادلات\s+البنائية/,
      /المعادلة\s+البنائية/,
    ],
  },
  {
    intent: 'stats.logistic',
    patterns: [
      /\blogistic\s+regression\b/i,
      /الانحدار\s+اللوجست/,
      /الانحدار\s+اللوجيست/,
    ],
  },
  {
    intent: 'stats.nonparametric',
    patterns: [
      /\bmann[\s-]?whitney\b/i,
      /\bwilcoxon\b/i,
      /\bkruskal[\s-]?wallis\b/i,
      /مان[\s-]?ويتني/,
      /ويلكوكسون/,
      /كروسكال/,
      /اختبارات?\s+لا\s?معلمية/,
      /اللامعلمية/,
    ],
  },

  /* ---------------------------- built analyses ---------------------------- */

  {
    intent: 'stats.reliability',
    patterns: [
      /\bcronbach\b/i,
      /كرونباخ/,
      /معامل\s+الثبات/,
      /ثبات\s+(المقياس|الأداة|الاستبانة)/,
      /\breliability\b/i,
      /\bkr[\s-]?20\b/i,
    ],
  },
  {
    intent: 'stats.predict',
    patterns: [
      /\b(multiple\s+|linear\s+)?regression\b/i,
      /الانحدار\s+(الخطي|المتعدد|البسيط)/,
      /(^|\s)تنبؤ/,
      /تحليل\s+الانحدار/,
    ],
  },
  {
    intent: 'stats.relate',
    patterns: [
      /\b(pearson|spearman)\b/i,
      /بيرسون/,
      /سبيرمان/,
      /معامل\s+الارتباط/,
      /العلاقة\s+الارتباطية/,
      /\bcorrelation\b/i,
      /مصفوفة\s+الارتباط/,
    ],
  },
  {
    intent: 'stats.compare',
    patterns: [
      /\banova\b/i,
      /\bt[\s-]?test\b/i,
      /(^|\s)اختبار\s?ت(\s|$)/,
      /تحليل\s+التباين/,
      /الفروق\s+(بين|في)/,
      /مقارنة\s+(بين|المتوسطات)/,
      /قارن\s+بين/,
      /\bcompare\s+(the\s+)?(two\s+)?groups?\b/i,
      /\bdifference[s]?\s+between\b/i,
    ],
  },
  {
    intent: 'stats.categorical',
    patterns: [
      /\bchi[\s-]?square\b/i,
      /مربع\s+كاي/,
      /كاي\s?تربيع/,
      /\bfisher('s)?\s+exact\b/i,
      /جدول\s+توافقي/,
    ],
  },

  /* -------------------------------- data ---------------------------------- */

  {
    intent: 'data.clean',
    patterns: [
      /نظّ?ف\s+(بيانات|البيانات|الملف)/,
      /تنظيف\s+(بيانات|البيانات)/,
      /\bclean\s+(my\s+|the\s+)?data\b/i,
      /القيم\s+المفقودة/,
      /القيم\s+المتطرفة/,
    ],
  },
  {
    intent: 'data.describe',
    patterns: [
      /الإحصاء\s+الوصفي/,
      /إحصاءات?\s+وصفية/,
      /\bdescriptive\s+statistics\b/i,
      /المتوسطات\s+والانحرافات/,
    ],
  },
  {
    intent: 'data.inspect',
    patterns: [
      /افحص\s+(الملف|البيانات)/,
      /اعرض\s+(الأعمدة|البيانات)/,
      /\binspect\s+(the\s+)?(file|data)\b/i,
      /ما\s+هي\s+الأعمدة/,
    ],
  },

  /* ------------------------------- research -------------------------------- */

  {
    intent: 'stats.recommend',
    patterns: [
      /(اختر|اقترح|ما)\s+.{0,20}(التحليل|الاختبار)\s+(المناسب|الأنسب)/,
      /التحليل\s+الإحصائي\s+المناسب/,
      /\bwhich\s+(test|analysis)\b/i,
      /\brecommend\s+(a\s+)?(test|analysis)\b/i,
    ],
  },
  {
    intent: 'research.survey',
    patterns: [
      /(أنشئ|اعمل|صمّ?م)\s+.{0,15}استبانة/,
      /(أنشئ|اعمل|صمّ?م)\s+.{0,15}استبيان/,
      /\b(create|build|design)\s+a\s+(survey|questionnaire)\b/i,
    ],
  },
  {
    intent: 'research.results',
    patterns: [
      /اكتب\s+.{0,20}(فصل\s+)?النتائج/,
      /الفصل\s+الرابع/,
      /\bwrite\s+(the\s+)?results\s+(chapter|section)\b/i,
    ],
  },
  /*
   * Requests for actual studies, matched before the plan rule.
   *
   * "أريد دراسات سابقة عن التعلم التعاوني" and "اكتب لي خطة بحث" both mention
   * research, and only the first can be answered by a database. Getting this
   * wrong in the other direction is the dangerous one: a request for literature
   * routed to a writing agent produces invented citations, which is the single
   * failure this product exists to prevent.
   */
  {
    intent: 'research.literature',
    patterns: [
      /*
       * `ال` is optional and up to three words may sit between the noun and its
       * qualifier.
       *
       * The original patterns required "دراسات" to be followed immediately by
       * "سابقة" or a preposition, which matched the phrasing used to test them
       * and almost nothing a researcher actually writes. "أريد الاطلاع على
       * الدراسات والأبحاث السابقة المتعلقة بالتعلم التعاوني" failed on both
       * counts — the definite article and the words in between — and fell
       * through to the model, which classified it as a request to build a
       * questionnaire.
       *
       * Arabic puts modifiers between a noun and what qualifies it far more
       * often than the tidy phrasings a test author invents. The patterns have
       * to allow for that.
       */
      /(^|\s)(ال)?(دراسات|أبحاث|بحوث)(\s+\S+){0,3}\s+(سابقة|السابقة|عربية|العربية|أجنبية|الأجنبية)/,
      /(^|\s)(ال)?(دراسات|أبحاث|بحوث)(\s+\S+){0,3}\s+(حول|عن|في|المتعلقة|الخاصة|المرتبطة)/,
      /(^|\s)الاطلاع\s+على(\s+\S+){0,3}\s+(ال)?(دراسات|أبحاث|بحوث|مراجع|أدبيات)/,
      /(^|\s)(ابحث|أبحث|اعثر)\s+.{0,20}(دراسات|أبحاث|مراجع|مصادر|أدبيات)/,
      /(^|\s)(الأدب|أدبيات|الأدبيات)\s+(النظري|السابق|المتعلق|حول|عن)/,
      /(^|\s)مراجعة\s+(الأدبيات|أدبيات|الأدب)/,
      /(^|\s)الإطار\s+النظري\s+(عن|حول|في)/,
      /*
       * An adjective may sit between the noun and its preposition — "مراجع
       * عربية عن التعليم" — so up to two words are allowed to intervene. The
       * same shape recurs across these rules and Arabic makes it common.
       */
      /(^|\s)(مراجع|مصادر)(\s+\S+){0,2}\s+(عن|حول|في)/,
      /(^|\s)(مراجع|مصادر)\s+(علمية|أكاديمية|عربية|أجنبية)/,
      /\bliterature\s+review\b/i,
      /\b(find|search\s+for)\s+(studies|papers|research|articles)\b/i,
      /\b(recent|previous|prior)\s+(studies|research|papers)\s+(on|about)\b/i,
      /\bpapers?\s+(on|about)\b/i,
    ],
  },

  {
    intent: 'research.plan',
    patterns: [
      /خطة\s+(بحث|البحث)/,
      /بحث\s+كامل/,
      /مشكلة\s+الدراسة\s+و/,
      /\bresearch\s+(plan|proposal)\b/i,
      /\bfull\s+(paper|research)\b/i,
    ],
  },
];

export interface KeywordMatch {
  intent: IntentKey;
  /** The pattern that matched, for the log — makes routing decisions traceable. */
  matched: string;
}

/**
 * Returns an intent only when the message names one unmistakably.
 *
 * Null means "not sure", and null is a perfectly good answer: the caller falls
 * through to the model, which is what it is for.
 */
/**
 * Whether a message asks *about* a method rather than asking to run one.
 *
 * A statistical term on its own is not a request to compute. "اشرحلي معنى
 * reliability" was routed to a reliability analysis and "بدي أعرف الفرق بين PLS
 * و CB-SEM" to a CB-SEM run, because the rules matched the term and never
 * looked at the sentence around it.
 *
 * That is the wrong failure twice over: the user gets an analysis they did not
 * ask for, and the question they did ask goes unanswered.
 *
 * Checked as a prefix rather than anywhere in the message, because "احسب
 * الثبات ثم اشرح النتيجة" is a request to compute followed by a request to
 * explain — the computation is what was asked for first, and it is what should
 * run.
 */
function asksAboutRatherThanFor(message: string): boolean {
  const opening = message.trim().slice(0, 40);

  /*
   * "ما هو التحليل المناسب لبياناتي" opens like a question and is a request:
   * the researcher wants a test chosen for their data, not a description of
   * tests. The recommender rule already handles it, and this guard would take
   * it away — which it did, until this exception.
   *
   * The signal is the possessive: "لبياناتي", "for my data". Asking which test
   * suits *my* data is asking for a decision about a specific dataset.
   */
  if (
    /(المناسب|الأنسب|should\s+i\s+use)/.test(opening) ||
    /(لبياناتي|بياناتي|my\s+data)/.test(message)
  ) {
    return false;
  }

  /*
   * "ما هي الدراسات السابقة عن X" opens like a question and asks a database for
   * papers. The literature rule handles it, and this guard was taking it away —
   * the same mistake as the recommender above, and for the same reason: an
   * interrogative opening does not make a request into a question.
   */
  if (/(الدراسات|الأبحاث|البحوث|الأدبيات|studies|papers|literature|research\s+on)/.test(message)) {
    return false;
  }

  return (
    /^(اشرح|اشرحلي|وضّ?ح|فسّ?ر|عرّ?ف|ما\s+(هو|هي|معنى|تعريف)|شو\s+يعني|إيش\s+يعني|ايش\s+يعني)/.test(
      opening,
    ) ||
    /^(بدي\s+أ?عرف|أريد\s+أن\s+أعرف|أ?بغى\s+أعرف)/.test(opening) ||
    /^(ما\s+)?الفرق\s+بين/.test(opening) ||
    /^(explain|define|describe|what\s+(is|are|does)|what's|tell\s+me\s+about|difference\s+between)/i.test(
      opening,
    ) ||
    /^(i\s+want\s+to\s+(know|understand)|help\s+me\s+understand)/i.test(opening)
  );
}

export function classifyByKeyword(message: string): KeywordMatch | null {
  const text = message.trim();
  if (text.length === 0) return null;

  /*
   * A question about a method goes to the model, whatever terms it contains.
   *
   * Only specialised rules are skipped — the general rules below still apply,
   * so nothing is lost by deferring.
   */
  const aboutRatherThanFor = asksAboutRatherThanFor(text);

  for (const rule of RULES) {
    if (aboutRatherThanFor && rule.intent !== 'general.question') continue;

    for (const pattern of rule.patterns) {
      const found = text.match(pattern);
      if (found) {
        return { intent: rule.intent, matched: found[0].slice(0, 40) };
      }
    }
  }

  return null;
}

/** Exposed so the tests can assert the ordering rather than infer it. */
export const KEYWORD_RULE_ORDER: IntentKey[] = RULES.map((rule) => rule.intent);
