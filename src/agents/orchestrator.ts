/**
 * The orchestrator: classify, plan, execute, report.
 *
 * It is a router, not a brain. Everything it does is delegate — the classifier
 * decides what was asked, the recommender decides which test fits, the engines
 * compute, the repositories persist. What it adds is sequence, progress
 * reporting, and the refusals.
 *
 * The refusals are the substance. A chat interface invites requests the product
 * cannot serve, and there are exactly three honest answers to those: ask a
 * question when the request is unclear, decline by name when the capability is
 * unbuilt, and say what is missing when the data does not support the analysis.
 * The dishonest fourth answer — run something adjacent that produces numbers —
 * is the one this file exists to make impossible.
 *
 * Two invariants hold throughout.
 *
 * **No statistic is computed here, and none is produced by a model.** Every
 * number in every result comes from `src/analysis`, verified against SciPy and
 * statsmodels. The orchestrator moves results around; it never makes them.
 *
 * **Every task is measured, no task is blocked.** Phase two records what each
 * request cost — stages, model calls, tokens, time — and enforces nothing. The
 * quotas come later, set from these measurements rather than from a guess made
 * before anyone had used the feature.
 */

import { recommendTest, type RoleAssignment } from '@/analysis';
import { logger } from '@/lib/logger';
import * as tasksRepo from '@/server/repositories/agent-tasks.repository';
import * as analysisRunsRepo from '@/server/repositories/analysis-runs.repository';
import { loadForAnalysis } from '@/server/services/dataset.service';
import {
  runAnalysis,
  type AnalysisTestKey,
} from '@/server/services/statistics.service';

import { encodeEvent, type AgentEvent, type PlanStep } from './events';
import { classifyIntent } from './intent';
import { capabilityFor, type IntentKey } from './registry';

/** A task may never exceed this, whatever happens inside it. */
const MAX_UNITS_PER_TASK = 20;
/** Hard ceiling on stages, so a loop cannot run indefinitely. */
const MAX_STEPS = 12;

export interface AgentRequest {
  userId: string;
  message: string;
  locale: 'ar' | 'en';
  datasetId?: string | null;
  projectId?: string | null;
  conversationId?: string | null;
  history?: { role: 'user' | 'assistant'; content: string }[];
  /**
   * Column roles the user has confirmed.
   *
   * The agent never infers which variable is the outcome. That decision is what
   * the study is about, and guessing it would mean deciding on the researcher's
   * behalf what their research question is.
   */
  roles?: RoleAssignment[];
  /** A test the user chose explicitly, overriding the recommendation. */
  test?: AnalysisTestKey;
}

/* -------------------------------------------------------------------------- */
/*                                    Run                                     */
/* -------------------------------------------------------------------------- */

/**
 * Runs one request and yields events as it goes.
 *
 * A generator rather than a callback so the route can pipe it straight into an
 * SSE stream, and so the whole thing can be driven synchronously in a test with
 * no HTTP involved.
 */
