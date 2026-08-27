import { buildProjectContext } from '@/ai/context/builder';
import { labelFor } from '@/ai/context/labels';
import { inspectOutput, type GuardrailResult } from '@/ai/guardrails';
import { toolPrompt } from '@/ai/prompts/tools';
import { resolveProvider } from '@/ai/registry';
import { AIProviderError, type ProjectContext } from '@/ai/types';
import type { ToolKey } from '@/config/research';
import { logger } from '@/lib/logger';
import { countWords } from '@/lib/text';
import { AppError } from '@/server/http/errors';

import { getProjectWithSections } from './project.service';
import { assertCanUseAI, assertToolAllowed, recordAIUsage } from './usage.service';

export interface ToolRunResult {
  toolKey: ToolKey;
  output: string;
  wordCount: number;
  guardrails: GuardrailResult;
}

export async function runTool(input: {
  userId: string;
  toolKey: ToolKey;
  text: string;
  options?: Record<string, string>;
  projectId?: string;
}): Promise<ToolRunResult> {
  await assertToolAllowed(input.userId, input.toolKey);
  await assertCanUseAI(input.userId, countWords(input.text));

  const provider = await resolveProvider();
  if (!provider.isConfigured()) {
    throw AppError.aiUnavailable('No AI provider API key is configured.');
  }

  let context: ProjectContext | null = null;
  let locale: 'ar' | 'en' = 'ar';

  if (input.projectId) {
    const { project, sections } = await getProjectWithSections(input.projectId, input.userId);
    context = buildProjectContext(project, sections, labelFor, { totalBudgetChars: 6000 });
    locale = project.language === 'AR' ? 'ar' : 'en';
  }

  try {
    const result = await provider.complete({
      task: `tool.${input.toolKey}`,
      locale,
      system: toolPrompt(input.toolKey, input.options ?? {}, context),
      messages: [{ role: 'user', content: input.text }],
      maxTokens: 4000,
      temperature: input.toolKey === 'translator' ? 0.3 : 0.6,
    });

    await recordAIUsage({
      userId: input.userId,
      projectId: input.projectId,
      toolKey: input.toolKey,
      generatedWords: countWords(result.text),
      tokensIn:
        result.usage.tokensIn +
        (result.usage.cacheWriteTokens ?? 0) +
        (result.usage.cacheReadTokens ?? 0),
      tokensOut: result.usage.tokensOut,
      costMicroUsd: provider.estimateCostMicroUsd(result.usage),
      provider: result.provider,
      model: result.model,
    });

    return {
      toolKey: input.toolKey,
      output: result.text,
      wordCount: countWords(result.text),
      // The citation assistant is the one tool whose entire output is references,
      // so its findings always matter.
      guardrails: inspectOutput(result.text, {
        expectsNoStatistics: input.toolKey !== 'summarizer',
      }),
    };
  } catch (error) {
    if (error instanceof AIProviderError) {
      logger.error('tool.provider.failed', { tool: input.toolKey, status: error.status });
      throw AppError.aiUnavailable(error.message.slice(0, 400));
    }
    throw error;
  }
}
