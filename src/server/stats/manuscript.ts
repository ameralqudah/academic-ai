/**
 * From verified results to manuscript text, without retyping a number (P1-C).
 *
 * - `formatEstimate` writes the APA-style report of one stored estimate.
 * - A narrative may mention a number only as `{{value:<key>}}`; `renderTokens`
 *   replaces each token with the formatted estimate. `untracedStatistics`
 *   finds anything that looks like a statistic outside a token, and such text
 *   is refused: no free-typed number enters the manuscript.
 * - `insertClaim` records the sentence as a Research Graph claim that
 *   `reports` each value it cites, so when the run is replaced or its data
 *   changes, the claim is marked not current by the graph.
 */

import { and, eq, inArray } from 'drizzle-orm';

import { formatNumber, formatP } from '@/analysis/engine/tables';
import { db } from '@/server/db';
import { statEstimates, statRuns, type StatEstimate } from '@/server/db/schema';
import * as graph from '@/server/graph/service';
import { AppError } from '@/server/http/errors';

import { requireRun } from './runs';
import type { StatsActor } from './access';

type Formattable = Pick<StatEstimate, 'stat' | 'label' | 'estimate' | 'se' | 'statistic' | 'statisticName' | 'df' | 'df2' | 'p' | 'ciLow' | 'ciHigh' | 'ciLevel' | 'ciMethod' | 'n'>;

const pText = (p: number | null) => (p === null ? '' : formatP(p).startsWith('<') ? `p ${formatP(p)}` : `p = ${formatP(p)}`);
const df = (e: Formattable) => (e.df === null ? '' : e.df2 !== null ? `(${round(e.df)}, ${round(e.df2)})` : `(${round(e.df)})`);
const round = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));
const ci = (e: Formattable) => (e.ciLow === null || e.ciHigh === null ? '' : `${Math.round((e.ciLevel ?? 0.95) * 100)}% CI [${formatNumber(e.ciLow, e.stat)}, ${formatNumber(e.ciHigh, e.stat)}]`);
const join = (...parts: string[]) => parts.filter(Boolean).join(', ');

const SYMBOL: Record<string, string> = { b: 'b', beta: 'β', r: 'r', rho: 'ρ', alpha: 'α', alpha_standardised: 'standardised α', eta2: 'η²', omega2: 'ω²', r2: 'R²', adj_r2: 'adjusted R²', delta_r2: 'ΔR²', mean: 'M', sd: 'SD', median: 'Mdn', kmo: 'KMO', cr: 'CR', ave: 'AVE', htmt: 'HTMT', path: 'β', loading: 'λ', std_loading: 'standardised λ', indirect: 'indirect effect', conditional_effect: 'conditional effect', mean_difference: 'mean difference' };

/** The report of one estimate, as it should appear in a results section. */
export function formatEstimate(e: Formattable): string {
  const symbol = SYMBOL[e.stat] ?? e.label;
  const value = `${symbol} = ${formatNumber(e.estimate, e.stat)}`;
  const test = e.statistic !== null && e.statisticName ? `${e.statisticName === 'chi2' ? 'χ²' : e.statisticName}${df(e)} = ${formatNumber(e.statistic)}` : '';
  if (e.stat === 'r' || e.stat === 'rho') return join(`${symbol}${e.df !== null ? `(${round(e.df)})` : ''} = ${formatNumber(e.estimate, e.stat)}`, pText(e.p), ci(e));
  if (e.stat === 'F' || e.stat === 'F_welch' || e.stat === 'chi2') return join(test || value, pText(e.p));
  if (e.stat === 'indirect') return `${join(value, ci(e))}${e.ciMethod === 'bootstrap-percentile' ? ' (percentile bootstrap)' : ''}`;
  return join(value, e.se !== null ? `SE = ${formatNumber(e.se)}` : '', test, pText(e.p), ci(e));
}

/* -------------------------------------------------------------------------- */
/*                                   Tokens                                   */
/* -------------------------------------------------------------------------- */

const TOKEN = /\{\{value:([^{}]{1,300})\}\}/g;

/** Statistic-like text: "p < .05", "r = 0.4", "t(12) = 3.1", "β = .2", "95% CI", any decimal number. */
const STATISTIC = /(\b(p|r|t|F|b|B|z|d|n|N|M|SD|SE|CI|df|R2|R²|η²|ω²|α|β|ρ|χ²|chi2?)\s*(\(\s*\d[\d.,\s]*\))?\s*[=<>≤≥]\s*[-−]?\.?\d)|(\d+\.\d+)|(\.\d+)|(\b\d+(\.\d+)?\s*%)/u;

