/**
 * The only place the application talks to a model.
 *
 * Every function follows the same seven steps: authorise → check quota → build
 * context → build prompt → call the provider → inspect the output → record usage.
 * Route handlers never skip a step because they never do any of it themselves.
 */

import { buildProjectContext } from '@/ai/context/builder';
import { labelFor } from '@/ai/context/labels';
import { inspectOutput, parseJsonOutput, type GuardrailResult } from '@/ai/guardrails';
import { buildResultsContext } from '@/ai/context/results';
import { generalPrompt } from '@/ai/prompts/general';
import { chatPrompt, sectionPrompt } from '@/ai/prompts/wizard';
import {
  titleComparisonPrompt,
  titleGenerationPrompt,
  titleImprovementPrompt,
} from '@/ai/prompts/titles';
import { resolveProvider } from '@/ai/registry';
import type { AIProvider } from '@/ai/provider';
import { AIProviderError, type AIChatMessage, type AITask, type ProjectContext } from '@/ai/types';
import { SECTION_BY_KEY, type SectionKey } from '@/config/research';
import { countWords } from '@/lib/text';
import { logger } from '@/lib/logger';
import type { ResearchProject, ResearchSection, TitleCandidate } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as analysisRunsRepo from '@/server/repositories/analysis-runs.repository';
import * as conversationsRepo from '@/server/repositories/conversations.repository';
import * as projectsRepo from '@/server/repositories/projects.repository';
import * as titlesRepo from '@/server/repositories/titles.repository';

import { getOwnedProject, getProjectWithSections, updateProject } from './project.service';
import { saveSection } from './section.service';
import { assertCanUseAI, recordAIUsage } from './usage.service';

/**
 * What the provider actually billed as input. Cached reads are cheap but they
 * are still tokens the researcher consumed, so the admin dashboard should see
 * them; the cost figure applies the cache discount separately.
 */
function billableInput(usage: {
  tokensIn: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}): number {
  return usage.tokensIn + (usage.cacheWriteTokens ?? 0) + (usage.cacheReadTokens ?? 0);
}

interface PreparedContext {
  project: ResearchProject;
  sections: ResearchSection[];
  context: ProjectContext;
  provider: AIProvider;
}

async function prepare(
  userId: string,
  projectId: string,
  focusSection?: SectionKey,
  estimatedWords = 0,
): Promise<PreparedContext> {
  await assertCanUseAI(userId, estimatedWords);

  const { project, sections } = await getProjectWithSections(projectId, userId);
  const provider = await resolveProvider();

  if (!provider.isConfigured()) {
    throw AppError.aiUnavailable(
      'No AI provider API key is configured. Set ANTHROPIC_API_KEY (or the key for your chosen AI_PROVIDER).',
    );
  }

  const context = buildProjectContext(project, sections, labelFor, { focusSection });
  return { project, sections, context, provider };
}

