/**
 * An analysis asked for in words, run on the conversation's data.
 *
 * The one path for "describe my data", "compare satisfaction between men and
 * women", "is my scale reliable" and "which test should I use" — whichever
 * entry point the request arrived through. It was the analysis agent's alone,
 * behind its own mode, and even there the researcher had to assign roles in a
 * form after naming them in the sentence.
 *
 * Nothing here computes a statistic. The engines do; this decides which one,
 * on which columns, from the request and the profile — and when it cannot
 * decide, it says what it found and asks one question.
 */

import { numericColumns } from '@/analysis/numeric-columns';
import { planCleaning } from '@/analysis';
import { descriptiveTables } from '@/analysis/descriptives';
import { inferRoles, isGrouping, isQuantitative, itemGroups, type AnalysisIntent } from '@/analysis/infer-roles';
import { constructsFromItems, pathsFromText } from '@/analysis/measurement';
import type { RoleAssignment } from '@/analysis/inference/recommend';
import type { ColumnProfile, DatasetProfile } from '@/analysis/types';

import { chooseTestFor, columnsFor } from './analysis-choice';
import { chartsFor } from '@/server/charts/plots';

import { asksForCharts, asksForEverything, columnsNamedIn } from './data-requests';
import { loadForAnalysis } from './dataset.service';
import { runCbSem, runPls } from './pls.service';
import { runAnalysis } from './statistics.service';

export type DisplayKind =
  | 'profile'
  | 'descriptives'
  | 'note'
  | 'cleaning'
  | 'recommendation'
  | 'analysis'
  | 'reliability'
  | 'charts'
  | 'pls'
  | 'cbsem';

export interface AnalysisDisplay {
  kind: DisplayKind;
  payload: Record<string, unknown>;
  runId?: string;
}

export type DataAnalysisOutcome =
  | { status: 'done'; displays: AnalysisDisplay[]; roles?: RoleAssignment[]; test?: string }
  | { status: 'question'; question: string; displays: AnalysisDisplay[] };

export { columnsNamedIn, isDataIntent } from './data-requests';

function describeColumn(column: ColumnProfile, language: 'ar' | 'en'): string {
  const levels = (column.categories ?? []).slice(0, 4).map((category) => String(category.value));
  const kind =
    column.type === 'binary' || (column.type === 'categorical' && column.distinct <= 12)
      ? language === 'ar'
        ? `فئات: ${levels.join('، ')}`
        : `groups: ${levels.join(', ')}`
      : column.type === 'likert'
        ? language === 'ar'
          ? 'مقياس ليكرت'
          : 'Likert'
        : column.type === 'numeric' || column.type === 'integer'
          ? language === 'ar'
            ? 'رقمي'
            : 'numeric'
          : column.type;
  return `${column.name} (${kind})`;
}

function listColumns(columns: ColumnProfile[], language: 'ar' | 'en'): string {
  const shown = columns.slice(0, 20).map((column) => describeColumn(column, language));
  const more = columns.length > 20 ? (language === 'ar' ? ` و${columns.length - 20} غيرها` : ` and ${columns.length - 20} more`) : '';
  return shown.join(language === 'ar' ? '، ' : ', ') + more;
}

/** The one question to ask, naming what was found. */
function questionFor(
  missing: 'variables' | 'outcome' | 'grouping' | 'items',
  candidates: ColumnProfile[],
  intent: string,
  language: 'ar' | 'en',
): string {
  const found = listColumns(candidates, language);

  if (language === 'ar') {
    const ask =
      missing === 'items'
        ? 'أي فقرات تنتمي إلى المقياس الذي تريد حساب ثباته؟'
        : missing === 'outcome'
          ? 'أي متغيّر هو التابع (الرقمي) الذي تريد مقارنته؟'
          : missing === 'grouping'
            ? 'أي متغيّر يحدد المجموعات التي تريد المقارنة بينها؟'
            : intent === 'stats.recommend' || intent === 'data.describe'
              ? 'أي علاقة أو مقارنة تريد فحصها؟ مثلًا: «قارن الرضا بين الذكور والإناث» أو «العلاقة بين الرضا والأداء».'
              : 'أي متغيّرات تقصد؟';
    return `وجدت في الملف هذه المتغيّرات: ${found}.\n${ask}`;
  }

  const ask =
    missing === 'items'
      ? 'Which items belong to the scale whose reliability you want?'
      : missing === 'outcome'
        ? 'Which variable is the numeric outcome you want to compare?'
        : missing === 'grouping'
          ? 'Which variable defines the groups to compare?'
          : intent === 'stats.recommend' || intent === 'data.describe'
            ? 'Which relationship or comparison do you want to examine? For example: "compare satisfaction between men and women" or "the relationship between satisfaction and performance".'
            : 'Which variables do you mean?';
  return `The file contains these variables: ${found}.\n${ask}`;
}

