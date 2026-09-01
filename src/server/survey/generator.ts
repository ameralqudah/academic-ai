/**
 * Generating a measurement instrument.
 *
 * A researcher who needs a questionnaire has a construct in mind and a
 * literature they half-remember. What they usually produce is a list of
 * questions that sound reasonable and fail reliability analysis — because
 * writing items that measure one thing consistently is a skill, and the rules
 * are specific enough to state.
 *
 * **This does not invent a validated scale.** A validated instrument is one that
 * has been administered, factor-analysed and published; nothing generated here
 * has been. What it produces is a draft written to the rules that make items
 * work, for a researcher to refine and pilot — and the output says so, in both
 * languages, because a student who submits generated items as a validated
 * instrument has been failed by the tool.
 *
 * The rules the prompt enforces are the ones that actually cause failures:
 *
 * - **One idea per item.** "The training was useful and enjoyable" cannot be
 *   answered by someone who found it useful and dull, and their answer means
 *   nothing either way.
 * - **No leading wording.** "How much did you enjoy the excellent training?"
 *   measures compliance.
 * - **Reverse items, but marked.** They catch inattentive responding, and an
 *   unmarked one destroys reliability when nobody recodes it — which is the
 *   single most common defect in the questionnaire data this product sees.
 * - **Language matched to respondents**, not to the researcher's reading level.
 * - **A consistent scale**, because mixing agreement and frequency in one
 *   construct makes the sum meaningless.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*                                   Shape                                    */
/* -------------------------------------------------------------------------- */

export const scaleTypeSchema = z.enum([
  /** Strongly disagree → strongly agree. The default for attitudes. */
  'likert-agreement',
  /** Never → always. For behaviour, where agreement makes no sense. */
  'likert-frequency',
  /** Not at all → to a very great extent. For degree. */
  'likert-extent',
  /** Very poor → excellent. For evaluation. */
  'likert-quality',
]);

export type ScaleType = z.infer<typeof scaleTypeSchema>;

export const surveyRequestSchema = z.object({
  /** What the instrument is about, in the researcher's words. */
  topic: z.string().min(5).max(300),
  /**
   * The constructs to measure, each becoming a subscale.
   *
   * Asked for explicitly rather than inferred from the topic: which constructs
   * a study measures is the study's design, and a generator that decides for
   * the researcher is designing their research.
   */
  constructs: z
    .array(
      z.object({
        name: z.string().min(2).max(80),
        /** What it means here — two researchers use one word differently. */
        definition: z.string().max(400).optional(),
      }),
    )
    .min(1)
    .max(8),
  itemsPerConstruct: z.number().int().min(3).max(10).default(4),
  scaleType: scaleTypeSchema.default('likert-agreement'),
  points: z.union([z.literal(5), z.literal(7)]).default(5),
  /** Who answers — wording follows them, not the researcher. */
  audience: z.string().max(200).optional(),
  locale: z.enum(['ar', 'en']).default('en'),
  /** Reverse-worded items, to catch inattentive responding. */
  includeReversed: z.boolean().default(true),
  /** Age, gender, experience and so on, as a separate section. */
  includeDemographics: z.boolean().default(true),
});

export type SurveyRequest = z.infer<typeof surveyRequestSchema>;

export interface SurveyItem {
  /** `SAT1` — stable, and what the researcher will name the column. */
  code: string;
  construct: string;
  text: string;
  /** Marked so it is recoded before analysis. Unmarked reversals wreck alpha. */
  reversed: boolean;
}

export interface DemographicItem {
  code: string;
  text: string;
  type: 'single-choice' | 'number' | 'text';
  options?: string[];
}

export interface GeneratedSurvey {
  title: string;
  /** What respondents read first: purpose, anonymity, how long it takes. */
  introduction: string;
  scale: { type: ScaleType; points: number; labels: string[] };
  constructs: { name: string; definition?: string; items: SurveyItem[] }[];
  demographics: DemographicItem[];
  /**
   * What the researcher must do before using it.
   *
   * Not a disclaimer to be skimmed: it names the specific steps — pilot,
   * expert review, reliability check — that turn a draft into an instrument.
   */
  beforeUse: string[];
  /** Which codes are reverse-worded, gathered for the analysis stage. */
  reversedCodes: string[];
}

/* -------------------------------------------------------------------------- */
/*                                  Scales                                    */
/* -------------------------------------------------------------------------- */

/**
 * Response labels for each scale type, in both languages.
 *
 * Written out rather than generated, because the conventional Arabic wording of
 * a Likert scale is not a translation of the English — "لا أوافق بشدة" is the
 * established form, and a literal rendering reads as awkward to a respondent
 * and depresses response quality.
 */