async function runCompletion(input: {
  userId: string;
  projectId: string;
  provider: AIProvider;
  task: AITask;
  system: string;
  messages: AIChatMessage[];
  locale: 'ar' | 'en';
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
}) {
  try {
    const result = await input.provider.complete({
      task: input.task,
      locale: input.locale,
      system: input.system,
      messages: input.messages,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      json: input.json,
    });

    await recordAIUsage({
      userId: input.userId,
      projectId: input.projectId,
      generatedWords: countWords(result.text),
      tokensIn: billableInput(result.usage),
      tokensOut: result.usage.tokensOut,
      costMicroUsd: input.provider.estimateCostMicroUsd(result.usage),
      provider: result.provider,
      model: result.model,
    });

    return result;
  } catch (error) {
    if (error instanceof AIProviderError) {
      logger.error('ai.provider.failed', {
        provider: error.provider,
        status: error.status,
        task: input.task,
      });
      throw AppError.aiUnavailable(error.message.slice(0, 400));
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/*                              Title generation                              */
/* -------------------------------------------------------------------------- */

interface RawTitle {
  title?: string;
  rationale?: string;
  researchProblem?: string;
  variables?: string[];
  fitScore?: number;
  innovationScore?: number;
}

function clampScore(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, Math.round(number)));
}

export async function generateTitles(
  userId: string,
  projectId: string,
  count = 10,
): Promise<TitleCandidate[]> {
  const { project, context, provider } = await prepare(userId, projectId, 'TITLE', 400);

  const result = await runCompletion({
    userId,
    projectId,
    provider,
    task: 'titles.generate',
    locale: project.language === 'AR' ? 'ar' : 'en',
    system: titleGenerationPrompt(context, count),
    messages: [
      {
        role: 'user',
        content: `Generate ${count} research titles for this project. Return JSON only.`,
      },
    ],
    maxTokens: 4000,
    temperature: 0.9,
    json: true,
  });

  const parsed = parseJsonOutput<{ titles?: RawTitle[] }>(result.text);
  const titles = (parsed?.titles ?? []).filter((entry) => typeof entry.title === 'string');

  if (titles.length === 0) {
    throw AppError.aiUnavailable('The provider did not return usable titles. Please try again.');
  }

  const batch = await titlesRepo.nextBatch(projectId);

  return titlesRepo.insertMany(
    titles.map((entry) => ({
      projectId,
      title: entry.title!.trim(),
      rationale: entry.rationale?.trim() ?? null,
      researchProblem: entry.researchProblem?.trim() ?? null,
      variables: Array.isArray(entry.variables) ? entry.variables.slice(0, 6) : [],
      fitScore: clampScore(entry.fitScore),
      innovationScore: clampScore(entry.innovationScore),
      batch,
    })),
  );
}

export async function improveTitle(
  userId: string,
  projectId: string,
  title: string,
): Promise<TitleCandidate[]> {
  const { project, context, provider } = await prepare(userId, projectId, 'TITLE', 200);

  const result = await runCompletion({
    userId,
    projectId,
    provider,
    task: 'titles.improve',
    locale: project.language === 'AR' ? 'ar' : 'en',
    system: titleImprovementPrompt(context),
    messages: [{ role: 'user', content: `Improve this title:\n\n${title}` }],
    maxTokens: 2000,
    temperature: 0.8,
    json: true,
  });

  const parsed = parseJsonOutput<{ titles?: RawTitle[] }>(result.text);
  const variants = (parsed?.titles ?? []).filter((entry) => typeof entry.title === 'string');
  if (variants.length === 0) {
    throw AppError.aiUnavailable('The provider did not return usable variants. Please try again.');
  }

  const batch = await titlesRepo.nextBatch(projectId);

  return titlesRepo.insertMany(
    variants.map((entry) => ({
      projectId,
      title: entry.title!.trim(),
      rationale: entry.rationale?.trim() ?? null,
      researchProblem: entry.researchProblem?.trim() ?? null,
      variables: Array.isArray(entry.variables) ? entry.variables.slice(0, 6) : [],
      fitScore: clampScore(entry.fitScore),
      innovationScore: clampScore(entry.innovationScore),
      batch,
    })),
  );
}

export interface TitleComparison {
  comparison: {
    title: string;
    strengths: string[];
    weaknesses: string[];
    feasibility: string;
    score: number;
  }[];
  recommendation: { title: string; reason: string };
}

export async function compareTitles(
  userId: string,
  projectId: string,
  titles: string[],
): Promise<TitleComparison> {
  const { project, context, provider } = await prepare(userId, projectId, 'TITLE', 300);

  const result = await runCompletion({
    userId,
    projectId,
    provider,
    task: 'titles.compare',
    locale: project.language === 'AR' ? 'ar' : 'en',
    system: titleComparisonPrompt(context),
    messages: [
      {
        role: 'user',
        content: `Compare these candidate titles:\n\n${titles
          .map((title, index) => `${index + 1}. ${title}`)
          .join('\n')}`,
      },
    ],
    maxTokens: 3000,
    temperature: 0.5,
    json: true,
  });

  const parsed = parseJsonOutput<TitleComparison>(result.text);
  if (!parsed?.comparison) {
    throw AppError.aiUnavailable('The provider did not return a usable comparison.');
  }
  return parsed;
}

/** Selecting a title updates the project and writes the TITLE section in one step. */
export async function selectTitle(
  userId: string,
  projectId: string,
  candidateId: string,
): Promise<{ title: string }> {
  await getOwnedProject(projectId, userId);
  const candidate = await titlesRepo.select(projectId, candidateId);

  await updateProject(projectId, userId, { title: candidate.title });
  await saveSection({
    projectId,
    userId,
    sectionKey: 'TITLE',
    content: candidate.title,
    status: 'APPROVED',
    origin: 'USER',
    note: 'Selected from generated titles',
  });

  return { title: candidate.title };
}

export async function listTitles(userId: string, projectId: string): Promise<TitleCandidate[]> {
  await getOwnedProject(projectId, userId);
  return titlesRepo.listForProject(projectId);
}

/* -------------------------------------------------------------------------- */
/*                            Section generation                              */
/* -------------------------------------------------------------------------- */

export interface GeneratedSection {
  sectionKey: SectionKey;
  content: string;
  wordCount: number;
  guardrails: GuardrailResult;
}

export async function generateSection(
  userId: string,
  projectId: string,
  sectionKey: SectionKey,
  instruction?: string,
): Promise<GeneratedSection> {
  const definition = SECTION_BY_KEY[sectionKey];
  const estimate = definition?.targetWords ?? 600;

  const { project, context, provider } = await prepare(userId, projectId, sectionKey, estimate);

  /*
   * Analyses the researcher deliberately attached to this section.
   *
   * Only attached ones: a researcher explores and discards, and everything they
   * ever ran travelling into the prompt would let a rejected analysis reappear
   * as a finding. Empty is the normal case and leaves the old behaviour exactly
   * as it was — the section produces a template and says the numbers must come
   * from their own analysis.
   */
  const attachedRuns = await analysisRunsRepo.listForSection(projectId, userId, sectionKey);
  const verifiedResults = buildResultsContext(attachedRuns);

  if (verifiedResults) {
    logger.info('ai.section.withVerifiedResults', {
      projectId,
      sectionKey,
      analyses: attachedRuns.length,
    });
  }

  const result = await runCompletion({
    userId,
    projectId,
    provider,
    task: 'wizard.section',
    locale: project.language === 'AR' ? 'ar' : 'en',
    system: sectionPrompt(sectionKey, context, instruction, verifiedResults),
    messages: [
      {
        role: 'user',
        content: instruction?.trim()
          ? instruction
          : `Write the "${labelFor(sectionKey)}" section for this project.`,
      },
    ],
    maxTokens: Math.min(8000, Math.max(1200, estimate * 4)),
    temperature: 0.6,
  });

  const guardrails = inspectOutput(result.text, {
    expectsNoStatistics: sectionKey !== 'RESULTS' && sectionKey !== 'CHAPTER_4',
  });

  await saveSection({
    projectId,
    userId,
    sectionKey,
    content: result.text,
    heading: labelFor(sectionKey),
    status: 'AI_SUGGESTED',
    origin: 'AI',
    note: instruction?.slice(0, 200),
  });

  return {
    sectionKey,
    content: result.text,
    wordCount: countWords(result.text),
    guardrails,
  };
}

/* -------------------------------------------------------------------------- */
/*                                    Chat                                    */
/* -------------------------------------------------------------------------- */

export interface ChatStreamHandle {
  stream: ReadableStream<Uint8Array>;
  conversationId: string;
}

/**
 * Streams a reply as Server-Sent Events and persists both messages plus usage
 * once the stream closes. The client never sees a provider-shaped payload.
 */
/**
 * Answers a question that is not about a specific project.
 *
 * Deliberately separate from `streamChat`, which requires a project and loads
 * its context. A researcher asking what separates Pearson from Spearman has no
 * project to load, and requiring one would mean either refusing the question or
 * inventing a container to hold it.
 *
 * It uses `generalPrompt` rather than the academic block — see that file for
 * why. The short version: the academic prompt opens by instructing the model to
 * decline anything unrelated to the user's research, which is correct for
 * writing a chapter and wrong for answering a question.
 */
export async function answerGeneralQuestion(input: {
  /**
   * A model the user selected, already checked against their plan.
   *
   * Passed through to the provider resolver rather than re-validated: the check
   * belongs at the boundary, and doing it twice creates two places for the rule
   * to diverge.
   */
  chosenModel?: { provider: 'anthropic' | 'openai' | 'google'; model: string } | null;
  userId: string;
  message: string;
  locale: 'ar' | 'en';
  projectId?: string | null;
  projectTitle?: string | null;
  history?: AIChatMessage[];
}): Promise<{ content: string; usage: { tokensIn: number; tokensOut: number } }> {
  await assertCanUseAI(input.userId, 400);

  const provider = await resolveProvider(input.chosenModel ?? null);

  const result = await runCompletion({
    userId: input.userId,
    // Usage is recorded against the project when one is selected, and against
    // the user alone when none is — the column is nullable for exactly this.
    projectId: input.projectId ?? '',
    provider,
    task: 'chat',
    locale: input.locale,
    system: generalPrompt({ locale: input.locale, projectTitle: input.projectTitle ?? null }),
    messages: [...(input.history ?? []).slice(-6), { role: 'user', content: input.message }],
    maxTokens: 2000,
    temperature: 0.6,
  });

  return { content: result.text, usage: result.usage };
}

/**
 * Reads a structural model out of a researcher's description.
 *
 * Temperature at zero, which is unusual here and deliberate: this is a parsing
 * task with one right answer, not a writing task. Two researchers describing
 * the same model should get the same structure, and the same researcher asking
 * twice should not get two.
 *
 * A small token budget for the same reason — the reply is a short JSON object,
 * and a generous budget invites the explanation the prompt asks it not to give.
 */
export async function extractModelStructure(input: {
  userId: string;
  description: string;
  locale: 'ar' | 'en';
  system: string;
}): Promise<{ text: string; usage: { tokensIn: number; tokensOut: number } }> {
  await assertCanUseAI(input.userId, 200);

  const provider = await resolveProvider();

  const result = await runCompletion({
    userId: input.userId,
    projectId: '',
    provider,
    task: 'chat',
    locale: input.locale,
    system: input.system,
    messages: [{ role: 'user', content: input.description }],
    maxTokens: 600,
    temperature: 0,
  });

  return { text: result.text, usage: result.usage };
}

/**
 * Answers a question from web sources that were actually retrieved.
 *
 * The rules are the ones the literature summary uses, because the failure they
 * prevent is the same: asked about a topic, a model will add a claim it
 * half-remembers, phrased exactly like the ones that came from a source, and
 * the reader has no way to tell them apart. The defence is a closed set and a
 * requirement to cite — every sentence carries the number of the source it came
 * from, or it is not written.
 *
 * One rule is specific to web sources and matters for a research tool: these
 * are pages, not peer-reviewed work, and the answer says so rather than letting
 * a student cite a blog post as though it were a study.
 */
export async function answerFromSources(input: {
  userId: string;
  question: string;
  locale: 'ar' | 'en';
  sources: {
    index: number;
    title: string;
    url: string;
    site: string;
    content: string;
    full: boolean;
  }[];
}): Promise<string> {
  await assertCanUseAI(input.userId, 800);

  const provider = await resolveProvider();

  const rendered = input.sources
    .map(
      (source) =>
        `[${source.index}] ${source.title}\n` +
        `Site: ${source.site}\n` +
        `URL: ${source.url}\n` +
        `${source.full ? 'Full page text' : 'Search snippet only'}:\n${source.content.slice(0, 6000)}`,
    )
    .join('\n\n---\n\n');

  const system =
    input.locale === 'ar'
      ? `أنت مساعد بحثي. أجب عن سؤال الباحث اعتمادًا على المصادر المرقّمة أدناه وحدها.

القواعد:
- استشهد برقم المصدر بعد كل معلومة، هكذا [1] أو [2][3].
- لا تذكر أي معلومة ليست في المصادر، مهما بدت لك صحيحة.
- إن لم تكفِ المصادر للإجابة، قل ذلك صراحةً وحدّد ما ينقص.
- ميّز بين ما ورد في نصّ الصفحة كاملًا وما ورد في مقتطف بحث فقط.
- نبّه في نهاية الإجابة أن هذه مصادر من الويب وليست مراجع علمية محكّمة، وأن الاستشهاد الأكاديمي يحتاج مصادر أكاديمية.`
      : `You are a research assistant. Answer the researcher's question using only the numbered sources below.

Rules:
- Cite the source number after each claim, like [1] or [2][3].
- Never state anything that is not in the sources, however certain it seems.
- If the sources do not answer the question, say so and name what is missing.
- Distinguish what came from a full page from what came from a search snippet only.
- End by noting that these are web sources rather than peer-reviewed references, and that academic citation needs academic sources.`;

  const result = await runCompletion({
    userId: input.userId,
    projectId: '',
    provider,
    task: 'chat',
    locale: input.locale,
    system,
    messages: [
      { role: 'user', content: `Question: ${input.question}\n\nSources:\n\n${rendered}` },
    ],
    maxTokens: 1600,
    /* Low: this is reporting what sources say, not composing. */
    temperature: 0.3,
  });

  return result.text;
}

/**
 * Breaks a research question into sub-questions worth searching separately.
 *
 * The step that makes deep research different from one long search. "How does
 * remote work affect productivity" searched directly returns opinion pieces;
 * split into "measured productivity effects", "moderating factors", "measurement
 * methods" and "contradictory findings", it returns the literature.
 *
 * The reply is a plain list, parsed leniently — a model asked for five lines
 * will occasionally number them, bullet them, or add a preamble, and rejecting
 * that would fail the whole workflow over formatting.
 */
export async function planResearch(input: {
  userId: string;
  question: string;
  locale: 'ar' | 'en';
  maxQuestions: number;
}): Promise<string[]> {
  await assertCanUseAI(input.userId, 300);

  const provider = await resolveProvider();

  const system =
    input.locale === 'ar'
      ? `أنت مخطّط بحثي. حلّل سؤال الباحث إلى أسئلة فرعية قابلة للبحث.

القواعد:
- بين ٣ و${input.maxQuestions} أسئلة، كل سؤال في سطر.
- كل سؤال يجب أن يكون قابلًا للبحث بذاته، لا مجرد إعادة صياغة للسؤال الأصلي.
- غطِّ جوانب مختلفة: النتائج المُبلَّغة، العوامل المعدِّلة، طرق القياس، النتائج المتعارضة.
- لا تكتب مقدّمة ولا ترقيمًا ولا شرحًا — الأسئلة فقط.`
      : `You are a research planner. Break the researcher's question into searchable sub-questions.

Rules:
- Between 3 and ${input.maxQuestions} questions, one per line.
- Each must be searchable on its own, not a rewording of the original.
- Cover different angles: reported findings, moderating factors, measurement approaches, contradictory results.
- No preamble, no numbering, no explanation — the questions only.`;

  const result = await runCompletion({
    userId: input.userId,
    projectId: '',
    provider,
    task: 'chat',
    locale: input.locale,
    system,
    messages: [{ role: 'user', content: input.question }],
    maxTokens: 400,
    /* Low but not zero: some variety in angle is useful, invention is not. */
    temperature: 0.4,
  });

  return result.text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 10 && line.length < 300)
    .slice(0, input.maxQuestions);
}

