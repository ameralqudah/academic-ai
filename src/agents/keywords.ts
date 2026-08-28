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

  {
    intent: 'stats.plsSem',
    patterns: [
      /\bpls[\s-]?sem\b/i,
      /\bsmart\s?pls\b/i,
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
      /\bتنبؤ\b/,
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
      /اختبار\s?ت\b/,
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
export function classifyByKeyword(message: string): KeywordMatch | null {
  const text = message.trim();
  if (text.length === 0) return null;

  for (const rule of RULES) {
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