export async function analyseDataRequest(input: {
  userId: string;
  datasetId: string | null;
  intent: string;
  /** The request, with any answers the researcher has since given. */
  message: string;
  mentioned: string[];
  roles?: RoleAssignment[];
  language: 'ar' | 'en';
  conversationId?: string | null;
  projectId?: string | null;
}): Promise<DataAnalysisOutcome> {
  if (!input.datasetId) {
    return {
      status: 'question',
      displays: [],
      question:
        input.language === 'ar'
          ? 'لا يوجد ملف بيانات في هذه المحادثة. ارفع ملف Excel أو CSV من زر المرفقات، ثم أعد طلبك.'
          : 'There is no data file in this conversation. Attach an Excel or CSV file, then ask again.',
    };
  }

  const loaded = await loadForAnalysis(input.datasetId, input.userId);
  const profile = loaded.profile;
  const profileDisplay: AnalysisDisplay = { kind: 'profile', payload: profile as unknown as Record<string, unknown> };

  if (input.intent === 'data.inspect' || input.intent === 'data.describe') {
    const tables: AnalysisDisplay = {
      kind: 'descriptives',
      payload: descriptiveTables(profile) as unknown as Record<string, unknown>,
    };
    const figures = asksForCharts(input.message)
      ? [
          {
            kind: 'charts' as const,
            payload: {
              items: chartsFor(profile, { language: input.language, values: numbersByColumn(loaded) }),
            },
          },
        ]
      : [];

    if (!asksForEverything(input.message)) return { status: 'done', displays: [tables, ...figures] };
    return { status: 'done', displays: [tables, ...figures, ...(await everythingElse(input, profile))] };
  }

  if (input.intent === 'stats.cbSem' || input.intent === 'stats.plsSem') {
    return structuralModel(input, profile);
  }

  if (input.intent === 'data.clean') {
    return {
      status: 'done',
      displays: [profileDisplay, { kind: 'cleaning', payload: { proposals: planCleaning(profile) } }],
    };
  }

  const mentioned = [...new Set([...input.mentioned, ...columnsNamedIn(input.message, profile)])];

  const inferred = input.roles?.length
    ? { roles: input.roles }
    : inferRoles({ intent: input.intent as AnalysisIntent, message: input.message, mentioned, profile });

  if ('missing' in inferred) {
    return {
      status: 'question',
      /* The profile is shown with the question, so the answer can be read off it. */
      displays: [profileDisplay],
      question: questionFor(inferred.missing, inferred.candidates, input.intent, input.language),
    };
  }

  const common = {
    datasetId: input.datasetId,
    userId: input.userId,
    projectId: input.projectId ?? null,
    conversationId: input.conversationId ?? null,
  };

  if (input.intent === 'stats.reliability') {
    const outcome = await runAnalysis({
      ...common,
      test: 'reliability.cronbachAlpha',
      columns: { items: inferred.roles.map((role) => role.column) },
    });
    return {
      status: 'done',
      roles: inferred.roles,
      test: 'reliability.cronbachAlpha',
      displays: [{ kind: 'reliability', payload: outcome.result as Record<string, unknown>, runId: outcome.run.id }],
    };
  }

  const choice = chooseTestFor(profile, inferred.roles, input.intent);
  const recommendationDisplay: AnalysisDisplay = {
    kind: 'recommendation',
    payload: choice.recommendation as unknown as Record<string, unknown>,
  };

  if (!choice.test) {
    const blockers = choice.recommendation.blockers.map((blocker) => blocker.code).join(', ');
    const named = choice.recommendation.candidates.find(
      (candidate) => !candidate.available && candidate.confidence === 'recommended',
    );
    return {
      status: 'question',
      displays: [recommendationDisplay],
      question:
        input.language === 'ar'
          ? named
            ? `الاختبار المناسب لهذه المتغيّرات هو ${named.test}، وهو غير متاح بعد. هل تريد تحليلًا بديلًا؟`
            : `لا يوجد اختبار مناسب لهذه المتغيّرات بأدوارها الحالية (${blockers || 'بلا سبب محدد'}). هل تريد اختيار متغيّرات أخرى؟`
          : named
            ? `The test that fits these variables is ${named.test}, which is not available yet. Would you like an alternative?`
            : `No test fits these variables in these roles (${blockers || 'no specific reason'}). Would you like to pick other variables?`,
    };
  }

  const outcome = await runAnalysis({ ...common, test: choice.test, columns: columnsFor(choice.test, inferred.roles) });

  return {
    status: 'done',
    roles: inferred.roles,
    test: choice.test,
    displays: [
      recommendationDisplay,
      { kind: 'analysis', payload: outcome.result as Record<string, unknown>, runId: outcome.run.id },
    ],
  };
}