/**
 * States what the sources actually say about one sub-question.
 *
 * Separated from the writing step on purpose. A model asked to read sources and
 * write a report in one pass will blend what it read with what it knows, and
 * the join is invisible. Extracting first produces a record of what each source
 * supports, and the writing step is then constrained to that record.
 */
export async function extractEvidence(input: {
  userId: string;
  subQuestion: string;
  locale: 'ar' | 'en';
  sources: { index: number; title: string; content: string; kind: string }[];
}): Promise<string> {
  await assertCanUseAI(input.userId, 500);

  const provider = await resolveProvider();

  const rendered = input.sources
    .map(
      (source) =>
        `[${source.index}] (${source.kind}) ${source.title}\n${source.content.slice(0, 4000)}`,
    )
    .join('\n\n---\n\n');

  const system =
    input.locale === 'ar'
      ? `استخرج ما تقوله المصادر عن السؤال المطروح، ولا شيء غير ذلك.

القواعد:
- كل جملة تنتهي برقم المصدر، هكذا [3].
- لا تضف معلومة ليست في المصادر.
- إن تعارضت المصادر، اذكر التعارض صراحةً مع رقمي المصدرين.
- إن لم تجب المصادر عن السؤال، قل ذلك في جملة واحدة.
- لا تكتب مقدّمة ولا خاتمة.`
      : `Extract what the sources say about the question, and nothing else.

Rules:
- Every sentence ends with its source number, like [3].
- Add nothing that is not in the sources.
- Where sources disagree, say so explicitly and give both numbers.
- If the sources do not answer the question, say so in one sentence.
- No preamble, no conclusion.`;

  const result = await runCompletion({
    userId: input.userId,
    projectId: '',
    provider,
    task: 'chat',
    locale: input.locale,
    system,
    messages: [{ role: 'user', content: `Question: ${input.subQuestion}\n\nSources:\n\n${rendered}` }],
    maxTokens: 900,
    temperature: 0.2,
  });

  return result.text;
}

