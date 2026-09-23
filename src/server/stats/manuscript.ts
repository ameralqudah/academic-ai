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
import { tokensIn, untracedNumbers, VALUE_TOKEN } from '@/lib/statistics-text';
import { db } from '@/server/db';
import { statEstimates, type StatEstimate } from '@/server/db/schema';
import * as graph from '@/server/graph/service';
import { AppError } from '@/server/http/errors';

import { requireRun, supersedingRun } from './runs';
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

/** Statistic-like text outside tokens (Arabic-Indic digits, comma decimals, β/χ² symbols included). */
export function untracedStatistics(text: string, options: { strict?: boolean } = {}): string[] {
  return untracedNumbers(text, options);
}

export function renderTokens(text: string, estimates: Map<string, Formattable>): string {
  return text.replace(VALUE_TOKEN, (_whole, raw: string) => {
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
  /**
   * P1-D: the graph actor that writes the claim (a research-run step, with
   * its run and step as provenance). Must be the same user as `actor`.
   */
  actor?: graph.Actor;
}

export async function insertClaim(actor: StatsActor, projectId: string, runId: string, input: InsertClaimInput) {
  const run = await requireRun(runId, actor, 'EDITOR', projectId);
  if (run.status !== 'succeeded') throw new AppError('CONFLICT', 'Only a succeeded run can be cited.', 'يمكن الاستشهاد بتشغيل ناجح فقط.');
  const superseded = await supersedingRun(run);
  if (superseded) throw new AppError('CONFLICT', 'This run has been replaced; cite the current one.', 'استُبدل هذا التشغيل؛ استشهد بالحالي.', { reason: 'superseded', current: superseded });
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

  /* One transaction: the claim exists with all of its evidence, or not at all. */
  if (input.actor && input.actor.userId !== actor.userId) throw new AppError('FORBIDDEN', 'A claim is written on the caller’s own behalf.', 'يُكتب الادعاء باسم صاحبه فقط.');
  const claim = await graph.createClaim(projectId, input.actor ?? { userId: actor.userId }, {
    text: text.slice(0, 5000),
    label: text.slice(0, 200),
    reportIds: keys.map((key) => byKey.get(key)!.graphNodeId!),
    blockId: input.blockId ?? null,
  });
  return { claim, text, keys };
}

export { tokensIn };