export async function* runAgent(request: AgentRequest): AsyncGenerator<AgentEvent> {
  const startedAt = Date.now();
  let taskId: string | null = null;
  let aiRequests = 0;
  let stepsDone = 0;

  try {
    /* ------------------------------ understand --------------------------- */

    const profile = request.datasetId
      ? (await loadForAnalysis(request.datasetId, request.userId)).profile
      : null;

    const intent = await classifyIntent({
      message: request.message,
      locale: request.locale,
      profile,
      history: request.history,
    });
    aiRequests += 1;

    yield {
      type: 'understanding',
      intent: intent.intent,
      confidence: intent.confidence,
      restatement: intent.restatement,
      columns: intent.mentionedColumns,
    };

    const capability = capabilityFor(intent.intent);

    /* -------------------------- start measuring -------------------------- */

    const task = await tasksRepo.start({
      userId: request.userId,
      conversationId: request.conversationId ?? null,
      projectId: request.projectId ?? null,
      kind: intent.intent,
      intent: intent.intent,
      declaredUnits: Math.min(capability.units, MAX_UNITS_PER_TASK),
      stagesPlanned: 0,
    });
    taskId = task.id;

    /* ----------------------------- unclear ------------------------------- */

    if (intent.intent === 'general.unclear') {
      yield {
        type: 'question',
        question: intent.clarifyingQuestion ?? intent.restatement,
      };
      await finish(taskId, 'COMPLETED', { aiRequests, stepsDone, startedAt, units: 0 });
      yield done(taskId, 0, aiRequests, startedAt);
      return;
    }

    /* --------------------------- not built yet --------------------------- */

    /*
     * The request was understood and cannot be served. Declining it by name is
     * the whole point: "that is PLS-SEM, and it is not built yet" tells the
     * researcher something true about the tool, where running a regression
     * instead would tell them something false about their data.
     */
    if (capability.status === 'planned') {
      yield {
        type: 'unavailable',
        intent: intent.intent,
        reasonKey: capability.unavailableReason ?? 'agent.unavailable.generic',
        alternatives: alternativesFor(intent.intent),
      };
      await finish(taskId, 'COMPLETED', { aiRequests, stepsDone, startedAt, units: 0 });
      yield done(taskId, 0, aiRequests, startedAt);
      return;
    }

    /* --------------------------- needs a file ---------------------------- */

    if (capability.requiresDataset && !request.datasetId) {
      yield {
        type: 'question',
        question:
          request.locale === 'ar'
            ? 'هذا الطلب يحتاج ملف بيانات. ارفع ملف CSV أو Excel لأبدأ.'
            : 'That needs a data file. Upload a CSV or Excel file and I will begin.',
      };
      await finish(taskId, 'COMPLETED', { aiRequests, stepsDone, startedAt, units: 0 });
      yield done(taskId, 0, aiRequests, startedAt);
      return;
    }

    /* ------------------------------- plan -------------------------------- */

    const steps = planFor(intent.intent);
    yield {
      type: 'plan',
      steps,
      estimatedUnits: capability.units,
      maxUnits: MAX_UNITS_PER_TASK,
    };

    await tasksRepo.progress(taskId, { stagesCompleted: 0 });

    /* ------------------------------ execute ------------------------------ */

    for (const step of steps.slice(0, MAX_STEPS)) {
      yield { type: 'step', id: step.id, status: 'running', labelKey: step.labelKey, params: step.params };

      const outcome = await executeStep({
        step: step.id,
        request,
        intent: intent.intent,
        mentionedColumns: intent.mentionedColumns,
      });

      if (outcome.kind === 'question') {
        yield { type: 'step', id: step.id, status: 'done', labelKey: step.labelKey };
        yield { type: 'question', question: outcome.question, options: outcome.options };
        stepsDone += 1;
        break;
      }

      if (outcome.kind === 'unavailable') {
        yield { type: 'step', id: step.id, status: 'failed', labelKey: step.labelKey };
        yield {
          type: 'unavailable',
          intent: outcome.intent,
          reasonKey: outcome.reasonKey,
          alternatives: [],
        };
        stepsDone += 1;
        break;
      }

      yield { type: 'step', id: step.id, status: 'done', labelKey: step.labelKey };
      if (outcome.event) yield outcome.event;
      stepsDone += 1;
    }

    await finish(taskId, 'COMPLETED', { aiRequests, stepsDone, startedAt, units: capability.units });
    yield done(taskId, capability.units, aiRequests, startedAt);
  } catch (error) {
    logger.error('agent.failed', { error: String(error) });

    if (taskId) {
      await finish(taskId, 'FAILED', { aiRequests, stepsDone, startedAt, units: 0 }).catch(
        () => undefined,
      );
    }

    yield {
      type: 'error',
      messageKey: 'agent.error.failed',
      message: error instanceof Error ? error.message : 'Something went wrong.',
    };
  }
}