/**
 * Names what the evidence does not cover.
 *
 * The step that makes the report honest. Without it a synthesis fills its own
 * gaps — smoothly, and in the same voice as the evidence — and a researcher
 * cannot tell which parts rest on sources.
 *
 * The gaps also drive one more round of searching, so this is not only
 * disclosure: it is what makes the workflow iterative rather than linear.
 */
export async function identifyGaps(input: {
  userId: string;
  question: string;
  locale: 'ar' | 'en';
  evidence: { subQuestion: string; findings: string }[];
}): Promise<string[]> {
  await assertCanUseAI(input.userId, 300);

  const provider = await resolveProvider();

  const rendered = input.evidence
    .map((entry) => `Q: ${entry.subQuestion}\nFound: ${entry.findings.slice(0, 1500)}`)
    .join('\n\n');

  const system =
    input.locale === 'ar'
      ? `حدّد ما لم تجب عنه الأدلة المجمّعة بخصوص السؤال الأصلي.

القواعد:
- اكتب الثغرات فقط، كل ثغرة في سطر، بصيغة قابلة للبحث.
- ثلاث ثغرات على الأكثر.
- إن كانت الأدلة كافية، لا تكتب شيئًا إطلاقًا.
- لا تخترع ثغرة لملء القائمة.`
      : `Identify what the collected evidence does not answer about the original question.

Rules:
- Gaps only, one per line, phrased so they could be searched.
- At most three.
- If the evidence is sufficient, write nothing at all.
- Do not invent a gap to fill the list.`;

  const result = await runCompletion({
    userId: input.userId,
    projectId: '',
    provider,
    task: 'chat',
    locale: input.locale,
    system,
    messages: [{ role: 'user', content: `Original question: ${input.question}\n\n${rendered}` }],
    maxTokens: 300,
    temperature: 0.3,
  });

  return result.text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 10 && line.length < 300)
    .slice(0, 3);
}