export function tokensIn(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((match) => match[1]!.trim());
}

/** Spans that look like statistics but are not tokens: free-typed numbers. */
export function untracedStatistics(text: string): string[] {
  const outside = text.replace(TOKEN, ' ');
  const found: string[] = [];
  const global = new RegExp(STATISTIC.source, 'gu');
  for (const match of outside.matchAll(global)) found.push(match[0].trim());
  return found;
}

export function renderTokens(text: string, estimates: Map<string, Formattable>): string {
  return text.replace(TOKEN, (_whole, raw: string) => {
    const estimate = estimates.get(raw.trim());
    if (!estimate) throw new AppError('VALIDATION', `Unknown value "${raw}" in the text.`, 'قيمة غير معروفة في النص.', { reason: 'unknown_value', key: raw });
    return formatEstimate(estimate);
  });
}

/* -------------------------------------------------------------------------- */
/*                               Manuscript claims                            */
/* -------------------------------------------------------------------------- */

export interface InsertClaimInput {
  keys: string[];
  /** Optional sentence with `{{value:key}}` tokens; the default is the formatted estimates joined. */
  text?: string;
  /** Attach to an existing manuscript block (`block —asserts→ claim`). */
  blockId?: string;
}

export async function insertClaim(actor: StatsActor, projectId: string, runId: string, input: InsertClaimInput) {
  const run = await requireRun(runId, actor, 'EDITOR', projectId);
  if (run.status !== 'succeeded') throw new AppError('CONFLICT', 'Only a succeeded run can be cited.', 'يمكن الاستشهاد بتشغيل ناجح فقط.');
  const [superseded] = await db.select({ id: statRuns.id }).from(statRuns).where(and(eq(statRuns.supersedesRunId, runId), eq(statRuns.status, 'succeeded'))).limit(1);
  if (superseded) throw new AppError('CONFLICT', 'This run has been replaced; cite the current one.', 'استُبدل هذا التشغيل؛ استشهد بالحالي.', { reason: 'superseded', current: superseded.id });
  if (!run.graphRunNodeId) throw new AppError('CONFLICT', 'The run is not recorded in the Research Graph yet.', 'التشغيل غير مسجّل في مخطط البحث بعد.', { reason: 'not_recorded' });

  const keys = [...new Set([...input.keys, ...(input.text ? tokensIn(input.text) : [])])];
  if (keys.length === 0 || keys.length > 50) throw new AppError('VALIDATION', 'Cite between 1 and 50 values.', 'استشهد بقيمة واحدة إلى خمسين.');
  const rows = await db.select().from(statEstimates).where(and(eq(statEstimates.runId, runId), inArray(statEstimates.key, keys)));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const missing = keys.filter((key) => !byKey.get(key)?.graphNodeId);
  if (missing.length) throw new AppError('VALIDATION', `Not a recorded value of this run: ${missing.slice(0, 5).join(', ')}.`, 'ليست قيمًا مسجلة لهذا التشغيل.', { reason: 'unknown_value' });

  let text: string;
  if (input.text) {
    const untraced = untracedStatistics(input.text);
    if (untraced.length) {
      throw new AppError('VALIDATION', 'Numbers must be inserted as {{value:…}} references, not typed.', 'يجب إدراج الأرقام كمراجع {{value:…}} لا كتابتها.', { reason: 'untraced_statistics', spans: untraced.slice(0, 10) });
    }
    text = renderTokens(input.text, byKey);
  } else {
    text = keys.map((key) => `${byKey.get(key)!.label}: ${formatEstimate(byKey.get(key)!)}`).join('; ');
  }

  const claim = await graph.createNode(projectId, { userId: actor.userId }, { type: 'claim', label: text.slice(0, 200), data: { text: text.slice(0, 5000) }, status: 'active' });
  for (const key of keys) await graph.link(projectId, { userId: actor.userId }, { srcId: claim.id, rel: 'reports', dstId: byKey.get(key)!.graphNodeId! });
  if (input.blockId) await graph.link(projectId, { userId: actor.userId }, { srcId: input.blockId, rel: 'asserts', dstId: claim.id });
  return { claim, text, keys };
}
