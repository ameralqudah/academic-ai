/**
 * Writing tools. Text only, returned as the step's output; nothing is written
 * into project sections in P1-D. Numbers appear only as {{value:key}} tokens
 * rendered from a stored statistics run; text with any other digit is refused.
 */

import { z } from 'zod';

import { gateway } from '@/server/ai/gateway';
import { AppError } from '@/server/http/errors';
import { formatEstimate, renderTokens, tokensIn, untracedStatistics } from '@/server/stats/manuscript';
import { getRun } from '@/server/stats/runs';
import { explainRun } from '@/server/stats/tools';

import { defineRunTool } from '../types';

const id = z.string().min(1).max(64);
const actor = (ctx: { userId: string }) => ({ userId: ctx.userId });

export const explainResult = defineRunTool({
  name: 'explainResult',
  version: '1.0.0',
  description: 'A plain-language explanation of a verified statistics run; every number is rendered from the stored estimates.',
  category: 'writing',
  input: z.object({ runId: id, locale: z.enum(['en', 'ar']).default('en') }).strict(),
  output: z.object({ text: z.string().max(20_000), keys: z.array(z.string()).max(200), verified: z.boolean() }).strict(),
  sideEffect: 'compute',
  risk: 'low',
  requiredRole: 'VIEWER',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run'],
  timeoutMs: 120_000,
  maxAttempts: 2,
  idempotency: 'natural',
  estimatedModelCalls: 2,
  resources: (input) => [{ kind: 'statRun', id: input.runId }],
  approval: async () => null,
  async execute(input, ctx) {
    const explained = await explainRun(actor(ctx), ctx.projectId, input.runId, input.locale);
    return { output: { text: explained.text.slice(0, 20_000), keys: explained.keys.slice(0, 200), verified: explained.verified }, ref: { kind: 'stat_run', id: input.runId } };
  },
});

export const generateDraft = defineRunTool({
  name: 'generateDraft',
  version: '1.0.0',
  description: 'Draft a short passage from an instruction. With a statistics run, numbers may appear only as {{value:key}} tokens from that run; other digits are refused.',
  category: 'writing',
  input: z.object({ instruction: z.string().trim().min(5).max(2000), runId: id.optional(), locale: z.enum(['en', 'ar']).default('en') }).strict(),
  output: z.object({ text: z.string().max(20_000), keys: z.array(z.string()).max(200) }).strict(),
  sideEffect: 'compute',
  risk: 'low',
  requiredRole: 'VIEWER',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run'],
  timeoutMs: 120_000,
  maxAttempts: 2,
  idempotency: 'natural',
  estimatedModelCalls: 1,
  resources: (input) => (input.runId ? [{ kind: 'statRun', id: input.runId }] : []),
  approval: async () => null,
  async execute(input, ctx) {
    const estimates = input.runId ? (await getRun(actor(ctx), input.runId, ctx.projectId)).estimates : [];
    const byKey = new Map(estimates.map((e) => [e.key, e]));
    const listing = estimates.slice(0, 150).map((e) => `${e.key} — ${e.label}: ${formatEstimate(e)}`).join('\n');
    const response = await gateway().generate({
      purpose: 'runs.generateDraft',
      system: [
        `Write in ${input.locale === 'ar' ? 'Arabic' : 'English'}, academically and concisely.`,
        'Do not write any digit yourself. Refer to a statistical value only as {{value:KEY}} with a key from the list; if there is no list, write no numbers at all.',
        'Do not invent citations, data or results.',
      ].join(' '),
      messages: [{ role: 'user', content: `${input.instruction}${listing ? `\n\nVerified values:\n${listing}` : ''}` }],
      maxOutputTokens: 2000,
      temperature: 0.3,
      countsAsRequest: false,
    });
    const text = response.text.trim();
    const untraced = untracedStatistics(text, { strict: true });
    const unknown = tokensIn(text).filter((key) => !byKey.has(key));
    if (untraced.length || unknown.length) {
      throw new AppError('CONFLICT', 'The draft contained numbers not taken from verified results, so it was not kept.', 'احتوت المسودة أرقامًا لم تُؤخذ من نتائج موثّقة، فلم تُحفظ.', { reason: 'untraced_statistics', count: untraced.length + unknown.length });
    }
    return { output: { text: renderTokens(text, byKey).slice(0, 20_000), keys: [...new Set(tokensIn(text))].slice(0, 200) } };
  },
});

export const WRITING_TOOLS = [explainResult, generateDraft];