/**
 * Writes the report from the extracted evidence.
 *
 * Given the evidence rather than the sources, which is the point of having
 * extracted it: this step cannot reach past what the previous step established,
 * so it cannot quietly add a fact between two cited ones.
 *
 * The gaps are passed in and required to appear. A report that omits its own
 * limitations is the failure mode this whole workflow exists to avoid.
 */
export async function synthesiseReport(input: {
  userId: string;
  question: string;
  locale: 'ar' | 'en';
  evidence: { subQuestion: string; findings: string }[];
  gaps: string[];
  sources: { index: number; title: string; url: string; kind: string; year?: number; container?: string }[];
}): Promise<string> {
  await assertCanUseAI(input.userId, 1200);

  const provider = await resolveProvider();

  const evidenceBlock = input.evidence
    .map((entry) => `## ${entry.subQuestion}\n${entry.findings}`)
    .join('\n\n');

  const sourceList = input.sources
    .map(
      (source) =>
        `[${source.index}] ${source.title}${source.year ? ` (${source.year})` : ''} — ${source.kind === 'academic' ? 'academic' : 'web'}${source.container ? `, ${source.container}` : ''}`,
    )
    .join('\n');

  const gapBlock =
    input.gaps.length > 0 ? input.gaps.map((gap) => `- ${gap}`).join('\n') : '(none)';

  const system =
    input.locale === 'ar'
      ? `اكتب تقريرًا بحثيًا من الأدلة المستخرجة أدناه وحدها.

القواعد:
- كل معلومة تحمل رقم مصدرها، هكذا [3] أو [2][5].
- لا تضف أي معلومة ليست في الأدلة، مهما بدت بديهية.
- اذكر التعارضات بين المصادر بدل تجاوزها.
- ميّز بين المصادر الأكاديمية ومصادر الويب حين يكون التمييز مهمًّا للاستنتاج.
- أنهِ التقرير بقسم "حدود هذه المراجعة" يذكر الثغرات المذكورة أدناه حرفيًا؛ لا تحذف أيًّا منها ولا تخفّف صياغتها.
- استخدم Markdown بعناوين واضحة.`
      : `Write a research report from the extracted evidence below, and nothing else.

Rules:
- Every claim carries its source number, like [3] or [2][5].
- Add nothing that is not in the evidence, however obvious it seems.
- Report disagreements between sources rather than smoothing them over.
- Distinguish academic sources from web sources where the distinction bears on the conclusion.
- End with a "Limitations of this review" section stating the gaps listed below, verbatim; do not omit or soften any of them.
- Use Markdown with clear headings.`;

  const result = await runCompletion({
    userId: input.userId,
    projectId: '',
    provider,
    task: 'chat',
    locale: input.locale,
    system,
    messages: [
      {
        role: 'user',
        content: `Research question: ${input.question}\n\nEvidence:\n\n${evidenceBlock}\n\nGaps that must appear in the limitations section:\n${gapBlock}\n\nSources:\n${sourceList}`,
      },
    ],
    maxTokens: 3000,
    temperature: 0.4,
  });

  return result.text;
}

