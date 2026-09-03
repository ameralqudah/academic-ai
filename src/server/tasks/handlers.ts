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
import { storeArtifact, type ArtifactKind } from '@/server/services/artifact.service';
import { answerGeneralQuestion, generateSurveyItems } from '@/server/services/ai.service';
import { runCbSem, runPls } from '@/server/services/pls.service';
import { searchWeb } from '@/server/services/web-search.service';
import { registerHandler, type StepContext, type StepResult } from './executor';

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

  for (const output of Object.values(context.dependencies)) {
    const references = output.references;
    if (Array.isArray(references)) collected.push(...(references as Reference[]));
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

  for (const output of Object.values(context.dependencies)) {
    if (typeof output.text === 'string') parts.push(output.text);
  }

  return parts.join('\n\n');
}

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

export function registerAllHandlers(): void {
  /* --------------------------- general answer --------------------------- */

  registerHandler('general.answer', async (context): Promise<StepResult> => {
    const question = textInput(context, 'question', textInput(context, 'topic'));

    if (!question) {
      return { output: {}, needsUserInput: 'What would you like me to answer?' };
    }

    const answer = await answerGeneralQuestion({
      userId: context.userId,
      message: question,
      locale: context.locale,
      projectId: null,
      history: [],
    });

    return { output: { text: answer }, modelCalls: 1 };
  });

  /* ------------------------------ web search ---------------------------- */

  registerHandler('web.search', async (context): Promise<StepResult> => {
    const query = textInput(context, 'query', textInput(context, 'topic'));

    if (!query) return { output: {}, needsUserInput: 'What should I search for?' };

    const result = await searchWeb({
      userId: context.userId,
      query,
      locale: context.locale,
    });

    return {
      output: {
        text: result.answer,
        /*
         * Sources without their page text. A dependent step needs to cite
         * them, not to re-read them — and eight full pages in a step's input
         * is thousands of tokens on every call that follows.
         */
        references: result.sources.map((source) => ({
          id: String(source.index),
          kind: 'website' as const,
          title: source.title,
          url: source.url,
          container: source.container,
          provenance: 'retrieved' as const,
        })),
        found: result.sources.length,
      },
      modelCalls: 1,
    };
  });

  /* --------------------------- academic search -------------------------- */

  registerHandler('academic.search', async (context): Promise<StepResult> => {
    const query = textInput(context, 'query', textInput(context, 'topic'));

    if (!query) return { output: {}, needsUserInput: 'What topic should I search for?' };

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

    return {
      output: {
        references,
        found: references.length,
        offTopic: report.offTopic,
        discarded: report.discardedAsIrrelevant,
      },
      ...(report.offTopic
        ? {
            suggestsMoreWork: `The results for "${query}" do not appear to concern the topic; the query may need rephrasing`,
          }
        : thin
          ? { suggestsMoreWork: `Only ${references.length} sources found for "${query}"` }
          : {}),
      modelCalls: 1,
    };
  });

  /* --------------------------- deep research ---------------------------- */

  registerHandler('deep.research', async (context): Promise<StepResult> => {
    const question = textInput(context, 'question', textInput(context, 'topic'));

    if (!question) return { output: {}, needsUserInput: 'What should I research?' };

    const report = await runDeepResearch({
      userId: context.userId,
      question,
      locale: context.locale,
      shouldStop: () => context.signal.aborted,
    });

    return {
      output: {
        text: report.report,
        references: report.sources.map((source) => ({
          id: String(source.index),
          kind: source.kind === 'academic' ? ('journal-article' as const) : ('website' as const),
          title: source.title,
          url: source.url,
          doi: source.doi,
          year: source.year,
          provenance: 'retrieved' as const,
        })),
        /* Carried forward so the final document can state its limitations. */
        gaps: report.remainingGaps,
      },
      modelCalls: 8,
    };
  });

  /* -------------------------- literature review ------------------------- */

  registerHandler('literature.review', async (context): Promise<StepResult> => {
    const references = referencesFrom(context);

    /*
     * A search that found the wrong corpus is refused as firmly as one that
     * found nothing. A review written from ten papers on another subject is
     * worse than no review: it looks like work and is unusable.
     */
    const offTopic = Object.values(context.dependencies).some(
      (output) => output.offTopic === true,
    );

    if (offTopic) {
      return {
        output: { error: 'off-topic-sources' },
        needsUserInput:
          context.locale === 'ar'
            ? 'المصادر التي وجدتها لا تتناول الموضوع المطلوب. هل تريد صياغة أخرى للبحث؟'
            : 'The sources I found do not concern this topic. Would you like to rephrase the search?',
      };
    }

    if (references.length === 0) {
      /*
       * Refused rather than written. A literature review with no literature is
       * the exact failure the evidence rules exist to prevent — the model would
       * write something fluent and cite work it invented.
       */
      return {
        output: { error: 'no-sources' },
        needsUserInput:
          context.locale === 'ar'
            ? 'لم أجد مصادر لكتابة المراجعة. هل تريد توسيع نطاق البحث؟'
            : 'No sources were found to review. Should I broaden the search?',
      };
    }

    const topic = textInput(context, 'topic', 'the topic');

    const text = await answerGeneralQuestion({
      userId: context.userId,
      message:
        context.locale === 'ar'
          ? `اكتب مراجعة أدبيات عن «${topic}» من المصادر المرقّمة أدناه وحدها. استشهد برقم المصدر بعد كل معلومة. اذكر التعارضات والثغرات صراحةً.\n\n${references.map((reference, index) => `[${index + 1}] ${reference.title ?? ''} (${reference.year ?? ''})`).join('\n')}`
          : `Write a literature review of "${topic}" using only the numbered sources below. Cite the source number after each claim. State disagreements and gaps explicitly.\n\n${references.map((reference, index) => `[${index + 1}] ${reference.title ?? ''} (${reference.year ?? ''})`).join('\n')}`,
      locale: context.locale,
      projectId: null,
      history: [],
    });

    return { output: { text, references }, modelCalls: 2 };
  });

  /* ---------------------------- data analysis --------------------------- */

  registerHandler('statistics.pls', async (context): Promise<StepResult> => {
    const datasetId = textInput(context, 'datasetId');
    const model = context.input.model;

    if (!datasetId) {
      return { output: {}, needsUserInput: 'Which dataset should I analyse?' };
    }

    if (!model) {
      /*
       * A PLS model is the researcher's theory. Guessing one would produce
       * numbers for a study nobody is running.
       */
      return {
        output: {},
        needsUserInput:
          context.locale === 'ar'
            ? 'ما نموذج PLS؟ حدّد المتغيّرات الكامنة والمسارات بينها.'
            : 'What is the PLS model? Name the constructs and the paths between them.',
      };
    }

    const analysis = await runPls({
      datasetId,
      userId: context.userId,
      model: model as never,
    });

    return {
      output: {
        /*
         * The report's verdict and sections, not the raw estimate. A later step
         * cites what the analysis concluded; the loading matrix would be
         * thousands of tokens it cannot use.
         */
        verdict: analysis.report.verdict,
        sections: analysis.report.sections.map((section) => ({
          titleKey: section.titleKey,
          findings: section.findings.length,
        })),
        n: analysis.n,
      },
    };
  });

  registerHandler('statistics.cbsem', async (context): Promise<StepResult> => {
    const datasetId = textInput(context, 'datasetId');
    const model = context.input.model;

    if (!datasetId || !model) {
      return {
        output: {},
        needsUserInput:
          context.locale === 'ar'
            ? 'ما نموذج القياس؟ حدّد المتغيّرات الكامنة وبنودها.'
            : 'What is the measurement model? Name the factors and their indicators.',
      };
    }

    const result = await runCbSem({ datasetId, userId: context.userId, model: model as never });

    return {
      output: {
        fit: result.fit,
        loadings: result.loadings.map((loading) => ({
          construct: loading.construct,
          indicator: loading.indicator,
          standardised: loading.standardised,
        })),
        n: result.n,
      },
    };
  });

  /* ------------------------------- writing ------------------------------ */

  registerHandler('document.write', async (context): Promise<StepResult> => {
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

    const analysisBlock = Object.entries(context.dependencies)
      .filter(([capability]) => capability.startsWith('statistics.'))
      .map(([capability, output]) => `\n\nResults from ${capability}: ${JSON.stringify(output).slice(0, 2000)}`)
      .join('');

    const text = await answerGeneralQuestion({
      userId: context.userId,
      message: `Write the "${section}" section${priorWork ? ' following on from the earlier sections' : ''}.${sourceBlock}${analysisBlock}`,
      locale: context.locale,
      projectId: null,
      history: [],
    });

    return { output: { text, references }, modelCalls: 2 };
  });

  registerHandler('survey.generate', async (context): Promise<StepResult> => {
    const topic = textInput(context, 'topic');
    const constructs = context.input.constructs;

    if (!topic || !Array.isArray(constructs) || constructs.length === 0) {
      return {
        output: {},
        needsUserInput:
          context.locale === 'ar'
            ? 'ما المقاييس الفرعية المطلوبة في الاستبانة؟'
            : 'Which constructs should the questionnaire measure?',
      };
    }

    const reply = await generateSurveyItems({
      userId: context.userId,
      prompt: `Write questionnaire items about "${topic}" for these constructs: ${constructs.join(', ')}. One idea per item, no leading wording. Return JSON.`,
      locale: context.locale,
      maxTokens: 2000,
    });

    return { output: { text: reply }, modelCalls: 1 };
  });

  /* ------------------------------ artefacts ----------------------------- */

  registerHandler('document.generate', async (context): Promise<StepResult> => {
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
    const sections = Object.entries(context.dependencies)
      .filter(([, output]) => typeof output.text === 'string')
      .map(([capability, output]) => ({
        heading: (output.heading as string) ?? capability.replace(/^\w+\./, ''),
        level: 1,
        paragraphs: String(output.text).split(/\n{2,}/).filter(Boolean),
      }));

    const formatted = formatReferenceList(references, style);

    const content = {
      title,
      subtitle: textInput(context, 'subtitle') || undefined,
      sections: sections.length > 0 ? sections : [{ paragraphs: [prose || title] }],
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
      const sheets = Object.entries(context.dependencies)
        .filter(([, output]) => output.table)
        .map(([capability, output]) => {
          const table = output.table as { headers: string[]; rows: unknown[][] };
          return {
            name: capability.replace(/^\w+\./, ''),
            headers: table.headers,
            rows: table.rows as never,
          };
        });

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

    const artifact = await storeArtifact({
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

    return {
      output: {
        artifactId: artifact.id,
        filename: artifact.filename,
        kind: artifact.kind,
        validationStatus: artifact.validationStatus,
        /* Surfaced rather than hidden: the user asked for something else. */
        ...(kind !== requested ? { requestedFormat: requested } : {}),
      },
      artifactIds: [artifact.id],
    };
  });

  /* ------------------------------- checking ----------------------------- */

  registerHandler('quality.check', async (context): Promise<StepResult> => {
    const text = proseFrom(context) || textInput(context, 'text');
    const references = referencesFrom(context);

    if (!text) return { output: { status: 'not-applicable', reason: 'nothing to check' } };

    const report = await checkQuality({ text, references, skipNetwork: true });

    /*
     * A failing check suggests more work rather than failing the step. The
     * check did its job; what it found is a reason to fix something, and the
     * planner decides whether that is worth a step.
     */
    return {
      output: {
        status: report.overallStatus,
        errors: report.errors.length,
        warnings: report.warnings.length,
        unsupportedClaims: report.unsupportedClaims.count,
      },
      ...(report.overallStatus === 'fail'
        ? { suggestsMoreWork: `Quality check found ${report.errors.length} errors` }
        : {}),
    };
  });

  registerHandler('citation.verify', async (context): Promise<StepResult> => {
    const references = referencesFrom(context);
    const withDoi = references.filter((reference) => reference.doi);

    if (withDoi.length === 0) {
      /*
       * Not a finding. Books, reports and theses mostly have no DOI, and
       * reporting their absence as a problem is the mistake the quality engine
       * was designed to avoid.
       */
      return { output: { checked: 0, status: 'not-applicable' } };
    }

    const results = await verifyDois(references);

    return {
      output: {
        checked: results.length,
        verified: results.filter((result) => result.status === 'verified').length,
        notFound: results.filter((result) => result.status === 'not-found').length,
        unchecked: results.filter((result) => result.status === 'unchecked').length,
      },
    };
  });

  registerHandler('file.analyse', async (context): Promise<StepResult> => {
    const datasetId = textInput(context, 'datasetId');

    if (!datasetId) return { output: {}, needsUserInput: 'Which file should I analyse?' };

    /*
     * Deliberately minimal: the dataset profile is computed on upload, so this
     * reads it rather than recomputing. A handler that reanalysed would be
     * doing work the product already did.
     */
    return { output: { datasetId, ready: true } };
  });

  registerHandler('statistics.run', async (context): Promise<StepResult> => {
    const datasetId = textInput(context, 'datasetId');

    if (!datasetId) return { output: {}, needsUserInput: 'Which dataset should I analyse?' };

    /*
     * The specific test is chosen by the recommender, which needs the
     * researcher's question and their variables. Rather than guess, this step
     * asks — a wrong test produces numbers that look right.
     */
    return {
      output: {},
      needsUserInput:
        context.locale === 'ar'
          ? 'أي تحليل إحصائي تريد، وعلى أي متغيّرات؟'
          : 'Which analysis, and on which variables?',
    };
  });

  logger.info('task.handlersRegistered', { count: 12 });
}