const SCALE_LABELS: Record<ScaleType, { en: Record<5 | 7, string[]>; ar: Record<5 | 7, string[]> }> = {
  'likert-agreement': {
    en: {
      5: ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'],
      7: [
        'Strongly disagree',
        'Disagree',
        'Somewhat disagree',
        'Neutral',
        'Somewhat agree',
        'Agree',
        'Strongly agree',
      ],
    },
    ar: {
      5: ['لا أوافق بشدة', 'لا أوافق', 'محايد', 'أوافق', 'أوافق بشدة'],
      7: [
        'لا أوافق بشدة',
        'لا أوافق',
        'لا أوافق نوعًا ما',
        'محايد',
        'أوافق نوعًا ما',
        'أوافق',
        'أوافق بشدة',
      ],
    },
  },
  'likert-frequency': {
    en: {
      5: ['Never', 'Rarely', 'Sometimes', 'Often', 'Always'],
      7: ['Never', 'Very rarely', 'Rarely', 'Sometimes', 'Often', 'Very often', 'Always'],
    },
    ar: {
      5: ['أبدًا', 'نادرًا', 'أحيانًا', 'غالبًا', 'دائمًا'],
      7: ['أبدًا', 'نادرًا جدًا', 'نادرًا', 'أحيانًا', 'غالبًا', 'غالبًا جدًا', 'دائمًا'],
    },
  },
  'likert-extent': {
    en: {
      5: ['Not at all', 'To a small extent', 'To a moderate extent', 'To a large extent', 'To a very large extent'],
      7: [
        'Not at all',
        'To a very small extent',
        'To a small extent',
        'To a moderate extent',
        'To a large extent',
        'To a very large extent',
        'Completely',
      ],
    },
    ar: {
      5: ['لا شيء', 'بدرجة قليلة', 'بدرجة متوسطة', 'بدرجة كبيرة', 'بدرجة كبيرة جدًا'],
      7: [
        'لا شيء',
        'بدرجة قليلة جدًا',
        'بدرجة قليلة',
        'بدرجة متوسطة',
        'بدرجة كبيرة',
        'بدرجة كبيرة جدًا',
        'بدرجة تامة',
      ],
    },
  },
  'likert-quality': {
    en: {
      5: ['Very poor', 'Poor', 'Acceptable', 'Good', 'Excellent'],
      7: ['Very poor', 'Poor', 'Below average', 'Average', 'Above average', 'Good', 'Excellent'],
    },
    ar: {
      5: ['ضعيف جدًا', 'ضعيف', 'مقبول', 'جيد', 'ممتاز'],
      7: ['ضعيف جدًا', 'ضعيف', 'دون المتوسط', 'متوسط', 'فوق المتوسط', 'جيد', 'ممتاز'],
    },
  },
};

export function scaleLabels(type: ScaleType, points: 5 | 7, locale: 'ar' | 'en'): string[] {
  return SCALE_LABELS[type][locale][points];
}

/* -------------------------------------------------------------------------- */
/*                                  Prompt                                    */
/* -------------------------------------------------------------------------- */

/**
 * The instruction, which is where the measurement knowledge lives.
 *
 * Every rule here corresponds to a failure seen in real questionnaire data.
 * They are stated as constraints rather than advice because a model given
 * advice follows it sometimes.
 */