/**
 * Writes questionnaire items to a specification.
 *
 * A thin wrapper: the measurement knowledge is in the prompt the caller builds,
 * not here. Temperature is low but not zero — item wording benefits from some
 * variation, since four items on one construct should not read as four
 * rephrasings of the same sentence, which is what a deterministic run produces.
 */
export async function generateSurveyItems(input: {
  userId: string;
  prompt: string;
  locale: 'ar' | 'en';
  maxTokens: number;
}): Promise<string> {
  await assertCanUseAI(input.userId, Math.round(input.maxTokens / 2));

  const provider = await resolveProvider();

  const result = await runCompletion({
    userId: input.userId,
    projectId: '',
    provider,
    task: 'chat',
    locale: input.locale,
    system: input.prompt,
    messages: [{ role: 'user', content: 'Generate the instrument now.' }],
    maxTokens: input.maxTokens,
    temperature: 0.6,
  });

  return result.text;
}

/**
 * Describes academic sources that were actually retrieved.
 *
 * The rules given to the model are the same ones the results chapter uses for
 * statistics, and for the same reason. Asked to summarise literature on a
 * topic, a model will happily add a study it half-remembers — the title reads
 * correctly, the authors are people who work in the field, the year is
 * plausible — and a student will cite it. The defence is not a sterner
 * instruction but a closed set: every source is listed below, and the model is
 * told it may describe those and nothing else.
 *
 * The coverage notice is passed in as a fixed message rather than left to the
 * model's judgement. Whether Arabic sources were thin is a fact the search
 * computed; a model asked to decide would mention it inconsistently, and the
 * one thing worse than not saying it is saying it when it is untrue.
 */
