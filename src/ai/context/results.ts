/**
 * Turning saved analyses into facts the model may describe but must not produce.
 *
 * This is the piece the whole product has been building toward, and the reason
 * the results chapter was held back until now.
 *
 * Asked to write a results chapter with no data, a language model writes one
 * anyway. It produces means, standard deviations, p-values and a table that
 * looks exactly like a real one — because that is what results chapters look
 * like, and it has read thousands of them. A student pastes it into a thesis. A
 * committee reads numbers that describe a study nobody conducted. Every
 * safeguard elsewhere in this product exists to stop that one thing.
 *
 * The solution is not a better instruction. It is removing the need to invent:
 * the numbers arrive in the prompt, already computed by verified engines, and
 * the model's job shrinks to describing what it was given. That is a task
 * language models are genuinely good at, and it is bounded — there is nothing
 * to hallucinate when every figure is on the page.
 *
 * Three properties make this safe rather than merely careful.
 *
 * **Only attached results travel.** A researcher explores; they run tests they
 * end up discarding. Attaching a result to a section is a deliberate act, and
 * only what they attached becomes material for the chapter. Sending everything
 * they ever ran would let a discarded analysis reappear as a finding.
 *
 * **The figures are formatted here, not by the model.** p-values, degrees of
 * freedom and effect sizes are rendered to APA conventions in this file. The
 * model receives finished strings, so a rounding decision is never something it
 * makes — and "p = .03" cannot become "p < .001" through a lapse of attention.
 *
 * **The warnings travel with the numbers.** A result carrying a violated
 * assumption or a reverse-coded item arrives with that attached, so the chapter
 * says so. A results section that reports a coefficient while omitting that its
 * scale did not hold together is worse than no chapter at all.
 */

import type { AnalysisRun } from '@/server/db/schema';

/** APA rounding: three decimals, and "< .001" rather than a string of zeros. */
function fmtP(p: unknown): string {
  const value = typeof p === 'number' ? p : Number.NaN;
  if (!Number.isFinite(value)) return 'n/a';
  if (value < 0.001) return '< .001';
  return `= ${value.toFixed(3)}`;
}

function fmtNumber(value: unknown, digits = 3): string {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) ? number.toFixed(digits) : 'n/a';
}

function fmtDf(df: unknown): string {
  if (Array.isArray(df)) {
    const [first, second] = df as [unknown, unknown];
    return `${fmtNumber(first, 0)}, ${fmtNumber(second, 2)}`;
  }
  return fmtNumber(df, 2);
}

interface ResultShape {
  test?: string;
  variables?: string[];
  statistic?: { name?: string; value?: number };
  df?: number | [number, number];
  pValue?: number;
  effect?: { name?: string; value?: number; band?: string };
  estimates?: { label?: string; n?: number; mean?: number; sd?: number }[];
  assumptions?: { key?: string; status?: string; pValue?: number }[];
  warnings?: { code?: string; severity?: string; columns?: string[] }[];
  n?: number;
  rowsDropped?: number;
  secondary?: { label?: string; statistic?: { name?: string; value?: number }; df?: unknown; pValue?: number };
  detail?: Record<string, unknown>;
  alpha?: number;
  band?: string;
  itemCount?: number;
  sampleSize?: number;
}

/**
 * One analysis, rendered for the prompt.
 *
 * Plain text rather than JSON. A model reading "t(23.20) = -2.221, p = .036"
 * reproduces it; a model reading `{"statistic":{"value":-2.2209}}` reformats it,
 * and reformatting is where a digit gets dropped.
 */
