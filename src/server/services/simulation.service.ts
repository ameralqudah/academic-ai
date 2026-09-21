/**
 * A practice dataset from an uploaded paper.
 *
 * Three stages, and only the first involves a model:
 *
 *   1. **Read.** The paper's statistical passages go to a model that copies out
 *      what is published — and only that. Its reply is normalised and every
 *      number is looked for in the paper's own text (`simulation/spec.ts`).
 *   2. **Generate.** Arithmetic (`analysis/simulate.ts`). Seeded from the paper,
 *      so the same paper gives the same file.
 *   3. **Store, marked.** The dataset row is flagged `simulated`, the file is
 *      named `SIMULATED_…`, every row carries `_simulated = 1`, and the
 *      workbook opens on a sheet that says what it is.
 *
 * **Why the marking is not optional.** A file of invented respondents that
 * reproduces a published study is a legitimate teaching aid and, stripped of
 * its label, exactly what a fabricated dataset looks like. This product is
 * built around not inventing findings on a researcher's behalf; the label is
 * what keeps this feature on the right side of that. There is deliberately no
 * argument, setting or plan tier that produces an unmarked file.
 */

import {
  MAX_SIMULATED_ROWS,
  SIMULATED_PREFIX,
  SimulationError,
  simulateDataset,
  type Assumption,
  type ComparisonRow,
} from '@/analysis/simulate';
import { logger } from '@/lib/logger';
import { requirementsFor } from '@/server/ai/model-requirements';
import { selectModel } from '@/server/ai/model-router';
import { estimateTokens } from '@/server/context/envelope';
import type { Dataset as DatasetRow } from '@/server/db/schema';
import { generateXlsx, type Sheet } from '@/server/generators/spreadsheet';
import { AppError } from '@/server/http/errors';
import { runCompletion } from '@/server/services/ai.service';
import { storeArtifact } from '@/server/services/artifact.service';
import { requireOwned, saveSimulated } from '@/server/services/dataset.service';
import { assertCanUseAI } from '@/server/services/usage.service';
import { SIMULATED_NOTICE } from '@/server/simulation/notice';
import {
  EXTRACTION_PROMPT,
  normaliseSpec,
  statisticalPassages,
  unverifiedValues,
  type NormalisedSpec,
  type UnverifiedValue,
} from '@/server/simulation/spec';

type Locale = 'ar' | 'en';

export { SIMULATED_NOTICE };

export type SimulationOutcome =
  | {
      status: 'needs-input';
      /** What the paper did not say and the generator cannot assume. */
      missing: 'document' | 'n' | 'constructs';
      question: string;
    }
  | {
      status: 'done';
      dataset: DatasetRow;
      artifact: { id: string; filename: string; kind: string; validationStatus: string };
      report: string;
      comparison: ComparisonRow[];
      assumptions: Assumption[];
      unverified: UnverifiedValue[];
      labels: Record<string, string>;
    };

/* -------------------------------------------------------------------------- */
/*                                   Wording                                  */
/* -------------------------------------------------------------------------- */

const ASSUMPTION_TEXT: Record<Assumption['code'], Record<Locale, string>> = {
  'items.assumed': { ar: 'عدد الفقرات غير مذكور؛ افتُرض', en: 'Number of items not stated; assumed' },
  'loadings.assumed': { ar: 'التشبعات غير منشورة؛ افتُرضت', en: 'Loadings not published; assumed' },
  'loadings.fromAlpha': { ar: 'التشبعات غير منشورة؛ اشتُقّت من ألفا كرونباخ', en: 'Loadings not published; derived from Cronbach’s alpha' },
  'mean.assumed': { ar: 'المتوسط غير منشور؛ افتُرض', en: 'Mean not published; assumed' },
  'sd.assumed': { ar: 'الانحراف المعياري غير منشور؛ افتُرض', en: 'Standard deviation not published; assumed' },
  'correlation.assumedZero': { ar: 'الارتباط غير منشور؛ افتُرض صفرًا', en: 'Correlation not published; assumed zero' },
  'correlation.fromPaths': { ar: 'الارتباط غير منشور؛ اشتُقّ من معاملات المسار', en: 'Correlation not published; implied by the path coefficients' },
  'correlation.capped': { ar: 'ارتباط كامن تجاوز الحد بعد تصحيح خطأ القياس؛ قُيِّد عند', en: 'A latent correlation exceeded the limit after correcting for measurement error; capped at' },
  'matrix.shrunk': { ar: 'مصفوفة الارتباط المنشورة غير موجبة التحديد؛ قُلِّصت الارتباطات بنسبة', en: 'The published correlation matrix is not positive definite; correlations shrunk by' },
  'paths.rescaled': { ar: 'معاملات المسار تفسّر أكثر من 90٪ من التباين؛ ضُربت في', en: 'Path coefficients explained over 90% of the variance; multiplied by' },
  'demographics.independent': { ar: 'المتغيرات الديموغرافية وُزّعت بنسبها المنشورة دون أي علاقة ببقية المتغيرات', en: 'Demographics follow their published shares and are unrelated to every other variable' },
};

