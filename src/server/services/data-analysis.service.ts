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

import { planCleaning } from '@/analysis';
import { inferRoles, type AnalysisIntent } from '@/analysis/infer-roles';
import type { RoleAssignment } from '@/analysis/inference/recommend';
import type { ColumnProfile } from '@/analysis/types';

import { chooseTestFor, columnsFor } from './analysis-choice';
import { columnsNamedIn } from './data-requests';
import { loadForAnalysis } from './dataset.service';
import { runAnalysis } from './statistics.service';

export type DisplayKind = 'profile' | 'cleaning' | 'recommendation' | 'analysis' | 'reliability';

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
    return { status: 'done', displays: [profileDisplay] };
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