export function buildSurveyPrompt(request: SurveyRequest): string {
  const reverseRule = request.includeReversed
    ? request.locale === 'ar'
      ? `- اجعل بندًا واحدًا في كل مقياس فرعي معكوس الصياغة، وضع "REVERSED" في حقله. البنود المعكوسة تكشف الإجابة غير المتمعّنة، لكن بندًا معكوسًا غير مُعلَّم يُفسد حساب الثبات لأن أحدًا لن يعيد ترميزه.`
      : `- Make exactly one item per subscale reverse-worded, and set its "reversed" field to true. Reverse items catch inattentive responding, but an unmarked one wrecks the reliability analysis because nobody recodes it.`
    : request.locale === 'ar'
      ? '- لا تكتب بنودًا معكوسة الصياغة.'
      : '- Do not write any reverse-worded items.';

  const audience = request.audience
    ? request.locale === 'ar'
      ? `- المستجيبون: ${request.audience}. اكتب بمستوى لغتهم لا بمستوى الباحث.`
      : `- Respondents: ${request.audience}. Write at their reading level, not the researcher's.`
    : '';

  if (request.locale === 'ar') {
    return `أنت متخصّص في بناء أدوات القياس. اكتب بنود استبانة بالعربية الفصحى.

الموضوع: ${request.topic}

المقاييس الفرعية المطلوبة:
${request.constructs.map((construct) => `- ${construct.name}${construct.definition ? `: ${construct.definition}` : ''}`).join('\n')}

القواعد الملزمة:
- ${request.itemsPerConstruct} بنود لكل مقياس فرعي، لا أكثر ولا أقل.
- كل بند يقيس فكرة واحدة. "التدريب كان مفيدًا وممتعًا" بندان لا بند، ومن وجده مفيدًا وغير ممتع لا يستطيع الإجابة.
- لا صياغة موجِّهة. "إلى أي مدى استفدت من التدريب الممتاز؟" تقيس المجاملة لا الاستفادة.
- لا نفي مزدوج، ولا مصطلحات تقنية إلا إذا كان المستجيبون متخصّصين.
- كل البنود تُجاب على المقياس نفسه؛ لا تخلط الموافقة بالتكرار.
${reverseRule}
${audience}

أعد JSON فقط، بلا شرح وبلا أسوار Markdown:
{"title":"عنوان الاستبانة","introduction":"فقرة تعريفية للمستجيب تذكر الغرض والسرية والزمن التقريبي","constructs":[{"name":"اسم المقياس","items":[{"text":"نص البند","reversed":false}]}]}`;
  }

  return `You write measurement instruments. Produce questionnaire items in clear English.

Topic: ${request.topic}

Subscales required:
${request.constructs.map((construct) => `- ${construct.name}${construct.definition ? `: ${construct.definition}` : ''}`).join('\n')}

Binding rules:
- Exactly ${request.itemsPerConstruct} items per subscale, no more and no fewer.
- One idea per item. "The training was useful and enjoyable" is two items, and someone who found it useful and dull cannot answer it.
- No leading wording. "How much did you benefit from the excellent training?" measures compliance.
- No double negatives, and no technical terms unless the respondents are specialists.
- Every item answers on the same scale; do not mix agreement with frequency.
${reverseRule}
${audience}

Return JSON only, with no explanation and no markdown fence:
{"title":"Instrument title","introduction":"A short paragraph for respondents stating purpose, confidentiality and approximate time","constructs":[{"name":"Subscale name","items":[{"text":"Item text","reversed":false}]}]}`;
}

/* -------------------------------------------------------------------------- */
/*                                  Parsing                                   */
/* -------------------------------------------------------------------------- */

const generatedSchema = z.object({
  title: z.string().min(1).max(200),
  introduction: z.string().min(1).max(2000),
  constructs: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        items: z
          .array(z.object({ text: z.string().min(5).max(400), reversed: z.boolean().default(false) }))
          .min(1),
      }),
    )
    .min(1),
});

/**
 * Turns the model's reply into an instrument.
 *
 * Tolerant of a fence and surrounding prose, because a model told to return
 * only JSON occasionally returns JSON with an explanation. Not tolerant of a
 * wrong shape: a construct the researcher did not ask for, or a missing one,
 * means the reply was not followed, and quietly accepting it would hand back an
 * instrument measuring something else.
 */
export function parseGeneratedSurvey(
  reply: string,
  request: SurveyRequest,
): GeneratedSurvey | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? reply).trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }

  const parsed = generatedSchema.safeParse(raw);
  if (!parsed.success) return null;

  /*
   * The constructs must be the ones asked for. A model that renames or invents
   * one has misread the request, and returning its version would give the
   * researcher an instrument for a study they are not running.
   */
  const requested = new Set(request.constructs.map((construct) => construct.name));
  const returned = new Set(parsed.data.constructs.map((construct) => construct.name));

  for (const name of requested) {
    if (!returned.has(name)) return null;
  }

  const prefixes = new Map<string, string>();
  const constructs: GeneratedSurvey['constructs'] = [];
  const reversedCodes: string[] = [];

  for (const construct of parsed.data.constructs) {
    if (!requested.has(construct.name)) continue;

    const prefix = uniquePrefix(construct.name, prefixes);
    prefixes.set(construct.name, prefix);

    const definition = request.constructs.find(
      (entry) => entry.name === construct.name,
    )?.definition;

    /*
     * Trimmed to the requested count. A model asked for four items sometimes
     * returns five; taking the first four is better than returning a subscale
     * whose length does not match the rest, since unequal subscales complicate
     * every comparison the researcher will make.
     */
    const items = construct.items.slice(0, request.itemsPerConstruct).map((item, index) => {
      const code = `${prefix}${index + 1}`;
      if (item.reversed) reversedCodes.push(code);

      return {
        code,
        construct: construct.name,
        text: item.text.trim(),
        reversed: item.reversed,
      };
    });

    constructs.push({ name: construct.name, definition, items });
  }

  /* A subscale short of the requested count is not usable as specified. */
  if (constructs.some((construct) => construct.items.length < request.itemsPerConstruct)) {
    return null;
  }

  return {
    title: parsed.data.title.trim(),
    introduction: parsed.data.introduction.trim(),
    scale: {
      type: request.scaleType,
      points: request.points,
      labels: scaleLabels(request.scaleType, request.points, request.locale),
    },
    constructs,
    demographics: request.includeDemographics ? demographics(request.locale) : [],
    beforeUse: beforeUse(request.locale),
    reversedCodes,
  };
}