const STATISTIC_TEXT: Record<ComparisonRow['statistic'] | 'loading', Record<Locale, string>> = {
  n: { ar: 'حجم العينة', en: 'Sample size' },
  mean: { ar: 'المتوسط', en: 'Mean' },
  sd: { ar: 'الانحراف المعياري', en: 'SD' },
  alpha: { ar: 'ألفا كرونباخ', en: 'Cronbach’s alpha' },
  correlation: { ar: 'ارتباط', en: 'Correlation' },
  path: { ar: 'معامل مسار', en: 'Path coefficient' },
  share: { ar: 'نسبة', en: 'Share' },
  loading: { ar: 'تشبع', en: 'Loading' },
};

/* -------------------------------------------------------------------------- */
/*                                   Reading                                  */
/* -------------------------------------------------------------------------- */

function parseJson(reply: string): unknown {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? reply).trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** A seed from the paper, so the same paper always yields the same file. */
function seedFrom(text: string): number {
  let hash = 2166136261;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

async function readPaper(input: {
  userId: string;
  locale: Locale;
  passages: string;
}): Promise<unknown> {
  await assertCanUseAI(input.userId, 1500);

  const provider = (
    await selectModel(
      requirementsFor({ capability: 'data.simulate', contextTokens: estimateTokens(input.passages) }),
    )
  ).provider;

  const result = await runCompletion({
    userId: input.userId,
    projectId: '',
    provider,
    task: 'chat',
    locale: input.locale,
    system: EXTRACTION_PROMPT,
    messages: [{ role: 'user', content: `Text of the paper:\n\n${input.passages}` }],
    maxTokens: 4000,
    /* Transcription. The same paper should be read the same way twice. */
    temperature: 0,
    json: true,
  });

  return parseJson(result.text);
}

/* -------------------------------------------------------------------------- */
/*                                  The file                                  */
/* -------------------------------------------------------------------------- */

function workbookSheets(input: {
  locale: Locale;
  sourceName: string;
  title: string;
  seed: number;
  data: { columns: string[]; rows: (string | number | boolean | null)[][] };
  comparison: ComparisonRow[];
  assumptions: Assumption[];
  unverified: UnverifiedValue[];
  labels: Record<string, string>;
  notes: string[];
}): Sheet[] {
  const { locale } = input;
  const other: Locale = locale === 'ar' ? 'en' : 'ar';
  const unverifiedKeys = new Set(input.unverified.map((entry) => `${entry.statistic}|${entry.subject}`));

  return [
    /*
     * First, so it is what Excel opens on. In both languages regardless of the
     * interface: a file travels further than the conversation that made it.
     */
    {
      name: 'READ ME - SIMULATED',
      headers: [locale === 'ar' ? 'بيانات محاكاة — اقرأ قبل الاستخدام' : 'SIMULATED DATA — READ BEFORE USE'],
      rows: [
        [SIMULATED_NOTICE[locale]],
        [SIMULATED_NOTICE[other]],
        [''],
        [`${locale === 'ar' ? 'البحث المصدر' : 'Source paper'}: ${input.title || input.sourceName}`],
        [`${locale === 'ar' ? 'الملف المصدر' : 'Source file'}: ${input.sourceName}`],
        [`${locale === 'ar' ? 'البذرة (لإعادة التوليد نفسه)' : 'Seed (reproduces this exact file)'}: ${input.seed}`],
        [
          locale === 'ar'
            ? 'العمود ‎_simulated‎ = 1 في كل صف يدل على أن الصف مولَّد. لا تحذفه.'
            : 'The _simulated = 1 column on every row marks the row as generated. Do not remove it.',
        ],
        ...input.notes.map((note) => [`${locale === 'ar' ? 'ملاحظة من قراءة البحث' : 'Note from reading the paper'}: ${note}`]),
      ],
    },
    {
      name: 'Data',
      headers: input.data.columns,
      rows: input.data.rows.map((row) => row.map((cell) => (typeof cell === 'boolean' ? String(cell) : cell))),
    },
    {
      name: locale === 'ar' ? 'المنشور مقابل المحاكى' : 'Published vs simulated',
      headers:
        locale === 'ar'
          ? ['الإحصاءة', 'المتغير', 'المنشور', 'المحاكى', 'الفرق', 'وُجد الرقم في نص البحث؟']
          : ['Statistic', 'Variable', 'Published', 'Simulated', 'Difference', 'Number found in the paper’s text?'],
      rows: input.comparison.map((row) => [
        STATISTIC_TEXT[row.statistic][locale],
        row.subject,
        row.published ?? (locale === 'ar' ? 'غير منشور' : 'not published'),
        row.simulated,
        row.difference ?? '',
        row.published === null || row.statistic === 'share'
          ? ''
          : unverifiedKeys.has(`${row.statistic}|${row.subject}`)
            ? locale === 'ar'
              ? 'لا — راجعه في البحث'
              : 'No — check it against the paper'
            : locale === 'ar'
              ? 'نعم'
              : 'Yes',
      ]),
    },
    {
      name: locale === 'ar' ? 'الافتراضات' : 'Assumptions',
      headers: locale === 'ar' ? ['الافتراض', 'المتغير', 'القيمة'] : ['Assumption', 'Variable', 'Value'],
      rows: input.assumptions.map((entry) => [ASSUMPTION_TEXT[entry.code][locale], entry.subject, entry.value ?? '']),
    },
    {
      name: locale === 'ar' ? 'دليل المتغيرات' : 'Codebook',
      headers: locale === 'ar' ? ['الاسم في الملف', 'الاسم في البحث'] : ['Name in file', 'Name in paper'],
      rows: Object.entries(input.labels).map(([name, label]) => [name, label]),
    },
  ];
}

function reportText(input: {
  locale: Locale;
  n: number;
  constructs: number;
  items: number;
  comparison: ComparisonRow[];
  assumptions: Assumption[];
  unverified: UnverifiedValue[];
  filename: string;
}): string {
  const { locale } = input;

  const compared = input.comparison.filter((row) => row.difference !== null && row.statistic !== 'n');
  const largest = compared.reduce((worst, row) => Math.max(worst, Math.abs(row.difference as number)), 0);

  const worstRow = compared.find((row) => Math.abs(row.difference as number) === largest);

  if (locale === 'ar') {
    return [
      `> **${SIMULATED_NOTICE.ar}**`,
      '',
      `وُلِّد الملف **${input.filename}**: ${input.n} مستجيبًا، ${input.constructs} متغيرات كامنة، ${input.items} فقرة.`,
      '',
      compared.length > 0
        ? `قورنت ${compared.length} إحصاءة منشورة بما يعطيه الملف. أكبر فرق: ${largest.toFixed(3)}${worstRow ? ` (${STATISTIC_TEXT[worstRow.statistic].ar}: ${worstRow.subject})` : ''}. الجدول الكامل في ورقة «المنشور مقابل المحاكى».`
        : 'لم يُعثر في البحث على إحصاءات منشورة يمكن المقارنة بها؛ كل القيم مفترضة.',
      input.assumptions.length > 0
        ? `\nقيم لم ينشرها البحث فافتُرضت أو اشتُقّت: ${input.assumptions.length}. مذكورة واحدةً واحدة في ورقة «الافتراضات».`
        : '',
      input.unverified.length > 0
        ? `\n**للمراجعة:** ${input.unverified.length} رقمًا استُخرج من البحث ولم أجده حرفيًا في نصه (قد يكون السبب جدولًا لم يُقرأ جيدًا من PDF). موسومة في ورقة المقارنة؛ راجعها في البحث قبل الاعتماد على المقارنة.`
        : '',
      '\nالملف محفوظ ضمن ملفاتك بشارة «محاكاة»، ويمكن تحليله هنا مباشرة. أي نص يُكتب عن تحليله سيصرّح بأنه من بيانات محاكاة، ولا يمكن إرفاق تحليلاته بفصول مشروع بحثي.',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  return [
    `> **${SIMULATED_NOTICE.en}**`,
    '',
    `Generated **${input.filename}**: ${input.n} respondents, ${input.constructs} constructs, ${input.items} items.`,
    '',
    compared.length > 0
      ? `${compared.length} published statistics were compared with what the file gives. Largest difference: ${largest.toFixed(3)}${worstRow ? ` (${STATISTIC_TEXT[worstRow.statistic].en}: ${worstRow.subject})` : ''}. The full table is on the “Published vs simulated” sheet.`
      : 'No published statistics were found to compare against; every value is assumed.',
    input.assumptions.length > 0
      ? `\nValues the paper did not publish, assumed or derived: ${input.assumptions.length}. Each is listed on the “Assumptions” sheet.`
      : '',
    input.unverified.length > 0
      ? `\n**To check:** ${input.unverified.length} extracted number(s) could not be found verbatim in the paper’s text (a table that did not survive PDF extraction is the usual cause). They are marked on the comparison sheet; check them against the paper before relying on the comparison.`
      : '',
    '\nThe file is saved with your files under a “Simulated” badge and can be analysed here directly. Anything written about an analysis of it will say it comes from simulated data, and its analyses cannot be attached to the chapters of a research project.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/*                                 Entry point                                */
/* -------------------------------------------------------------------------- */

interface SimulationRequest {
  userId: string;
  /** The uploaded paper. */
  datasetId: string;
  locale: Locale;
  projectId?: string | null;
  conversationId?: string | null;
  /** The researcher's own answer, when the paper's sample size could not be read. */
  n?: number;
  seed?: number;
  /**
   * What the researcher typed when asked — constructs, item counts, values the
   * paper's broken tables hid. Read alongside the paper, but not counted as the
   * paper: a value that came from here is still reported as "not found in the
   * paper's text", because that is true.
   */
  supplement?: string;
}

type PaperChunk = { heading?: string; text: string };

const NEEDS_DOCUMENT: Record<Locale, string> = {
  ar: 'أحتاج إلى البحث نفسه لأقرأ إحصاءاته المنشورة. ارفعه بصيغة PDF (بنص قابل للتحديد، لا صورة ممسوحة) أو Word.',
  en: 'I need the paper itself to read its published statistics. Upload it as a PDF (with selectable text, not a scan) or a Word file.',
};

function chunksOf(paper: DatasetRow): PaperChunk[] {
  const document = (paper.profile as { document?: { chunks?: PaperChunk[] } } | null)?.document;
  return (document?.chunks ?? []).filter((chunk) => typeof chunk?.text === 'string');
}

/**
 * Reads the paper with a model, then builds the file.
 *
 * Split from `simulateFromReading` so that everything after the model call —
 * which is everything that decides what gets stored and how it is marked — can
 * be tested against a real database without a provider key.
 */
export async function simulateFromPaper(input: SimulationRequest): Promise<SimulationOutcome> {
  const paper = await requireOwned(input.datasetId, input.userId);
  const chunks = chunksOf(paper);

  if (chunks.length === 0) {
    return { status: 'needs-input', missing: 'document', question: NEEDS_DOCUMENT[input.locale] };
  }

  const raw = await readPaper({
    userId: input.userId,
    locale: input.locale,
    passages: input.supplement
      ? `${statisticalPassages(chunks)}\n\nDetails supplied by the researcher, to be copied like the paper's own:\n${input.supplement}`
      : statisticalPassages(chunks),
  });

  return simulateFromReading({ ...input, reading: raw });
}

/** Everything after the paper has been read: normalise, generate, store, mark. */
export async function simulateFromReading(
  input: SimulationRequest & { reading: unknown },
): Promise<SimulationOutcome> {
  const paper = await requireOwned(input.datasetId, input.userId);
  const chunks = chunksOf(paper);

  if (chunks.length === 0) {
    return { status: 'needs-input', missing: 'document', question: NEEDS_DOCUMENT[input.locale] };
  }

  const fullText = chunks.map((chunk) => `${chunk.heading ?? ''}\n${chunk.text}`).join('\n\n');
  const raw = input.reading;

  const seed = input.seed ?? seedFrom(paper.checksum ?? fullText.slice(0, 5000));

  const read: NormalisedSpec = normaliseSpec(raw, {
    seed,
    ...(input.n !== undefined ? { n: input.n } : {}),
    maxRows: MAX_SIMULATED_ROWS,
  });

  if (read.problems.some((problem) => problem.code === 'constructs.missing')) {
    return {
      status: 'needs-input',
      missing: 'constructs',
      question:
        input.locale === 'ar'
          ? 'لم أجد في نص البحث متغيرات بإحصاءات منشورة (متوسطات، ألفا، ارتباطات، معاملات مسار). قد تكون الجداول صورًا. اكتب لي المتغيرات وعدد فقرات كل منها وما نُشر عنها، أو ارفع نسخة نصية من البحث.'
          : 'I could not find constructs with published statistics (means, alpha, correlations, path coefficients) in the paper’s text. The tables may be images. Tell me the constructs, their item counts and what was published for them, or upload a text version of the paper.',
    };
  }

  if (read.problems.some((problem) => problem.code === 'n.missing')) {
    return {
      status: 'needs-input',
      missing: 'n',
      question:
        input.locale === 'ar'
          ? 'لم أجد حجم العينة في نص البحث، ولن أفترضه. كم عدد المستجيبين في الدراسة؟'
          : 'I could not find the sample size in the paper’s text, and I will not assume one. How many respondents did the study have?',
    };
  }

  let result;
  try {
    result = simulateDataset(read.spec, `${SIMULATED_PREFIX}${paper.originalName}`);
  } catch (error) {
    if (error instanceof SimulationError) {
      logger.warn('simulation.rejected', { code: error.code, ...error.params });

      throw new AppError(
        'VALIDATION',
        `The statistics read from the paper cannot be simulated (${error.code}).`,
        `تعذّرت محاكاة الإحصاءات المقروءة من البحث (${error.code}).`,
      );
    }

    throw error;
  }

  /* A researcher's typed sample size is not in the paper, and is not expected to be. */
  const unverified = unverifiedValues(read.spec, fullText).filter(
    (entry) => !(entry.statistic === 'n' && input.n !== undefined),
  );

  const assumptions: Assumption[] = [
    ...read.problems
      .filter((problem) => problem.code === 'items.assumed')
      .map((problem) => ({ code: 'items.assumed' as const, subject: problem.subject ?? '', value: 3 })),
    ...result.assumptions,
  ];

  const dataset = await saveSimulated({
    userId: input.userId,
    data: result.dataset,
    sourceName: paper.originalName,
    sourceDatasetId: paper.id,
    seed,
    projectId: input.projectId ?? paper.projectId,
    conversationId: input.conversationId ?? paper.conversationId,
  });

  const filename = dataset.originalName.replace(/\.csv$/i, '.xlsx');

  const bytes = await generateXlsx(
    workbookSheets({
      locale: input.locale,
      sourceName: paper.originalName,
      title: read.title,
      seed,
      data: result.dataset,
      comparison: result.comparison,
      assumptions,
      unverified,
      labels: read.labels,
      notes: read.notes,
    }),
  );

  const artifact = await storeArtifact({
    userId: input.userId,
    kind: 'xlsx',
    filename,
    bytes,
    projectId: input.projectId ?? null,
    conversationId: input.conversationId ?? null,
    metadata: { simulated: true, datasetId: dataset.id, sourceDatasetId: paper.id, seed },
  });

  logger.info('simulation.done', {
    datasetId: dataset.id,
    rows: result.dataset.rows.length,
    assumptions: assumptions.length,
    unverified: unverified.length,
  });

  return {
    status: 'done',
    dataset,
    artifact: {
      id: artifact.id,
      filename: artifact.filename,
      kind: artifact.kind,
      validationStatus: artifact.validationStatus,
    },
    report: reportText({
      locale: input.locale,
      n: result.dataset.rows.length,
      constructs: read.spec.constructs.length,
      items: read.spec.constructs.reduce((sum, construct) => sum + construct.items, 0),
      comparison: result.comparison,
      assumptions,
      unverified,
      filename,
    }),
    comparison: result.comparison,
    assumptions,
    unverified,
    labels: read.labels,
  };
}