export function describeRun(run: AnalysisRun, index: number): string {
  const result = run.result as ResultShape;
  const spec = run.spec as { columns?: Record<string, unknown> };
  const lines: string[] = [];

  lines.push(`### Analysis ${index + 1}: ${run.testKey}`);

  if (result.variables?.length) {
    lines.push(`Variables: ${result.variables.join(', ')}`);
  } else if (spec.columns) {
    lines.push(`Variables: ${JSON.stringify(spec.columns)}`);
  }

  /* Reliability has its own shape — no test statistic, no p-value. */
  if (typeof result.alpha === 'number') {
    lines.push(
      `Cronbach's alpha = ${fmtNumber(result.alpha)} (${result.band ?? 'n/a'}), ` +
        `${result.itemCount ?? 'n/a'} items, n = ${result.sampleSize ?? 'n/a'}`,
    );
  } else {
    if (result.statistic) {
      lines.push(
        `${result.statistic.name ?? 'statistic'}(${fmtDf(result.df)}) = ` +
          `${fmtNumber(result.statistic.value)}, p ${fmtP(result.pValue)}`,
      );
    }

    if (result.effect) {
      lines.push(
        `Effect size: ${result.effect.name ?? 'effect'} = ${fmtNumber(result.effect.value)} (${result.effect.band ?? 'n/a'})`,
      );
    }

    if (typeof result.n === 'number') lines.push(`n = ${result.n}`);
  }

  /*
   * The secondary form, where there is one. Included because a chapter that
   * reports Welch's t without saying Student's was also computed — and
   * disagreed — is hiding the most interesting thing about the comparison.
   */
  if (result.secondary?.statistic) {
    lines.push(
      `Secondary (${result.secondary.label ?? 'alternative'}): ` +
        `${result.secondary.statistic.name ?? 'statistic'}(${fmtDf(result.secondary.df)}) = ` +
        `${fmtNumber(result.secondary.statistic.value)}, p ${fmtP(result.secondary.pValue)}`,
    );
  }

  if (result.estimates?.length) {
    lines.push('Group statistics:');
    for (const estimate of result.estimates) {
      lines.push(
        `  - ${estimate.label ?? '?'}: n = ${estimate.n ?? '?'}, ` +
          `M = ${fmtNumber(estimate.mean, 2)}, SD = ${fmtNumber(estimate.sd, 3)}`,
      );
    }
  }

  /* Post-hoc comparisons, which are usually the substance of an ANOVA write-up. */
  const postHoc = result.detail?.postHoc;
  if (Array.isArray(postHoc) && postHoc.length > 0) {
    lines.push('Post-hoc (Tukey HSD):');
    for (const comparison of postHoc as Record<string, unknown>[]) {
      lines.push(
        `  - ${String(comparison.groupA)} vs ${String(comparison.groupB)}: ` +
          `difference = ${fmtNumber(comparison.meanDifference, 2)}, ` +
          `p ${fmtP(comparison.pValue)}${comparison.significant ? ' (significant)' : ''}`,
      );
    }
  }

  /* Regression coefficients. */
  const coefficients = result.detail?.coefficients;
  if (Array.isArray(coefficients) && coefficients.length > 0) {
    lines.push(
      `Model: R² = ${fmtNumber(result.detail?.rSquared)}, ` +
        `adjusted R² = ${fmtNumber(result.detail?.adjustedRSquared)}`,
    );
    lines.push('Coefficients:');
    for (const coefficient of coefficients as Record<string, unknown>[]) {
      lines.push(
        `  - ${String(coefficient.name)}: B = ${fmtNumber(coefficient.b)}, ` +
          `SE = ${fmtNumber(coefficient.standardError)}, ` +
          `beta = ${fmtNumber(coefficient.beta)}, p ${fmtP(coefficient.pValue)}`,
      );
    }
  }

  /* Item statistics for a reliability analysis. */
  const items = result.detail?.items ?? (result as unknown as { items?: unknown }).items;
  if (Array.isArray(items) && items.length > 0) {
    lines.push('Item statistics:');
    for (const item of items as Record<string, unknown>[]) {
      lines.push(
        `  - ${String(item.name)}: M = ${fmtNumber(item.mean, 2)}, ` +
          `corrected item-total r = ${fmtNumber(item.itemTotalCorrelation)}, ` +
          `alpha if deleted = ${fmtNumber(item.alphaIfDeleted)}`,
      );
    }
  }

  /*
   * Assumptions and warnings are not optional context. A violated assumption
   * changes what the finding means, and a chapter that omits it is reporting a
   * number without the condition attached to it.
   */
  const violated = (result.assumptions ?? []).filter((check) => check.status === 'violated');
  if (violated.length > 0) {
    lines.push(
      `Assumptions violated: ${violated
        .map((check) => `${check.key ?? '?'} (p ${fmtP(check.pValue)})`)
        .join('; ')}`,
    );
  }

  const serious = (result.warnings ?? []).filter(
    (warning) => warning.severity === 'error' || warning.severity === 'warning',
  );
  if (serious.length > 0) {
    lines.push(
      `Warnings that must be reported: ${serious
        .map((warning) => `${warning.code ?? '?'}${warning.columns?.length ? ` [${warning.columns.join(', ')}]` : ''}`)
        .join('; ')}`,
    );
  }

  if (typeof result.rowsDropped === 'number' && result.rowsDropped > 0) {
    lines.push(`Cases excluded for missing data: ${result.rowsDropped}`);
  }

  return lines.join('\n');
}

/**
 * The block that goes into the prompt.
 *
 * Returns null when nothing is attached, which is what keeps the old behaviour
 * intact: no verified results means the section still produces table shells and
 * says the numbers must come from the researcher's own analysis. The new
 * behaviour is strictly additive — it appears only when there is something real
 * to write from.
 */
export function buildResultsContext(runs: AnalysisRun[]): string | null {
  if (runs.length === 0) return null;

  const described = runs.map((run, index) => describeRun(run, index)).join('\n\n');

  return `## VERIFIED ANALYSIS RESULTS

The following were computed by this system's statistical engines from the researcher's own data. They are facts.

RULES FOR USING THEM — these override any other instruction about results:

1. Report these numbers exactly as written. Do not recompute, re-round, or adjust any figure.
2. Do not add any statistic that does not appear below. If a value the write-up would normally include is absent, say it was not computed rather than supplying one.
3. Report every violated assumption and every listed warning in the text. A finding whose assumptions failed must say so where the finding is stated, not in a footnote.
4. Describe and organise. Interpretation belongs in the discussion, not here.
5. Where a secondary form is given and disagrees with the primary one, report both and say which is being relied on.

${described}`;
}

/** Whether a section should be written from data rather than from a template. */
export function hasVerifiedResults(runs: AnalysisRun[]): boolean {
  return runs.length > 0;
}