/**
 * An item code prefix from the construct's name.
 *
 * Three letters and a number — `SAT1`, `SAT2` — which is the convention every
 * export uses and which the PLS builder's indicator matching already
 * recognises. A researcher who generates an instrument here and analyses the
 * responses later gets automatic construct matching for free.
 */
function uniquePrefix(name: string, taken: Map<string, string>): string {
  const letters = name
    .replace(/[^\p{L}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean);

  const base =
    letters.length > 1
      ? letters
          .slice(0, 3)
          .map((word) => word[0] ?? '')
          .join('')
          .toUpperCase()
      : (letters[0] ?? 'Q').slice(0, 3).toUpperCase();

  const used = new Set(taken.values());
  if (!used.has(base)) return base;

  for (let suffix = 2; suffix < 20; suffix += 1) {
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }

  return `${base}X`;
}

/**
 * Demographic questions.
 *
 * Fixed rather than generated: the same handful appear in almost every study,
 * a model would produce them differently each time, and consistent wording
 * makes results comparable across a researcher's own instruments.
 *
 * Gender is a single choice with a "prefer not to say" option, which is both
 * ordinary research practice and the ethical minimum.
 */
function demographics(locale: 'ar' | 'en'): DemographicItem[] {
  if (locale === 'ar') {
    return [
      { code: 'D1', text: 'الجنس', type: 'single-choice', options: ['ذكر', 'أنثى', 'أفضّل عدم الإفصاح'] },
      { code: 'D2', text: 'العمر (بالسنوات)', type: 'number' },
      {
        code: 'D3',
        text: 'أعلى مؤهّل علمي',
        type: 'single-choice',
        options: ['ثانوية عامة أو أقل', 'دبلوم', 'بكالوريوس', 'ماجستير', 'دكتوراه'],
      },
      {
        code: 'D4',
        text: 'سنوات الخبرة',
        type: 'single-choice',
        options: ['أقل من سنة', '1–5 سنوات', '6–10 سنوات', '11–15 سنة', 'أكثر من 15 سنة'],
      },
    ];
  }

  return [
    { code: 'D1', text: 'Gender', type: 'single-choice', options: ['Male', 'Female', 'Prefer not to say'] },
    { code: 'D2', text: 'Age (in years)', type: 'number' },
    {
      code: 'D3',
      text: 'Highest qualification',
      type: 'single-choice',
      options: ['Secondary or below', 'Diploma', 'Bachelor', 'Master', 'Doctorate'],
    },
    {
      code: 'D4',
      text: 'Years of experience',
      type: 'single-choice',
      options: ['Under 1 year', '1–5 years', '6–10 years', '11–15 years', 'Over 15 years'],
    },
  ];
}

/**
 * What must happen before this is administered.
 *
 * Specific steps rather than a disclaimer, because "this is a draft" is read as
 * boilerplate and skipped. Naming expert review, piloting and a reliability
 * check tells a researcher what the remaining work actually is — and a student
 * who submits generated items as a validated instrument has been failed by the
 * tool that produced them.
 */
function beforeUse(locale: 'ar' | 'en'): string[] {
  if (locale === 'ar') {
    return [
      'هذه بنود مقترحة وليست أداة مُقنَّنة. الأداة المُقنَّنة هي ما طُبِّق وحُلِّل عامليًا ونُشر، ولم يحدث ذلك لهذه البنود.',
      'اعرضها على محكّمين مختصّين في المجال للتحقّق من صدق المحتوى، وعدّل بناءً على ملاحظاتهم.',
      'طبّقها على عينة استطلاعية (٣٠ مستجيبًا على الأقل) قبل الجمع الفعلي.',
      'احسب ألفا كرونباخ لكل مقياس فرعي؛ ما دون 0.70 يحتاج مراجعة البنود.',
      'أعد ترميز البنود المعكوسة قبل أي تحليل، وإلا انهار الثبات لسبب تحريري يبدو إحصائيًا.',
      'راجع صياغة البنود مع ناطق بلغة المستجيبين إن كانت غير لغتك.',
    ];
  }

  return [
    'These are draft items, not a validated instrument. A validated instrument is one that has been administered, factor-analysed and published; these have not been.',
    'Have subject-matter experts review them for content validity, and revise on their feedback.',
    'Pilot with at least 30 respondents before collecting real data.',
    "Compute Cronbach's alpha per subscale; below 0.70 needs the items reviewed.",
    'Recode the reverse-worded items before any analysis, or reliability collapses for an editorial reason that looks statistical.',
    "Have a native speaker check the wording if it is not your respondents' first language.",
  ];
}