export async function summariseSources(input: {
  userId: string;
  locale: 'ar' | 'en';
  topic: string;
  sources: {
    title: string;
    authors?: string[];
    year?: number;
    container?: string;
    doi?: string;
    snippet?: string;
    citationCount?: number;
    language: string;
  }[];
  coverageNoticeKey?: string | null;
  projectId?: string | null;
}): Promise<string> {
  await assertCanUseAI(input.userId, 600);

  const provider = await resolveProvider();

  const listed = input.sources
    .map((source, index) => {
      const parts = [`[${index + 1}] ${source.title}`];
      if (source.authors?.length) parts.push(`Authors: ${source.authors.slice(0, 4).join(', ')}`);
      parts.push(
        `${source.year ?? 'n.d.'} · ${source.container ?? 'unknown venue'} · ` +
          `${source.citationCount ?? 0} citations · language: ${source.language}`,
      );
      if (source.doi) parts.push(`DOI: ${source.doi}`);
      if (source.snippet) parts.push(`Abstract: ${source.snippet}`);
      return parts.join('\n    ');
    })
    .join('\n\n');

  const system = `You are summarising academic sources for a researcher writing in ${
    input.locale === 'ar' ? 'Arabic' : 'English'
  }. Answer in that language.

These sources were retrieved from Crossref and OpenAlex just now. They are real.

RULES — these override everything else:
1. Describe only the sources listed below. Do not add a study, an author, a year, or a finding that is not in the list, however confident you are that it exists.
2. Refer to sources by their number, like [3]. The interface shows the full citation next to your text.
3. Do not state a finding a source's abstract does not support. Where an abstract is missing, say what the study is about from its title and no more.
4. Group the sources by theme where they group naturally. Say plainly when they do not.
5. Note where the sources disagree, and where a claim rests on only one of them.
6. This is a description of what was found, not a literature review. Do not write conclusions the researcher has not reached.

SOURCES:

${listed}`;

  const result = await runCompletion({
    userId: input.userId,
    projectId: input.projectId ?? '',
    provider,
    task: 'chat',
    locale: input.locale,
    system,
    messages: [
      {
        role: 'user',
        content:
          input.locale === 'ar'
            ? `لخّص لي ما وجدته من دراسات حول: ${input.topic}`
            : `Summarise what these sources say about: ${input.topic}`,
      },
    ],
    maxTokens: 2000,
    temperature: 0.4,
  });

  return result.text;
}

