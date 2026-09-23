/**
 * The statistics engine as tools for the Model Gateway (P1-C).
 *
 * The model may propose, validate and run analyses and read verified results.
 * It may not write a number: there is no tool that creates, edits or
 * overwrites a result, and the tools it has only reach `@/server/stats`
 * functions that take numbers from the engine. The allow-list below is the
 * whole surface, checked by a test.
 *
 *   user question ─▶ model ─(createAnalysisSpec)─▶ validated specification
 *                          ─(runAnalysis)─▶ deterministic engine ─▶ stored run
 *                          ─(getAnalysisResult)─▶ verified estimates (as data)
 *   explanation: the model writes {{value:key}} tokens; the server renders the
 *   numbers from the stored estimates and refuses free-typed statistics.
 *
 * Dataset rows are never sent to the model: only column names and types.
 */

import { and, eq } from 'drizzle-orm';

import { logger } from '@/lib/logger';
import { gateway } from '@/server/ai/gateway';
import type { GatewayMessage } from '@/server/ai/gateway/contract';
import { withCallIds } from '@/server/ai/request-scope';
import { db } from '@/server/db';
import { statEstimates } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';

import type { StatsActor } from './access';
import { STATS_TOOL_NAMES } from './tool-names';
import { formatEstimate, renderTokens, tokensIn, untracedStatistics } from './manuscript';
import { getRun } from './runs';

/**
 * The seven statistics tools are defined in the research-run registry
 * (`src/server/runs/tools/statistics.ts`, P1-D) — one registry, no second
 * list. These entry points keep the P1-C contract and delegate to the P1-D
 * execution path: registry → validation → policy → limits → idempotency.
 */
export { STATS_TOOL_NAMES };

/** Executes one statistics tool on the user's behalf, through the registry and the policy. */
export async function executeStatsTool(actor: StatsActor, projectId: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { invokeAssistantTool } = await import('@/server/runs/assistant');
  return invokeAssistantTool(actor, projectId, name, args);
}

/** The analysis assistant (P1-C route), on the P1-D execution path. */
export async function runAssistant(actor: StatsActor, projectId: string, datasetVersionId: string, request: string) {
  const { runAssistant: run } = await import('@/server/runs/assistant');
  return run(actor, projectId, datasetVersionId, request);
}

/**
 * A plain-language explanation of a verified run. The model sees the stored
 * estimates (as data) and must refer to every number as {{value:key}}; the
 * server renders the numbers. Free-typed statistics get one correction round,
 * then the explanation is refused rather than shown.
 */
export async function explainRun(actor: StatsActor, projectId: string, runId: string, locale: 'en' | 'ar' = 'en') {
  const { run, estimates, verified } = await getRun(actor, runId, projectId);
  if (run.status !== 'succeeded') throw new AppError('CONFLICT', 'Only a succeeded run can be explained.', 'يمكن شرح تشغيل ناجح فقط.');
  const byKey = new Map(estimates.map((e) => [e.key, e]));
  const listing = estimates.slice(0, 150).map((e) => `${e.key} — ${e.label}: ${formatEstimate(e)}`).join('\n');
  const system = [
    'Explain these verified statistical results for a researcher, in ' + (locale === 'ar' ? 'Arabic' : 'English') + '.',
    'Do not write any digit yourself — no number, statistic, p-value, interval, count or hypothesis number. Refer to each value only as {{value:KEY}} using a key from the list, and to hypotheses by their wording.',
    'Do not claim causality the design cannot support; mention the reported warnings.',
  ].join(' ');
  const issues = (run.issues as { code: string; severity: string; message: string }[]).filter((issue) => issue.severity !== 'INFO').map((issue) => `${issue.severity}: ${issue.message}`).join('\n');
  const messages: GatewayMessage[] = [{ role: 'user', content: `Analysis: ${run.analysisType} (${run.method}), n = ${run.nUsed}.\nValues:\n${listing}\n\nWarnings:\n${issues || 'none'}` }];

  return withCallIds({ projectId }, async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await gateway().generate({ purpose: 'stats.explain', system, messages, maxOutputTokens: 1500, temperature: 0.2, countsAsRequest: attempt === 0, continuation: attempt > 0 });
      const text = response.text.trim();
      const untraced = untracedStatistics(text, { strict: true });
      const unknown = tokensIn(text).filter((key) => !byKey.has(key));
      if (!untraced.length && !unknown.length) {
        return { text: renderTokens(text, byKey), template: text, keys: [...new Set(tokensIn(text))], verified };
      }
      logger.warn('stats.explain.untraced', { runId, untraced: untraced.length, unknown: unknown.length });
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Rewrite: these are typed numbers or unknown keys, which are not allowed: ${[...untraced, ...unknown].slice(0, 10).join(' | ')}. Use only {{value:KEY}} tokens from the list.` });
    }
    throw new AppError('CONFLICT', 'The explanation contained numbers not taken from the results, so it was not shown.', 'احتوى الشرح أرقامًا لم تُؤخذ من النتائج، فلم يُعرض.', { reason: 'untraced_statistics' });
  });
}

/** Test hook: the stored estimate a token refers to. */
export async function estimateByKey(runId: string, key: string) {
  const [row] = await db.select().from(statEstimates).where(and(eq(statEstimates.runId, runId), eq(statEstimates.key, key))).limit(1);
  return row ?? null;
}
