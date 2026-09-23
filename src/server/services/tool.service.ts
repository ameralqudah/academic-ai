import { buildProjectContext } from '@/ai/context/builder';
import { labelFor } from '@/ai/context/labels';
import { inspectOutput, type GuardrailResult } from '@/ai/guardrails';
import { toolPrompt } from '@/ai/prompts/tools';
import { requirementsFor } from '@/server/ai/model-requirements';
import { selectModel } from '@/server/ai/model-router';
import type { ProjectContext } from '@/ai/types';
import type { ToolKey } from '@/config/research';
import { countWords } from '@/lib/text';
import { AppError } from '@/server/http/errors';

import { getProjectWithSections } from './project.service';
import { assertCanUseAI, assertToolAllowed, recordSimple } from './usage.service';

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

  /* Routed; tool selection is structured extraction rather than prose. */
  const provider = (await selectModel(requirementsFor({ capability: 'file.analyse' }))).provider;
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

  const result = await provider.complete({
    task: `tool.${input.toolKey}`,
    locale,
    system: toolPrompt(input.toolKey, input.options ?? {}, context),
    messages: [{ role: 'user', content: input.text }],
    maxTokens: 4000,
    temperature: input.toolKey === 'translator' ? 0.3 : 0.6,
    projectId: input.projectId ?? null,
  });

  /* Tokens, words, cost and the request are metered by the gateway; the tool run is this service's own count. */
  await recordSimple(input.userId, 'TOOL_RUN', 1, input.projectId);

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
}
