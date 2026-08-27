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

  const result = await runCompletion({
    userId,
    projectId,
    provider,
    task: 'wizard.section',
    locale: project.language === 'AR' ? 'ar' : 'en',
    system: sectionPrompt(sectionKey, context, instruction),
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