export async function streamChat(
  userId: string,
  projectId: string,
  message: string,
  sectionKey?: SectionKey,
): Promise<ChatStreamHandle> {
  const { project, context, provider } = await prepare(userId, projectId, sectionKey, 300);

  const conversation = await conversationsRepo.findOrCreate({
    userId,
    projectId,
    scope: sectionKey ? 'SECTION' : 'PROJECT',
    sectionKey: sectionKey ?? null,
    title: project.title,
  });

  const history = await conversationsRepo.listMessages(conversation.id, 20);
  const messages: AIChatMessage[] = [
    ...history
      .filter((row) => row.role !== 'SYSTEM')
      .map((row) => ({
        role: row.role === 'ASSISTANT' ? ('assistant' as const) : ('user' as const),
        content: row.content,
      })),
    { role: 'user', content: message },
  ];

  await conversationsRepo.addMessage({
    conversationId: conversation.id,
    role: 'USER',
    content: message,
  });

  const encoder = new TextEncoder();

  // Shared between `start` and `cancel` so a client disconnect stops further writes.
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      /**
       * Enqueueing onto a cancelled stream throws. The client disconnecting is a
       * normal event — not an error — so it flips `closed` and the run finishes
       * quietly, still persisting whatever the model produced.
       */
      const send = (event: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      let full = '';
      let usage = { tokensIn: 0, tokensOut: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
      let failed = false;

      try {
        for await (const chunk of provider.stream({
          task: 'chat',
          locale: project.language === 'AR' ? 'ar' : 'en',
          system: chatPrompt(context, sectionKey),
          messages,
          maxTokens: 4000,
          temperature: 0.7,
        })) {
          if (chunk.delta) {
            full += chunk.delta;
            send({ type: 'delta', text: chunk.delta });
          }
          if (chunk.done && chunk.usage) {
            usage = {
              tokensIn: chunk.usage.tokensIn,
              tokensOut: chunk.usage.tokensOut,
              cacheWriteTokens: chunk.usage.cacheWriteTokens ?? 0,
              cacheReadTokens: chunk.usage.cacheReadTokens ?? 0,
            };
          }
        }
      } catch (error) {
        failed = true;
        logger.error('ai.chat.failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Persistence and metering run whether or not the reader is still there.
      // Skipping them on disconnect would let a client abort every response and
      // consume the provider without ever touching its quota.
      const guardrails = inspectOutput(full);

      if (full) {
        try {
          await conversationsRepo.addMessage({
            conversationId: conversation.id,
            role: 'ASSISTANT',
            content: full,
            provider: provider.name,
            model: provider.model,
            tokensIn: billableInput(usage),
            tokensOut: usage.tokensOut,
            flags: guardrails.flags,
          });
        } catch (error) {
          logger.error('ai.chat.persistFailed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (full || usage.tokensIn > 0) {
        try {
          await recordAIUsage({
            userId,
            projectId,
            generatedWords: countWords(full),
            // If the stream was cut before the usage event arrived, fall back to
            // an estimate so an aborted request still counts against the quota.
            tokensIn:
              billableInput(usage) || provider.countTokens(messages.at(-1)?.content ?? ''),
            tokensOut: usage.tokensOut || provider.countTokens(full),
            costMicroUsd: provider.estimateCostMicroUsd(usage),
            provider: provider.name,
            model: provider.model,
          });
        } catch (error) {
          logger.error('ai.chat.meterFailed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (failed) send({ type: 'error' });
      else send({ type: 'done', guardrails: guardrails.notice, flags: guardrails.flags });

      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the runtime after a client disconnect.
        }
      }
    },

    cancel() {
      // The reader went away; `send()` becomes a no-op from here, but the run
      // continues so the reply and its usage are still recorded.
      closed = true;
      logger.debug('ai.chat.clientDisconnected', { projectId });
    },
  });

  return { stream, conversationId: conversation.id };
}

export async function getConversation(userId: string, projectId: string, sectionKey?: SectionKey) {
  await getOwnedProject(projectId, userId);
  const conversation = await conversationsRepo.findOrCreate({
    userId,
    projectId,
    scope: sectionKey ? 'SECTION' : 'PROJECT',
    sectionKey: sectionKey ?? null,
  });
  const messages = await conversationsRepo.listMessages(conversation.id, 50);
  return { conversation, messages };
}

export async function listProjectSections(userId: string, projectId: string) {
  await getOwnedProject(projectId, userId);
  return projectsRepo.listSections(projectId);
}
