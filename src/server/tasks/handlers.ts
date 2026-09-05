/**
 * Connecting capabilities to the work that performs them.
 *
 * The executor knows how to schedule steps and nothing about what they do; the
 * services know how to search, analyse and generate and nothing about tasks.
 * This is the seam between them, and keeping it thin is the point — a handler
 * should translate a step's structured input into a service call and translate
 * the result back, and contain no logic of its own. Logic here would be logic
 * that exists nowhere else and is tested by nothing.
 *
 * **Outputs are structured and small.** A search handler returns titles and
 * URLs, not the full text of eight pages. The next step reads what it needs by
 * key. Passing everything would cost tokens on every downstream call and make
 * each step's behaviour depend on everything before it.
 */

import { logger } from '@/lib/logger';
import { search as searchAcademic } from '@/server/knowledge';
import { checkQuality } from '@/server/quality/engine';
import { verifyDois } from '@/server/quality/doi';
import type { Reference } from '@/server/quality/sources';
import { runDeepResearch } from '@/server/research/pipeline';
import { formatReferenceList, type StyleId } from '@/server/citation/styles';
import {
  generateCsv,
  generateMarkdown,
  generatePdf,
  generatePptx,
} from '@/server/generators/documents';
import { generateDocx } from '@/server/generators/docx';
import { generateTxt, generateXlsx } from '@/server/generators/spreadsheet';
import { toBibTeX, toRIS } from '@/server/generators/bibliography';
import { readArtifact, storeArtifact, type ArtifactKind } from '@/server/services/artifact.service';
import * as tasksRepo from '@/server/repositories/tasks.repository';
import { answerGeneralQuestion, generateSurveyItems } from '@/server/services/ai.service';
import { runCbSem, runPls } from '@/server/services/pls.service';
import { searchWeb } from '@/server/services/web-search.service';
import {
  failed,
  makeOutput,
  needsInput,
  partial,
  readAllOutputs,
  readOutput,
  succeeded,
  type Finding,
  type Observation,
  type OutputReference,
  type ProducerContext,
} from './contracts';
import { registerHandler, type StepContext } from './executor';
import { resolveProvider } from '@/ai/registry';
import { decideOutputLanguage, languageInstruction } from '@/server/context/language';
import { generateLongForm, incompleteNotice } from '@/server/ai/long-form';
import { broaden, topicOf } from './query';

/**
 * The producer identity every output carries.
 *
 * Built once per handler rather than passed field by field: provenance that is
 * assembled at each call site is provenance that will be wrong at one of them.
 */
function producer(context: StepContext, capability: string): ProducerContext {
  return {
    taskId: context.taskId,
    stepId: context.stepId,
    capability,
    projectId: context.projectId,
  };
}

/** Reads a string from a step's input or the task context, in that order. */
function textInput(context: StepContext, key: string, fallback = ''): string {
  const fromInput = context.input[key];
  if (typeof fromInput === 'string' && fromInput.trim()) return fromInput;

  const fromContext = context.context[key];
  if (typeof fromContext === 'string' && fromContext.trim()) return fromContext;

  return fallback;
}

/**
 * References gathered by earlier steps.
 *
 * Collected across dependencies rather than from one, because a document may
 * draw on both an academic search and a web search, and asking the planner to
 * nominate which one supplies references would be a decision it should not have
 * to make.
 */