/** Every numeric column's values, for the figures that need the raw numbers. */
function numbersByColumn(loaded: { data: { columns: string[]; rows: unknown[][] } }): Map<string, number[]> {
  return numericColumns(loaded.data);
}

/**
 * The rest of "analyse it all": the reliability of every scale in the file,
 * and what can be tested next — said plainly, including when nothing can.
 */
async function everythingElse(
  input: { userId: string; datasetId: string | null; language: 'ar' | 'en'; conversationId?: string | null; projectId?: string | null },
  profile: DatasetProfile,
): Promise<AnalysisDisplay[]> {
  const displays: AnalysisDisplay[] = [];
  const ar = input.language === 'ar';

  for (const group of itemGroups(profile).filter((items) => items.length >= 3)) {
    try {
      const outcome = await runAnalysis({
        datasetId: input.datasetId as string,
        userId: input.userId,
        projectId: input.projectId ?? null,
        conversationId: input.conversationId ?? null,
        test: 'reliability.cronbachAlpha',
        columns: { items: group.map((column) => column.name) },
      });
      displays.push({ kind: 'reliability', payload: outcome.result as Record<string, unknown>, runId: outcome.run.id });
    } catch {
      /* A scale the engine cannot assess is left out rather than reported wrongly. */
    }
  }

  const numbers = profile.columns.filter(isQuantitative);
  const groups = profile.columns.filter(isGrouping);
  const scales = constructsFromItems(profile);
  const next: string[] = [];

  if (numbers.length === 0) {
    next.push(
      ar
        ? 'الملف لا يحتوي على متغيّرات كمية أو مقاييس، لذلك لا تنطبق عليه اختبارات استدلالية (t أو ANOVA أو الانحدار). الجداول أعلاه هي التحليل المناسب له.'
        : 'The file has no quantitative variables or scales, so inferential tests (t, ANOVA, regression) do not apply. The tables above are the analysis it supports.',
    );
  } else {
    if (groups.length > 0) {
      next.push(
        ar
          ? `مقارنة المجموعات: اكتب مثلًا «قارن ${numbers[0]?.name} بين ${groups[0]?.name}».`
          : `Group comparison: write, for example, "compare ${numbers[0]?.name} by ${groups[0]?.name}".`,
      );
    }
    if (numbers.length >= 2) {
      next.push(
        ar
          ? `العلاقات: «العلاقة بين ${numbers[0]?.name} و${numbers[1]?.name}»، أو التنبؤ: «هل ${numbers[0]?.name} يتنبأ بـ ${numbers[1]?.name}».`
          : `Relationships: "relationship between ${numbers[0]?.name} and ${numbers[1]?.name}", or prediction: "does ${numbers[0]?.name} predict ${numbers[1]?.name}".`,
      );
    }
    if (scales.length >= 2) {
      next.push(
        ar
          ? `نمذجة المعادلات البنائية: وجدت ${scales.length} مقاييس (${scales.map((scale) => scale.name).join('، ')}). اكتب «حلل AMOS» للتحليل العاملي التوكيدي، أو «حلل SmartPLS» مع المسارات.`
          : `Structural equation modelling: ${scales.length} scales found (${scales.map((scale) => scale.name).join(', ')}). Write "analyse with AMOS" for a confirmatory factor analysis, or "SmartPLS" with the paths.`,
      );
    }
  }

  displays.push({ kind: 'note', payload: { title: ar ? 'الخطوة التالية' : 'Next', lines: next } });
  return displays;
}

