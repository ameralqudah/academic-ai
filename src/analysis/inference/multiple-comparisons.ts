/**
 * Adjusting p-values for a family of comparisons.
 *
 * Nothing in this product applies any of these automatically, and that is the
 * central design decision rather than an omission. The correct family depends
 * on the hypothesis, which no function can infer: a researcher testing three
 * pre-registered relationships and one exploring all forty-five cells of a
 * matrix need different corrections, and silently applying Bonferroni to a
 * matrix that was always meant to be descriptive would bury real effects under
 * a correction the researcher never asked for.
 *
 * So the default is `none`, the number of comparisons and the expected count of
 * false positives are always reported, and the choice of correction is offered
 * to the researcher as a deliberate act.
 *
 * The three methods differ in what they control and how much power they cost:
 *
 * | Method | Controls | Cost |
 * | --- | --- | --- |
 * | Bonferroni | Family-wise error rate | Highest; simple and very conservative |
 * | Holm | Family-wise error rate | Uniformly better than Bonferroni — never less powerful, never less valid |
 * | Benjamini–Hochberg | False discovery rate | Lowest; a different guarantee, not a weaker version of the same one |
 *
 * Holm dominates Bonferroni mathematically: it controls the same error rate and
 * rejects at least as many hypotheses. Bonferroni is offered anyway because it
 * is what supervisors and reviewers recognise, and a correction nobody will
 * accept is not useful however elegant.
 *
 * Benjamini–Hochberg answers a different question. Rather than "what is the
 * chance of any false positive at all", it bounds the expected *proportion* of
 * false positives among the results called significant. For exploratory work
 * with many comparisons that is usually the more sensible target, but it is a
 * genuinely different claim and should be described as such when reported.
 */

export type PAdjustMethod = 'none' | 'bonferroni' | 'holm' | 'benjamini-hochberg';

/**
 * Returns adjusted p-values in the same order as the input.
 *
 * Every method here is monotone-enforced: an adjusted p is never allowed to
 * fall below one that came from a smaller raw p. Without that step the step-down
 * procedures can produce orderings that contradict the raw values, which reads
 * as a bug even when the arithmetic is right.
 */
export function adjustPValues(pValues: number[], method: PAdjustMethod): number[] {
  const m = pValues.length;
  if (m === 0) return [];
  if (method === 'none') return [...pValues];

  const indexed = pValues.map((p, index) => ({ p, index }));

  switch (method) {
    case 'bonferroni':
      return pValues.map((p) => Math.min(1, p * m));

    case 'holm': {
      // Step down: sort ascending, multiply by (m − rank), enforce monotonicity.
      indexed.sort((a, b) => a.p - b.p);
      const adjusted = new Array<number>(m).fill(0);
      let running = 0;

      for (let rank = 0; rank < m; rank += 1) {
        const entry = indexed[rank] as { p: number; index: number };
        const value = Math.min(1, (m - rank) * entry.p);
        running = Math.max(running, value);
        adjusted[entry.index] = running;
      }

      return adjusted;
    }

    case 'benjamini-hochberg': {
      // Step up: sort descending, multiply by m / rank, enforce monotonicity.
      indexed.sort((a, b) => b.p - a.p);
      const adjusted = new Array<number>(m).fill(0);
      let running = 1;

      for (let position = 0; position < m; position += 1) {
        const entry = indexed[position] as { p: number; index: number };
        const rank = m - position;
        const value = Math.min(1, (m / rank) * entry.p);
        running = Math.min(running, value);
        adjusted[entry.index] = running;
      }

      return adjusted;
    }

    default:
      return [...pValues];
  }
}

/**
 * What a family of unadjusted comparisons risks, in numbers a reader can weigh.
 *
 * `expectedFalsePositives` is the count of significant results that would be
 * expected from noise alone if every null hypothesis were true. Set against the
 * number actually found, it is the most useful single line that can be said
 * about an unadjusted matrix: "fifteen comparisons, three significant, and
 * about one expected by chance" tells a researcher far more than a correction
 * applied without explanation.
 */
export function multipleComparisonRisk(
  pValues: number[],
  alpha = 0.05,
): { comparisons: number; significant: number; expectedFalsePositives: number } {
  const comparisons = pValues.length;
  return {
    comparisons,
    significant: pValues.filter((p) => p < alpha).length,
    expectedFalsePositives: Number((comparisons * alpha).toFixed(2)),
  };
}