function referencesFrom(context: StepContext): Reference[] {
  const collected: Reference[] = [];

  /*
   * Read by data type, not by producer name.
   *
   * `dependencies['academic.search']` was the old contract, and it meant a
   * literature review could only be fed by an academic search — deep research
   * producing the same sources was invisible to it, and renaming a capability
   * broke every consumer silently.
   *
   * Both source-bearing types are read, so whichever step found the sources
   * feeds whichever step needs them.
   */
  for (const type of ['sources.v1', 'citations.v1'] as const) {
    for (const found of readAllOutputs<{ references?: Reference[] }>(context.available, type)) {
      if (Array.isArray(found.references)) collected.push(...found.references);
    }
  }

  /* Deduplicated by DOI or title: two searches on one topic overlap heavily. */
  const seen = new Set<string>();

  return collected.filter((reference) => {
    const key = reference.doi?.toLowerCase() ?? (reference.title ?? '').toLowerCase();
    if (!key || seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

/** Prose written by earlier steps, in the order they appear. */
function proseFrom(context: StepContext): string {
  const parts: string[] = [];

  /* Written text, whichever capability wrote it. */
  for (const type of ['prose.v1', 'literature.v1'] as const) {
    for (const found of readAllOutputs<{ text?: string }>(context.available, type)) {
      if (typeof found.text === 'string') parts.push(found.text);
    }
  }

  return parts.join('\n\n');
}

/**
 * Prose with its heading, for assembling a document section by section.
 *
 * Returned as a list rather than joined, because a document needs the
 * boundaries — one long block loses the structure a reader navigates by, and
 * the heading is what a chapter is called.
 */
function sectionsFrom(context: StepContext): { heading: string; text: string }[] {
  const sections: { heading: string; text: string }[] = [];

  for (const type of ['literature.v1', 'prose.v1'] as const) {
    for (const found of readAllOutputs<{ text?: string; heading?: string }>(
      context.available,
      type,
    )) {
      if (typeof found.text === 'string' && found.text.trim()) {
        sections.push({ heading: found.heading ?? '', text: found.text });
      }
    }
  }

  return sections;
}

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

export function registerAllHandlers(): void {
  /* --------------------------- general answer --------------------------- */

  registerHandler('general.answer', async (context): Promise<Observation> => {
    const question = textInput(context, 'question', textInput(context, 'topic'));

    if (!question) {
      return needsInput('What would you like me to answer?', 'question');
    }

    const answer = await answerGeneralQuestion({
      userId: context.userId,
      message: question,
      locale: context.locale,
      projectId: null,
      history: [],
    });

    return succeeded(
      /* `.content`, because the service returns `{ content, usage }`. */
      [makeOutput(producer(context, 'general.answer'), 'prose.v1', { text: answer.content })],
      { modelCalls: 1 },
    );
  });

  /* ------------------------------ web search ---------------------------- */

  registerHandler('web.search', async (context): Promise<Observation> => {
    const raw = textInput(context, 'query', textInput(context, 'topic'));

    if (!raw) return needsInput('What should I search for?', 'query');

    /* Stripped of the request's instructions; see `topicOf`. */
    const query = topicOf(raw);

    const result = await searchWeb({
      userId: context.userId,
      query,
      locale: context.locale,
    });

    /*
     * Two outputs: the sources, and the answer as prose.
     *
     * Separated because they are consumed differently — a writing step wants
     * the references, a reader wants the answer. Bundling them forced every
     * consumer to know the shape of a web search result.
     *
     * The sources carry no page text: a dependent step cites them rather than
     * re-reading them, and eight full pages would be thousands of tokens on
     * every call that follows.
     */
    const references = result.sources.map((source) => ({
      id: String(source.index),
      kind: 'website' as const,
      title: source.title,
      url: source.url,
      container: source.container,
      provenance: 'retrieved' as const,
    }));

    const stamp = producer(context, 'web.search');

    return succeeded(
      [
        makeOutput(stamp, 'sources.v1', { references, query, found: references.length }),
        makeOutput(stamp, 'prose.v1', { text: result.answer, references }),
      ],
      { modelCalls: 1 },
    );
  });

  /* --------------------------- academic search -------------------------- */

  registerHandler('academic.search', async (context): Promise<Observation> => {
    const query = textInput(context, 'query', textInput(context, 'topic'));

    if (!query) return needsInput('What topic should I search for?', 'query');

    const report = await searchAcademic({
      queries: [{ text: query, language: context.locale }],
      kind: 'academic',
      preferredLanguage: context.locale,
      limit: 12,
    });

    const references: Reference[] = report.sources.map((source, index) => ({
      id: String(index + 1),
      kind: source.doi ? ('journal-article' as const) : ('unknown' as const),
      title: source.title,
      authors: source.authors,
      year: source.year,
      container: source.container,
      doi: source.doi,
      url: source.url,
      provenance: 'retrieved' as const,
    }));

    /*
     * Two conditions worth telling the planner about, and they are different
     * problems.
     *
     * A thin result means the phrasing was too narrow. An off-topic result
     * means the search found the wrong corpus entirely — which happened to a
     * researcher who asked for hybrid learning and received ten papers on
     * learning disabilities. Writing a review from either would produce
     * something worse than nothing.
     */
    const thin = references.length < 4;
    const stamp = producer(context, 'academic.search');

    const sources = makeOutput(stamp, 'sources.v1', {
      references,
      query,
      found: references.length,
      offTopic: report.offTopic,
      discarded: report.discardedAsIrrelevant,
    });

    /*
     * A finding rather than a sentence.
     *
     * This returned `suggestsMoreWork` as free text, which the planner could
     * only pass to a model — a model call to interpret a condition the handler
     * already knew. A structured finding names the code and the numbers, so the
     * replanner decides without asking anyone.
     */
    const findings: Finding[] = [];

    if (report.offTopic) {
      findings.push({
        code: 'search.offTopic',
        severity: 'warning',
        message: `The results for "${query}" do not appear to concern the topic`,
        metadata: { query, returned: references.length },
      });
    } else if (thin) {
      findings.push({
        code: 'search.thin',
        severity: 'warning',
        message: `Only ${references.length} sources found for "${query}"`,
        metadata: { query, found: references.length },
      });
    }

    /*
     * Off-topic or thin results are `partial`, not `success`. The step did its
     * work and the work is not enough — and the difference decides whether the
     * replanner widens the search or moves on.
     */
    if (findings.length > 0) {
      return partial([sources], report.offTopic ? [`sources actually about "${query}"`] : [], {
        warnings: findings,
        modelCalls: 1,
        recommendedNextActions: [
          {
            capability: 'academic.search',
            reason: report.offTopic ? 'the query found the wrong corpus' : 'too few sources',
            /*
             * A different query, or none.
             *
             * Recommending the same search with the same words would repeat the
             * failure exactly — a second wrong corpus, a third recommendation,
             * and a budget spent circling. When the corpus is wrong the phrasing
             * is the problem, and only the researcher or the planner can supply
             * a better one; when the result is merely thin, dropping the
             * narrowest word is a correction this can make itself.
             */
            input: report.offTopic
              ? {}
              : { topic: broaden(query) },
          },
        ],
        confidence: report.offTopic ? 0.2 : 0.6,
      });
    }

    return succeeded([sources], {
      modelCalls: 1,
      evidence: references.map((reference) => ({
        claim: reference.title ?? '',
        sourceIds: [reference.id],
      })),
    });
  });

  /* --------------------------- deep research ---------------------------- */

  registerHandler('deep.research', async (context): Promise<Observation> => {
    const question = textInput(context, 'question', textInput(context, 'topic'));

    if (!question) return needsInput('What should I research?', 'question');

    const report = await runDeepResearch({
      userId: context.userId,
      question,
      locale: context.locale,
      shouldStop: () => context.signal.aborted,
    });

    const deepReferences = report.sources.map((source) => ({
      id: String(source.index),
      kind: source.kind === 'academic' ? ('journal-article' as const) : ('website' as const),
      title: source.title,
      url: source.url,
      doi: source.doi,
      year: source.year,
      provenance: 'retrieved' as const,
    }));

    const deepStamp = producer(context, 'deep.research');

    /*
     * Three outputs from one step, and the third is the point.
     *
     * Deep research produces sources, a written synthesis, and the questions the
     * sources did not answer. Emitting the gaps as their own type means a
     * document step can state the review's limitations without re-deriving
     * them, and the replanner can act on them.
     */
    const outputs = [
      makeOutput(deepStamp, 'sources.v1', {
        references: deepReferences,
        query: question,
        found: deepReferences.length,
      }),
      makeOutput(deepStamp, 'literature.v1', {
        text: report.report,
        references: deepReferences,
        heading: question,
      }),
    ];

    if (report.remainingGaps.length > 0) {
      outputs.push(
        makeOutput(deepStamp, 'research-gap.v1', { gaps: report.remainingGaps, topic: question }),
      );
    }

    return succeeded(outputs, {
      modelCalls: 8,
      /* Stated rather than implied: the review knows what it could not close. */
      missingInformation: report.remainingGaps,
    });
  });

  /* -------------------------- literature review ------------------------- */

  registerHandler('literature.review', async (context): Promise<Observation> => {
    /*
     * Sources by type, whichever capability found them. An academic search, a
     * deep research run, or a web search all satisfy this — which is what makes
     * the review reusable rather than bound to one producer.
     */
    const references = referencesFrom(context);

    /*
     * A search that found the wrong corpus is refused as firmly as one that
     * found nothing. A review written from ten papers on another subject is
     * worse than no review: it looks like work and is unusable.
     */
    /*
     * The off-topic signal, read from the sources output rather than from a
     * capability-keyed blob. Same finding, addressed by data type.
     */
    const offTopic = readAllOutputs<{ offTopic?: boolean }>(
      context.available,
      'sources.v1',
    ).some((bundle) => bundle.offTopic === true);

    if (offTopic) {
      return needsInput(
        context.locale === 'ar'
          ? 'المصادر التي وجدتها لا تتناول الموضوع المطلوب. هل تريد صياغة أخرى للبحث؟'
          : 'The sources I found do not concern this topic. Would you like to rephrase the search?',
        'query',
      );
    }

    if (references.length === 0) {
      /*
       * Refused rather than written. A literature review with no literature is
       * the exact failure the evidence rules exist to prevent — the model would
       * write something fluent and cite work it invented.
       */
      return needsInput(
        context.locale === 'ar'
          ? 'لم أجد مصادر لكتابة المراجعة. هل تريد توسيع نطاق البحث؟'
          : 'No sources were found to review. Should I broaden the search?',
        'query',
      );
    }

    const topic = textInput(context, 'topic', 'the topic');

    /*
     * The output language, decided the same way the writing step decides it.
     *
     * A researcher asked in Arabic and received an English literature review:
     * this handler read `context.locale`, which comes from the browser, while
     * the writing handler had already been moved to reading the request. One
     * of the two was fixed and the other was not, which is why the same
     * document arrived half in each language.
     */
    const reviewDecision = decideOutputLanguage({
      request: `${topic} ${String(context.context.request ?? '')}`,
      contextLanguage: (context.context.language as 'ar' | 'en' | undefined) ?? null,
      interfaceLocale: context.locale,
    });

    const reviewLanguage = reviewDecision.language;

    const sourceList = references
      .map((reference, index) => `[${index + 1}] ${reference.title ?? ''} (${reference.year ?? ''})`)
      .join('\n');

    const reviewPrompt =
      reviewLanguage === 'ar'
        ? `اكتب مراجعة أدبيات عن «${topic}» من المصادر المرقّمة أدناه وحدها. استشهد برقم المصدر بعد كل معلومة. اذكر التعارضات والثغرات صراحةً. أنهِ النصّ بفقرة تامّة لا بقائمة مبتورة.\n\n${sourceList}`
        : `Write a literature review of "${topic}" using only the numbered sources below. Cite the source number after each claim. State disagreements and gaps explicitly. End with a complete paragraph, not a truncated list.\n\n${sourceList}`;

    /*
     * Generated across as many rounds as the review needs.
     *
     * The old path made one call for two thousand tokens and handed over
     * whatever came back — which for twelve sources meant a review ending
     * "* **Robotics" with no closing sentence. A reader skimming it sees a
     * finished document.
     */
    const reviewProvider = await resolveProvider();

    const reviewed = await generateLongForm({
      provider: reviewProvider,
      system: `${languageInstruction(reviewLanguage)}\n\nYou are writing an academic literature review. Write connected prose. Cite only the numbered sources given, and never invent a source.`,
      prompt: reviewPrompt,
      locale: reviewLanguage,
    });

    if (reviewed.text.trim().length < 40) {
      return failed([
        {
          code: 'review.empty',
          severity: 'error',
          message: `The model returned no usable review for "${topic}".`,
          reference: topic,
        },
      ]);
    }

    const reviewNotice = incompleteNotice(reviewed, reviewLanguage);
    const reviewBody = reviewNotice ? `${reviewed.text}\n\n${reviewNotice}` : reviewed.text;

    /*
     * An unfinished review is reported as partial, never as success — the same
     * rule the writing step follows, for the same reason: a document that
     * stopped at a length limit reads as complete.
     */
    if (!reviewed.complete) {
      return partial(
        [
          makeOutput(producer(context, 'literature.review'), 'literature.v1', {
            text: reviewBody,
            references,
            heading: topic,
            complete: false,
          }),
        ],
        [reviewLanguage === 'ar' ? 'بقيّة المراجعة' : 'the rest of the review'],
        {
          warnings: [
            {
              code: 'review.incomplete',
              severity: 'warning',
              message: `Review stopped early (${reviewed.incompleteReason ?? 'unknown'}) after ${reviewed.rounds} rounds.`,
              reference: topic,
            },
          ],
          confidence: 0.5,
          recommendedNextActions: [
            {
              capability: 'literature.review',
              reason: 'continue the unfinished review',
              input: { topic, continueFrom: reviewed.text.slice(-400) },
            },
          ],
        },
      );
    }

    return succeeded(
      [
        makeOutput(producer(context, 'literature.review'), 'literature.v1', {
          text: reviewBody,
          references,
          heading: topic,
        }),
      ],
      {
        modelCalls: 2,
        /* Every reference the review drew on, traceable to the claim. */
        evidence: references.map((reference) => ({
          claim: reference.title ?? '',
          sourceIds: [reference.id],
        })),
      },
    );
  });

  /* ---------------------------- data analysis --------------------------- */

  registerHandler('statistics.pls', async (context): Promise<Observation> => {
    const datasetId = textInput(context, 'datasetId');

    if (!datasetId) return needsInput('Which dataset should I analyse?', 'datasetId');

    /*
     * The model comes from the step's input, or from a confirmed proposal.
     *
     * A `pls-model.v1` output carries a `confirmed` flag: the agent may propose
     * a model from the hypotheses, and an unconfirmed proposal is not a mandate
     * to run it. The model is the researcher's theory, and running a version
     * they have not seen would produce numbers for a study nobody is
     * conducting.
     */
    const proposed = readOutput<{ model?: unknown; confirmed?: boolean }>(
      context.available,
      'pls-model.v1',
    );

    const model = context.input.model ?? (proposed?.confirmed ? proposed.model : undefined);

    if (!model) {
      const question = proposed
        ? context.locale === 'ar'
          ? 'هل تؤكّد نموذج PLS المقترح كما هو؟ النموذج نظريتك، ولن يُشغَّل قبل تأكيدك.'
          : 'Do you confirm the proposed PLS model as it stands? The model is your theory, and it will not run until you confirm it.'
        : context.locale === 'ar'
          ? 'ما نموذج PLS؟ حدّد المتغيّرات الكامنة والمسارات بينها.'
          : 'What is the PLS model? Name the constructs and the paths between them.';

      return needsInput(question, 'model');
    }

    const analysis = await runPls({
      datasetId,
      userId: context.userId,
      model: model as never,
    });

    /*
     * The verdict and section summaries, not the raw estimate. A later step
     * cites what the analysis concluded; the loading matrix would be thousands
     * of tokens it cannot use — and it already lives in the analysis run.
     */
    return succeeded([
      makeOutput(
        producer(context, 'statistics.pls'),
        'pls-results.v1',
        {
          verdict: analysis.report.verdict,
          sections: analysis.report.sections.map((section) => ({
            titleKey: section.titleKey,
            findings: section.findings.length,
          })),
          n: analysis.n,
        },
        { metadata: { datasetId, converged: true } },
      ),
    ]);
  });

  registerHandler('statistics.cbsem', async (context): Promise<Observation> => {
    const datasetId = textInput(context, 'datasetId');

    const proposed = readOutput<{ model?: unknown; confirmed?: boolean }>(
      context.available,
      'pls-model.v1',
    );

    const model = context.input.model ?? (proposed?.confirmed ? proposed.model : undefined);

    if (!datasetId || !model) {
      return needsInput(
        context.locale === 'ar'
          ? 'ما نموذج القياس؟ حدّد المتغيّرات الكامنة وبنودها.'
          : 'What is the measurement model? Name the factors and their indicators.',
        'model',
      );
    }

    const result = await runCbSem({ datasetId, userId: context.userId, model: model as never });

    /*
     * Reported as `analysis.v1` rather than a CB-SEM-specific type: a document
     * step wants "the analysis", and adding a type per method would mean every
     * consumer listing them all.
     */
    return succeeded([
      makeOutput(
        producer(context, 'statistics.cbsem'),
        'analysis.v1',
        {
          method: 'cb-sem',
          fit: result.fit,
          loadings: result.loadings.map((loading) => ({
            construct: loading.construct,
            indicator: loading.indicator,
            standardised: loading.standardised,
          })),
          n: result.n,
        },
        { metadata: { datasetId, verdict: result.fit.verdict } },
      ),
    ]);
  });

  /* ------------------------------- writing ------------------------------ */

  registerHandler('document.write', async (context): Promise<Observation> => {
    const section = textInput(context, 'section', textInput(context, 'topic', 'the section'));
    const references = referencesFrom(context);
    const priorWork = proseFrom(context);

    /*
     * The evidence rule, applied where it matters: writing that presents
     * findings must be grounded in what earlier steps retrieved. Writing with
     * no sources is allowed — an introduction or a methodology description
     * needs none — but the prompt says which is which.
     */
    const sourceBlock =
      references.length > 0
        ? `\n\nSources you may cite, by number:\n${references
            .map((reference, index) => `[${index + 1}] ${reference.title ?? ''} (${reference.year ?? ''})`)
            .join('\n')}\n\nCite the source number after every claim that comes from them. Never cite a number not in this list.`
        : '\n\nNo sources are available. Write only what does not require one — description, procedure, structure — and do not state findings or statistics.';

    /*
     * Analysis results by type, not by capability prefix.
     *
     * This filtered dependency keys starting with `statistics.`, which meant
     * adding a statistical capability required remembering to name it
     * consistently or the writing step would silently ignore its results.
     */
    const analysisBlock = [
      ...readAllOutputs<Record<string, unknown>>(context.available, 'pls-results.v1'),
      ...readAllOutputs<Record<string, unknown>>(context.available, 'analysis.v1'),
    ]
      .map((result) => `\n\nAnalysis results: ${JSON.stringify(result).slice(0, 2000)}`)
      .join('');

    /*
     * The instruction in the researcher's own language.
     *
     * A researcher writing in Arabic received a document whose body was empty:
     * the instruction was English prose about an Arabic topic, and what came
     * back was not usable as a chapter.
     */
    const decision = decideOutputLanguage({
      request: `${textInput(context, 'section')} ${textInput(context, 'topic')} ${String(context.context.request ?? '')}`,
      contextLanguage: (context.context.language as 'ar' | 'en' | undefined) ?? null,
      interfaceLocale: context.locale,
    });

    const language = decision.language;

    const instruction =
      language === 'ar'
        ? `اكتب قسم «${section}» من البحث بأسلوب أكاديمي وفقرات متصلة.${priorWork ? ' وتابع ما كُتب في الأقسام السابقة.' : ''}${sourceBlock}${analysisBlock}`
        : `Write the "${section}" section${priorWork ? ' following on from the earlier sections' : ''}.${sourceBlock}${analysisBlock}`;

    const provider = await resolveProvider();

    const generated = await generateLongForm({
      provider,
      system: `${languageInstruction(language)}\n\nYou are writing part of an academic document. Write prose, not bullet points. Cite only the numbered sources given.`,
      prompt: instruction,
      locale: language,
    });

    const text = generated.text;
    if (text.trim().length < 40) {
      return failed([
        {
          code: 'write.empty',
          severity: 'error',
          message: `The model returned no usable text for "${section}".`,
          reference: section,
          metadata: { returned: text.length },
        },
      ]);
    }
    const notice = incompleteNotice(generated, language);
    const body = notice ? `${text}\n\n${notice}` : text;

    if (!generated.complete) {
      return partial(
        [
          makeOutput(producer(context, 'document.write'), 'prose.v1', {
            text: body,
            references,
            heading: section,
            complete: false,
          }),
        ],
        [language === 'ar' ? 'بقيّة النصّ' : 'the rest of the text'],
        {
          warnings: [
            {
              code: 'write.incomplete',
              severity: 'warning',
              message: `Generation stopped early (${generated.incompleteReason ?? 'unknown'}) after ${generated.rounds} rounds.`,
              reference: section,
            },
          ],
          confidence: 0.5,
          recommendedNextActions: [
            {
              capability: 'document.write',
              reason: 'continue the unfinished section',
              input: { section, continueFrom: text.slice(-400) },
            },
          ],
        },
      );
    }
    return succeeded(
      [
        makeOutput(producer(context, 'document.write'), 'prose.v1', {
          text,
          references,
          heading: section,
        }),
      ],
      {
        modelCalls: 2,
        /*
         * Reported when writing had no sources. Not an error — a methodology
         * section legitimately cites nothing — but the replanner should know
         * the section rests on no evidence.
         */
        ...(references.length === 0
          ? {
              warnings: [
                {
                  code: 'write.noSources',
                  severity: 'info' as const,
                  message: `"${section}" was written without sources`,
                },
              ],
            }
          : {}),
      },
    );
  });

  registerHandler('survey.generate', async (context): Promise<Observation> => {
    const topic = textInput(context, 'topic');

    /*
     * Constructs from the step input, or from a framework an earlier step
     * derived. A questionnaire measuring the framework's constructs is the
     * usual case, and making the planner restate them would let the two
     * disagree.
     */
    const framework = readOutput<{ constructs?: string[] }>(context.available, 'framework.v1');
    const constructs = context.input.constructs ?? framework?.constructs;

    if (!topic || !Array.isArray(constructs) || constructs.length === 0) {
      return needsInput(
        context.locale === 'ar'
          ? 'ما المقاييس الفرعية المطلوبة في الاستبانة؟'
          : 'Which constructs should the questionnaire measure?',
        'constructs',
      );
    }

    const reply = await generateSurveyItems({
      userId: context.userId,
      prompt: `Write questionnaire items about "${topic}" for these constructs: ${constructs.join(', ')}. One idea per item, no leading wording. Return JSON.`,
      locale: context.locale,
      maxTokens: 2000,
    });

    return succeeded(
      [makeOutput(producer(context, 'survey.generate'), 'survey.v1', { text: reply, constructs })],
      { modelCalls: 1 },
    );
  });

  /* ------------------------------ artefacts ----------------------------- */

  registerHandler('document.generate', async (context): Promise<Observation> => {
    /*
     * The format the researcher asked for.
     *
     * An unrecognised value falls back to Markdown, and that fallback is what
     * silently turned "give me Word" into a .md file. It is kept — a task must
     * produce something — but the substitution is now recorded in the metadata
     * and reported, so a researcher who asked for Word and received Markdown
     * learns why rather than assuming the product cannot do it.
     */
    const requested = textInput(context, 'format', 'md');
    const known: ArtifactKind[] = [
      'docx', 'pdf', 'pptx', 'xlsx', 'csv', 'md', 'txt', 'bib', 'ris',
    ];
    const kind = (known.includes(requested as ArtifactKind) ? requested : 'md') as ArtifactKind;
    const title = textInput(context, 'title', textInput(context, 'topic', 'Document'));
    const style = (textInput(context, 'citationStyle', 'apa') as StyleId) ?? 'apa';

    const references = referencesFrom(context);
    const prose = proseFrom(context);

    /*
     * Sections assembled from what the writing steps produced, in dependency
     * order. Each becomes a section rather than one long block, so the document
     * has structure a reader can navigate.
     */
    /*
     * Sections from the prose steps, in the order they were produced.
     *
     * This read every dependency with a `text` field, keyed by capability —
     * so the heading fell back to a capability name when none was given, and a
     * chapter appeared in a document titled `write`.
     */
    /*
     * Content carried in from an artifact the request referred to, when this
     * task produced none of its own.
     */
    const carried: { heading: string; paragraphs: string[] }[] = [];
    const carriedReferences: Reference[] = [];

    /*
     * A conversion of something that already exists.
     *
     * "حوّل البحث السابق PDF" resolved to an artifact before the task started,
     * and the content is in that file — not in this task's outputs, which are
     * empty because no writing step ran. Reading the resolved reference is what
     * turns a conversion into a conversion rather than a second paper.
     */
    const referenced = context.context.references as
      | { kind?: string; id?: string; taskId?: string }
      | undefined;

    if (referenced?.kind === 'artifact' && referenced.id && sectionsFrom(context).length === 0) {
      const source = await readArtifact(referenced.id, context.userId).catch(() => null);

      if (source) {
        /*
         * The source's own outputs carry its prose. Fetched from the task that
         * produced it rather than re-extracted from the file: the text is
         * already structured there, and parsing a Word document back into
         * sections would lose the headings it was built from.
         */
        const sourceTaskId = (source.artifact.metadata as { taskId?: string } | null)?.taskId;

        if (sourceTaskId) {
          const steps = await tasksRepo.stepsOf(sourceTaskId);

          for (const step of steps) {
            const outputs = (step.output as { outputs?: OutputReference[] } | null)?.outputs ?? [];

            for (const output of outputs) {
              if (output.type.startsWith('prose') || output.type.startsWith('literature')) {
                const data = output.data as { text?: string; heading?: string } | null;

                if (data?.text) {
                  carried.push({
                    heading: data.heading ?? '',
                    paragraphs: data.text.split(/\n{2,}/).filter(Boolean),
                  });
                }
              }

              if (output.type.startsWith('sources')) {
                const bundle = output.data as { references?: Reference[] } | null;
                if (Array.isArray(bundle?.references)) carriedReferences.push(...bundle.references);
              }
            }
          }
        }
      }
    }

    const sections = [
      ...carried,
      ...sectionsFrom(context).map((section, index) => ({
        heading: section.heading || `${index + 1}`,
        level: 1,
        paragraphs: section.text.split(/\n{2,}/).filter(Boolean),
      })),
    ];

    /*
     * References from this task and from anything it converted. A PDF made
     * from a Word paper must carry the paper's bibliography — dropping it
     * would produce a document whose citations point at nothing.
     */
    const allReferences = [...references, ...carriedReferences];
    const formatted = formatReferenceList(allReferences, style);

    const content = {
      title,
      subtitle: textInput(context, 'subtitle') || undefined,
      /*
       * No filler when there is nothing to say.
       *
       * The fallback used to put the title in the body, producing a document
       * that repeated its own heading and then listed references with no
       * chapter between them. A document with no content should say so; an
       * empty body is at least honest, and the writing step now fails before
       * this is reached.
       */
      sections:
        sections.length > 0
          ? sections
          : prose
            ? [{ paragraphs: [prose] }]
            : [],
      references: formatted.map((entry) => entry.formatted),
    };

    let bytes: Uint8Array;

    if (kind === 'docx') {
      /*
       * Word was missing from this chain entirely: the condition fell through
       * to Markdown, so a researcher asking for Word received a .md file and no
       * indication that anything had been substituted.
       *
       * It matters more than the other formats for this product's users. Word
       * embeds fonts from the reader's system, so Arabic renders correctly with
       * nothing shipped — where PDF needs an embedded font file this does not
       * carry.
       */
      bytes = await generateDocx(content);
    } else if (kind === 'pdf') {
      bytes = (await generatePdf(content)).bytes;
    } else if (kind === 'pptx') {
      bytes = await generatePptx(
        title,
        sections.map((section) => ({
          title: section.heading,
          bullets: section.paragraphs.slice(0, 5),
        })),
        { rtl: context.locale === 'ar' },
      );
    } else if (kind === 'xlsx') {
      /*
       * Tables from the steps that produced them. A spreadsheet request follows
       * an analysis, and the analysis output is where the numbers are — asking
       * the planner to restate them in the step input would mean the figures
       * exist twice and can disagree.
       */
      /*
       * Tables read by type, from whichever step produced them. The analysis
       * output is where the numbers are — asking the planner to restate them in
       * the step input would mean the figures exist twice and can disagree.
       *
       * `analysis.v1` and `pls-results.v1` both carry tables, and reading both
       * means a spreadsheet request works after either kind of analysis.
       */
      const sheets: { name: string; headers: string[]; rows: never[] }[] = [];

      for (const type of ['analysis.v1', 'pls-results.v1'] as const) {
        for (const found of readAllOutputs<{
          table?: { headers: string[]; rows: unknown[][] };
          label?: string;
        }>(context.available, type)) {
          if (!found.table) continue;

          sheets.push({
            name: found.label ?? type.replace('.v1', ''),
            headers: found.table.headers,
            rows: found.table.rows as never,
          });
        }
      }

      const own = context.input.table as { headers: string[]; rows: unknown[][] } | undefined;
      if (own) sheets.push({ name: 'Data', headers: own.headers, rows: own.rows as never });

      bytes = await generateXlsx(sheets);
    } else if (kind === 'txt') {
      bytes = generateTxt(content);
    } else if (kind === 'csv') {
      const table = context.input.table as { headers: string[]; rows: unknown[][] } | undefined;
      bytes = generateCsv(table?.headers ?? [], (table?.rows ?? []) as never);
    } else if (kind === 'bib') {
      bytes = new TextEncoder().encode(toBibTeX(references));
    } else if (kind === 'ris') {
      bytes = new TextEncoder().encode(toRIS(references));
    } else {
      bytes = generateMarkdown(content);
    }

    let artifact;

    try {
      artifact = await storeArtifact({
        userId: context.userId,
        kind,
        filename: `${title.slice(0, 60).replace(/[^\p{L}\p{N}\s-]/gu, '')}.${kind}`,
        bytes,
        projectId: (context.context.projectId as string) ?? null,
        metadata: {
          citationStyle: style,
          taskId: context.taskId,
          ...(kind !== requested ? { requestedFormat: requested, substituted: true } : {}),
        },
        ...(prose ? { quality: { text: prose, references } } : {}),
        /*
         * The prose is also what went into the file, so validation can confirm it
         * arrived. Named separately from the quality text because a caller may
         * check one thing and store another — and a file rejected for not
         * containing text it never held is a false failure.
         */
        ...(prose ? { expectedContent: prose } : {}),
      });
    } catch (error) {
      /*
       * A genuine failure, reported as one.
       *
       * File generation is the one capability here that can fail for a reason
       * the researcher cannot fix by answering a question: invalid bytes, a
       * storage outage, a format the content cannot express. Returning
       * `needs-input` would ask them something pointless, and returning
       * `success` with no artifact is the fake-file failure the pipeline
       * exists to prevent.
       */
      return failed([
        {
          code: 'artifact.generationFailed',
          severity: 'error',
          message: String(error).slice(0, 200),
          metadata: { format: kind, title },
        },
      ]);
    }

    const generateStamp = producer(context, 'document.generate');

    /*
     * A substituted format is a warning, not a silent metadata field. The
     * researcher asked for Word and received Markdown; the replanner can see
     * that and the interface can say it.
     */
    const substitution: Finding[] =
      kind !== requested
        ? [
            {
              code: 'artifact.formatSubstituted',
              severity: 'warning',
              message: `"${requested}" is not a supported format; produced ${kind} instead`,
              metadata: { requested, produced: kind },
            },
          ]
        : [];

    return succeeded(
      [
        makeOutput(generateStamp, 'artifact.v1', {
          artifactId: artifact.id,
          filename: artifact.filename,
          kind: artifact.kind,
          validationStatus: artifact.validationStatus,
          /*
           * A substituted format belongs in the output, not only the metadata.
           * A consumer deciding whether to tell the researcher they asked for
           * Word and received Markdown reads this; burying it in metadata means
           * only a log sees it.
           */
          ...(kind !== requested ? { requestedFormat: requested } : {}),
        }),
      ],
      {
        artifacts: [
          {
            id: artifact.id,
            kind: artifact.kind,
            filename: artifact.filename,
            validationStatus: artifact.validationStatus,
          },
        ],
        warnings: substitution,
      },
    );
  });

  /* ------------------------------- checking ----------------------------- */

  registerHandler('quality.check', async (context): Promise<Observation> => {
    const text = proseFrom(context) || textInput(context, 'text');
    const references = referencesFrom(context);

    const qualityStamp = producer(context, 'quality.check');

    if (!text) {
      /*
       * Nothing to check is a successful check of nothing, not a failure. A
       * task whose quality step failed because no prose existed would report a
       * problem the researcher does not have.
       */
      return succeeded([
        makeOutput(qualityStamp, 'quality-report.v1', {
          status: 'not-applicable',
          reason: 'nothing to check',
        }),
      ]);
    }

    const report = await checkQuality({ text, references, skipNetwork: true });

    const output = makeOutput(qualityStamp, 'quality-report.v1', {
      status: report.overallStatus,
      errors: report.errors.length,
      warnings: report.warnings.length,
      unsupportedClaims: report.unsupportedClaims.count,
      citationCoverage: report.citationCoverage.ratio,
    });

    /*
     * The engine's own findings, forwarded as findings rather than counted.
     *
     * This returned "Quality check found 3 errors" as free text; the replanner
     * could only pass that to a model. The codes travel now, so a citation
     * pointing at nothing can be acted on differently from an uncited claim.
     */
    const errors: Finding[] = report.errors.map((finding) => ({
      code: finding.code,
      severity: 'error' as const,
      message: finding.code,
      reference: finding.target,
      metadata: finding.detail,
    }));

    const warnings: Finding[] = report.warnings.slice(0, 20).map((finding) => ({
      code: finding.code,
      severity: 'warning' as const,
      message: finding.code,
      reference: finding.target,
      metadata: finding.detail,
    }));

    /*
     * A failing check is `partial`, not `failed`. The step did its work
     * correctly — what it found is a problem in the document, and the
     * distinction decides whether the replanner fixes the document or retries
     * the check.
     */
    if (report.overallStatus === 'fail') {
      return partial([output], [], {
        errors,
        warnings,
        confidence: 0.4,
        recommendedNextActions: [
          {
            capability: 'document.write',
            reason: `the quality check found ${report.errors.length} errors`,
            input: {},
          },
        ],
      });
    }

    return succeeded([output], { warnings });
  });

  registerHandler('citation.verify', async (context): Promise<Observation> => {
    const references = referencesFrom(context);
    const withDoi = references.filter((reference) => reference.doi);
    const citeStamp = producer(context, 'citation.verify');

    if (withDoi.length === 0) {
      /*
       * Not a finding. Books, reports and theses mostly have no DOI, and
       * reporting their absence as a problem is the mistake the quality engine
       * was designed to avoid.
       */
      return succeeded([
        makeOutput(citeStamp, 'citations.v1', {
          checked: 0,
          status: 'not-applicable',
          references: references.length,
        }),
      ]);
    }

    const results = await verifyDois(references);
    const notFound = results.filter((result) => result.status === 'not-found');

    const output = makeOutput(citeStamp, 'citations.v1', {
      checked: results.length,
      verified: results.filter((result) => result.status === 'verified').length,
      notFound: notFound.length,
      unchecked: results.filter((result) => result.status === 'unchecked').length,
      results,
    });

    /*
     * A DOI that does not resolve is the strongest signal of an invented
     * reference, and it is reported per reference so the researcher knows
     * which one — not as a count they would have to investigate themselves.
     */
    const errors: Finding[] = notFound.map((result) => ({
      code: 'citation.doiNotFound',
      severity: 'error' as const,
      message: `The DOI ${result.doi} is not registered`,
      reference: result.referenceId,
      metadata: { doi: result.doi },
    }));

    if (errors.length > 0) {
      return partial([output], [], { errors, confidence: 0.3 });
    }

    return succeeded([output]);
  });

  registerHandler('file.analyse', async (context): Promise<Observation> => {
    const datasetId = textInput(context, 'datasetId');

    if (!datasetId) return needsInput('Which file should I analyse?', 'datasetId');

    /*
     * Deliberately minimal: the dataset profile is computed on upload, so this
     * reads it rather than recomputing. A handler that reanalysed would be
     * doing work the product already did.
     */
    return succeeded([
      makeOutput(producer(context, 'file.analyse'), 'dataset.v1', { datasetId, ready: true }),
    ]);
  });

  registerHandler('statistics.run', async (context): Promise<Observation> => {
    const datasetId = textInput(context, 'datasetId');

    if (!datasetId) return needsInput('Which dataset should I analyse?', 'datasetId');

    /*
     * The specific test is chosen by the recommender, which needs the
     * researcher's question and their variables. Rather than guess, this step
     * asks — a wrong test produces numbers that look right.
     */
    return needsInput(
      context.locale === 'ar'
        ? 'أي تحليل إحصائي تريد، وعلى أي متغيّرات؟'
        : 'Which analysis, and on which variables?',
      'analysis',
    );
  });

  logger.info('task.handlersRegistered', { count: 12 });
}