/**
 * AMOS or SmartPLS: the measurement model from the item names, the paths from
 * the researcher's words, and the engine for everything else.
 */
async function structuralModel(
  input: { userId: string; datasetId: string | null; intent: string; message: string; language: 'ar' | 'en' },
  profile: DatasetProfile,
): Promise<DataAnalysisOutcome> {
  const ar = input.language === 'ar';
  const constructs = constructsFromItems(profile);
  const names = constructs.map((construct) => `${construct.name} (${construct.indicators.join(', ')})`);

  if (constructs.length < 2) {
    return {
      status: 'question',
      displays: [],
      question: ar
        ? `نمذجة المعادلات البنائية تحتاج مقياسين على الأقل، لكل منهما فقرات مرقّمة (مثل SQ1، SQ2، SQ3). ${constructs.length === 1 ? `وجدت مقياسًا واحدًا: ${names[0]}.` : 'لم أجد فقرات مرقّمة في الملف.'} ما المتغيّرات الكامنة وفقراتها؟ اكتبها مثل: SQ = q1, q2, q3`
        : `Structural equation modelling needs at least two scales, each with numbered items (such as SQ1, SQ2, SQ3). ${constructs.length === 1 ? `One was found: ${names[0]}.` : 'No numbered items were found.'} What are the constructs and their items? Write them as: SQ = q1, q2, q3`,
    };
  }

  try {
    if (input.intent === 'stats.cbSem') {
      /* A confirmatory factor analysis needs no paths: every factor correlates with every other. */
      const result = await runCbSem({
        datasetId: input.datasetId as string,
        userId: input.userId,
        model: { constructs, paths: [] } as never,
      });
      return { status: 'done', displays: [{ kind: 'cbsem', payload: result as unknown as Record<string, unknown> }] };
    }

    const paths = pathsFromText(input.message, constructs.map((construct) => construct.name));
    if (paths.length === 0) {
      return {
        status: 'question',
        displays: [],
        question: ar
          ? `وجدت في الملف هذه المقاييس: ${names.join('؛ ')}.\nما المسارات بينها؟ اكتب كل مسار من المؤثِّر إلى المتأثِّر، مثل: ${constructs[0]?.name} -> ${constructs[1]?.name}`
          : `The file contains these scales: ${names.join('; ')}.\nWhat are the paths between them? Write each from cause to effect, for example: ${constructs[0]?.name} -> ${constructs[1]?.name}`,
      };
    }

    const used = new Set(paths.flatMap((path) => [path.from, path.to]));
    const analysis = await runPls({
      datasetId: input.datasetId as string,
      userId: input.userId,
      model: { constructs: constructs.filter((construct) => used.has(construct.name)), paths },
    });
    return { status: 'done', displays: [{ kind: 'pls', payload: analysis as unknown as Record<string, unknown> }] };
  } catch (error) {
    /* The engine's own reason — a constant item, too few rows — is the answer. */
    const message =
      error && typeof error === 'object' && 'messageAr' in error && ar
        ? String((error as { messageAr: unknown }).messageAr)
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      status: 'question',
      displays: [],
      question: ar ? `تعذّر تقدير النموذج: ${message}` : `The model could not be estimated: ${message}`,
    };
  }
}