/** Serialises the generator into an SSE stream for a route handler. */
export function agentStream(request: AgentRequest): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runAgent(request)) {
          controller.enqueue(encoder.encode(encodeEvent(event)));
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            encodeEvent({
              type: 'error',
              messageKey: 'agent.error.failed',
              message: error instanceof Error ? error.message : 'unknown',
            }),
          ),
        );
      } finally {
        controller.close();
      }
    },
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Planning                                  */
/* -------------------------------------------------------------------------- */

/**
 * The stages for an intent.
 *
 * Fixed per intent rather than generated by a model. The sequence of steps in a
 * statistical analysis is not a creative decision — profile, choose, check
 * assumptions, compute — and having a model invent it each time would make the
 * product behave differently on identical requests.
 */
function planFor(intent: IntentKey): PlanStep[] {
  switch (intent) {
    case 'data.inspect':
    case 'data.describe':
      return [{ id: 'profile', labelKey: 'agent.step.profile' }];

    case 'data.clean':
      return [
        { id: 'profile', labelKey: 'agent.step.profile' },
        { id: 'proposeCleaning', labelKey: 'agent.step.proposeCleaning' },
      ];

    case 'stats.recommend':
      return [
        { id: 'profile', labelKey: 'agent.step.profile' },
        { id: 'recommend', labelKey: 'agent.step.recommend' },
      ];

    case 'research.results':
      return [
        { id: 'gatherResults', labelKey: 'agent.step.gatherResults' },
        { id: 'writeResults', labelKey: 'agent.step.writeResults' },
      ];

    case 'stats.reliability':
      return [
        { id: 'profile', labelKey: 'agent.step.profile' },
        { id: 'reliability', labelKey: 'agent.step.reliability' },
      ];

    case 'stats.compare':
    case 'stats.relate':
    case 'stats.predict':
    case 'stats.categorical':
      return [
        { id: 'profile', labelKey: 'agent.step.profile' },
        { id: 'recommend', labelKey: 'agent.step.chooseTest' },
        { id: 'analyse', labelKey: 'agent.step.analyse' },
      ];

    default:
      return [{ id: 'respond', labelKey: 'agent.step.respond' }];
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Execution                                  */
/* -------------------------------------------------------------------------- */

type StepOutcome =
  | { kind: 'event'; event: AgentEvent | null }
  | { kind: 'question'; question: string; options?: { value: string; label: string }[] }
  | { kind: 'unavailable'; intent: IntentKey; reasonKey: string };

async function executeStep(input: {
  step: string;
  request: AgentRequest;
  intent: IntentKey;
  mentionedColumns: string[];
}): Promise<StepOutcome> {
  const { request, intent } = input;
  const locale = request.locale;

  switch (input.step) {
    case 'profile': {
      const loaded = await loadForAnalysis(request.datasetId as string, request.userId);
      return {
        kind: 'event',
        event: {
          type: 'result',
          kind: 'profile',
          datasetId: request.datasetId as string,
          payload: loaded.profile as unknown as Record<string, unknown>,
        },
      };
    }

    case 'proposeCleaning': {
      const { planCleaning } = await import('@/analysis');
      const loaded = await loadForAnalysis(request.datasetId as string, request.userId);
      return {
        kind: 'event',
        event: {
          type: 'result',
          kind: 'cleaning',
          datasetId: request.datasetId as string,
          payload: { proposals: planCleaning(loaded.profile) },
        },
      };
    }

    case 'recommend': {
      /*
       * Roles are the researcher's to assign. Without them the agent stops and
       * asks, rather than deciding which of their variables is the outcome —
       * that decision is what the study is about.
       */
      if (!request.roles || request.roles.length === 0) {
        return {
          kind: 'question',
          question:
            locale === 'ar'
              ? 'أي متغيّر هو التابع (الذي تريد تفسيره)، وأيها المستقل أو متغيّر التجميع؟'
              : 'Which variable is the outcome you want to explain, and which is the predictor or grouping variable?',
        };
      }

      const loaded = await loadForAnalysis(request.datasetId as string, request.userId);
      const recommendation = recommendTest(loaded.profile, request.roles);

      /*
       * The recommender found the right test and it is not built. Passing the
       * refusal straight through, by name, rather than falling back to whatever
       * would run.
       */
      if (!recommendation.best) {
        const named = recommendation.candidates.find(
          (candidate) => !candidate.available && candidate.confidence === 'recommended',
        );

        if (named) {
          return {
            kind: 'unavailable',
            intent: 'stats.nonparametric',
            reasonKey: `agent.unavailable.test.${named.test}`,
          };
        }

        return {
          kind: 'question',
          question:
            locale === 'ar'
              ? 'لا يوجد اختبار مناسب لهذه المتغيّرات بأدوارها الحالية. هل تريد تغيير الأدوار أو اختيار متغيّرات أخرى؟'
              : 'No test fits these variables in these roles. Would you like to change the roles or pick other variables?',
        };
      }

      return {
        kind: 'event',
        event: {
          type: 'result',
          kind: 'recommendation',
          datasetId: request.datasetId as string,
          payload: recommendation as unknown as Record<string, unknown>,
        },
      };
    }

    case 'reliability': {
      const items = request.roles?.map((role) => role.column) ?? input.mentionedColumns;

      if (items.length < 2) {
        return {
          kind: 'question',
          question:
            locale === 'ar'
              ? 'أي بنود المقياس تريد حساب ثباتها؟ اختر بندين على الأقل.'
              : 'Which scale items should I check? Pick at least two.',
        };
      }

      const outcome = await runAnalysis({
        datasetId: request.datasetId as string,
        userId: request.userId,
        test: 'reliability.cronbachAlpha',
        columns: { items },
        projectId: request.projectId ?? null,
        conversationId: request.conversationId ?? null,
      });

      return {
        kind: 'event',
        event: {
          type: 'result',
          kind: 'reliability',
          runId: outcome.run.id,
          datasetId: request.datasetId as string,
          payload: outcome.result as Record<string, unknown>,
        },
      };
    }

    /*
     * Writing the results chapter needs analyses the researcher attached to a
     * section — not a file, and not everything they ever ran. Attaching is the
     * deliberate act that separates a finding they intend to report from one
     * they were exploring, and the chapter is written from that set alone.
     */
    case 'gatherResults': {
      if (!request.projectId) {
        return {
          kind: 'question',
          question:
            locale === 'ar'
              ? 'لأي مشروع تريد كتابة فصل النتائج؟ اختر المشروع من القائمة أعلى المحادثة ثم أعد طلبك.'
              : 'Which project should I write the results chapter for? Pick one from the menu at the top of this conversation, then ask again.',
        };
      }

      const attached = await analysisRunsRepo.listAttached(request.projectId, request.userId);

      if (attached.length === 0) {
        return {
          kind: 'question',
          question:
            locale === 'ar'
              ? 'لا توجد نتائج تحليل مرتبطة بهذا المشروع بعد. شغّل التحليلات التي تريد عرضها ثم أرفقها بقسم النتائج، وسأكتب الفصل من أرقامك الحقيقية.'
              : 'No analyses are attached to this project yet. Run the analyses you want to report and attach them to the results section, and I will write the chapter from your real figures.',
        };
      }

      return {
        kind: 'event',
        event: {
          type: 'result',
          kind: 'analysis',
          payload: {
            attachedCount: attached.length,
            tests: attached.map((run) => run.testKey),
          },
        },
      };
    }

    case 'writeResults': {
      if (!request.projectId) return { kind: 'event', event: null };

      const { generateSection } = await import('@/server/services/ai.service');
      const generated = await generateSection(
        request.userId,
        request.projectId,
        'RESULTS' as Parameters<typeof generateSection>[2],
      );

      return { kind: 'event', event: { type: 'delta', text: generated.content } };
    }

    case 'analyse': {
      const test = request.test ?? (await chooseTest(request, intent));

      if (!test) {
        return {
          kind: 'question',
          question:
            locale === 'ar'
              ? 'أحتاج تحديد الأدوار أولًا: أي متغيّر تابع وأيها مستقل؟'
              : 'I need the roles first: which variable is the outcome and which is the predictor?',
        };
      }

      const outcome = await runAnalysis({
        datasetId: request.datasetId as string,
        userId: request.userId,
        test,
        columns: columnsFor(test, request.roles ?? []),
        projectId: request.projectId ?? null,
        conversationId: request.conversationId ?? null,
      });

      return {
        kind: 'event',
        event: {
          type: 'result',
          kind: 'analysis',
          runId: outcome.run.id,
          datasetId: request.datasetId as string,
          payload: outcome.result,
        },
      };
    }

    default:
      return { kind: 'event', event: null };
  }
}

/**
 * Which test to run, from the recommender rather than the model.
 *
 * Returns null when the recommender has nothing available, so the caller asks
 * instead of substituting.
 */
async function chooseTest(
  request: AgentRequest,
  intent: IntentKey,
): Promise<AnalysisTestKey | null> {
  if (!request.roles || request.roles.length === 0) return null;

  const loaded = await loadForAnalysis(request.datasetId as string, request.userId);
  const recommendation = recommendTest(loaded.profile, request.roles);

  if (!recommendation.best) return null;

  const capability = capabilityFor(intent);
  const chosen = recommendation.best.test as AnalysisTestKey;

  /*
   * The recommender answers "which test fits these variables", and the intent
   * answers "what did the user ask for". When they disagree — a comparison
   * request whose variables suit a regression — the intent wins, because the
   * user's question is not the agent's to reinterpret.
   */
  if (capability.tests && !capability.tests.includes(chosen)) {
    return capability.tests[0] ?? null;
  }

  return chosen;
}

/** Maps confirmed roles onto the column shape each engine expects. */
function columnsFor(
  test: AnalysisTestKey,
  roles: RoleAssignment[],
): Parameters<typeof runAnalysis>[0]['columns'] {
  const dependent = roles.find((role) => role.role === 'dependent')?.column;
  const grouping = roles.find((role) => role.role === 'grouping')?.column;
  const independents = roles
    .filter((role) => role.role === 'independent' || role.role === 'covariate')
    .map((role) => role.column);
  const paired = roles.filter((role) => role.role === 'paired').map((role) => role.column);

  switch (test) {
    case 't.paired':
      return { paired: [paired[0] as string, paired[1] as string] };
    case 'correlation.pearson':
    case 'correlation.spearman':
    case 'correlation.matrix':
      return { independents: independents.length >= 2 ? independents : [dependent, ...independents].filter(Boolean) as string[] };
    case 'chiSquare.independence':
      return { dependent, grouping };
    case 'reliability.cronbachAlpha':
      return { items: [dependent, ...independents].filter(Boolean) as string[] };
    default:
      return { dependent, grouping, independents };
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/** What a researcher can do instead, when their request cannot be served. */
function alternativesFor(intent: IntentKey): IntentKey[] {
  switch (intent) {
    case 'stats.plsSem':
    case 'stats.cbSem':
      return ['stats.reliability', 'stats.relate', 'stats.predict'];
    case 'stats.logistic':
      return ['stats.categorical'];
    case 'stats.nonparametric':
      return ['stats.compare'];
    case 'research.results':
      return ['stats.recommend', 'stats.compare'];
    default:
      return [];
  }
}

async function finish(
  taskId: string,
  status: 'COMPLETED' | 'FAILED',
  values: { aiRequests: number; stepsDone: number; startedAt: number; units: number },
): Promise<void> {
  await tasksRepo.complete(taskId, {
    status,
    // Capped, so a task can never charge more than it announced.
    chargedUnits: Math.min(values.units, MAX_UNITS_PER_TASK),
    stagesCompleted: values.stepsDone,
    aiRequestCount: values.aiRequests,
    durationMs: Date.now() - values.startedAt,
  });
}

function done(
  taskId: string | null,
  units: number,
  aiRequests: number,
  startedAt: number,
): AgentEvent {
  return {
    type: 'done',
    taskId,
    units,
    aiRequests,
    durationMs: Date.now() - startedAt,
  };
}
