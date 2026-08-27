/**
 * Chi-square: the test for relationships between categorical variables.
 *
 * This is the test students reach for when nothing is measured on a scale —
 * does programme of study relate to whether a graduate found work, does gender
 * relate to preferred learning method — and it is the one whose assumptions are
 * most often quietly broken.
 *
 * **The assumption that matters is about expected counts, not observed ones.**
 * χ² compares what was observed against what independence would predict, and
 * the statistic's null distribution is only approximately chi-square. That
 * approximation degrades when the *predicted* counts are small, regardless of
 * how many respondents there are in total. The standard rule — no expected
 * count below 5, and none below 1 at all — is enforced here rather than
 * mentioned, because a 4×5 table from three hundred respondents can easily have
 * a cell expecting 2.3 and nothing on screen would say so.
 *
 * **When the approximation fails on a 2×2 table, there is an exact answer.**
 * Fisher's exact test computes the probability directly from the
 * hypergeometric distribution instead of approximating it, so it is correct at
 * any cell size. It is computed automatically for 2×2 tables whose expected
 * counts are too small, and reported as the primary result in that case.
 *
 * **A significant χ² says almost nothing about strength.** The statistic scales
 * with sample size: the same pattern of association in a table of 1,000 gives a
 * χ² ten times that of a table of 100. Cramér's V rescales it to a 0–1 measure
 * that does not, and it is what a reader should actually be given.
 */

import { chiSquareSf, logGamma } from '../distributions';
import { bandForCramersV, type AnalysisWarning, type AssumptionCheck, type InferentialResult } from './types';
import { independenceCheck } from './assumptions';

/** Cells expecting fewer than this weaken the approximation. */
const MIN_EXPECTED = 5;
/** Cells expecting fewer than this break it outright. */
const CRITICAL_EXPECTED = 1;
/** The share of cells allowed below MIN_EXPECTED before the result is unsafe. */
const MAX_SPARSE_SHARE = 0.2;
/** Above this total, Fisher's exact test is too slow and unnecessary. */
const FISHER_MAX_N = 1000;

export class ChiSquareError extends Error {
  constructor(
    readonly reasonKey: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(reasonKey);
    this.name = 'ChiSquareError';
  }
}

export interface ContingencyTable {
  rowLabels: string[];
  columnLabels: string[];
  /** observed[row][column] */
  observed: number[][];
}

/* -------------------------------------------------------------------------- */
/*                          Building the table                                */
/* -------------------------------------------------------------------------- */

/**
 * Cross-tabulates two categorical columns.
 *
 * Rows where either value is missing are dropped: a respondent who gave their
 * programme but not their employment status belongs in no cell of the table.
 */
export function crossTabulate(
  rowValues: (string | number | null)[],
  columnValues: (string | number | null)[],
  labels: [string, string],
): { table: ContingencyTable; used: number; dropped: number } {
  if (rowValues.length !== columnValues.length) {
    throw new ChiSquareError('analysis.chiSquare.error.lengthMismatch', {
      first: rowValues.length,
      second: columnValues.length,
    });
  }

  const rowLevels: string[] = [];
  const columnLevels: string[] = [];
  const counts = new Map<string, number>();
  let used = 0;

  for (let i = 0; i < rowValues.length; i += 1) {
    const rawRow = rowValues[i];
    const rawColumn = columnValues[i];
    if (rawRow === null || rawRow === undefined || rawColumn === null || rawColumn === undefined) continue;

    const rowKey = String(rawRow).trim();
    const columnKey = String(rawColumn).trim();
    if (rowKey === '' || columnKey === '') continue;

    if (!rowLevels.includes(rowKey)) rowLevels.push(rowKey);
    if (!columnLevels.includes(columnKey)) columnLevels.push(columnKey);

    const key = `${rowKey}\u0000${columnKey}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    used += 1;
  }

  if (rowLevels.length < 2 || columnLevels.length < 2) {
    throw new ChiSquareError('analysis.chiSquare.error.tooFewLevels', {
      variable: rowLevels.length < 2 ? labels[0] : labels[1],
      levels: Math.min(rowLevels.length, columnLevels.length),
    });
  }

  rowLevels.sort();
  columnLevels.sort();

  const observed = rowLevels.map((row) =>
    columnLevels.map((column) => counts.get(`${row}\u0000${column}`) ?? 0),
  );

  return {
    table: { rowLabels: rowLevels, columnLabels: columnLevels, observed },
    used,
    dropped: rowValues.length - used,
  };
}

/* -------------------------------------------------------------------------- */
/*                        Chi-square test of independence                     */
/* -------------------------------------------------------------------------- */

export interface ChiSquareOptions {
  /**
   * Yates' continuity correction for 2×2 tables. Default true, matching SPSS's
   * "Continuity Correction" row and every textbook that discusses 2×2 tables.
   * It is conservative — see the note where it is applied.
   */
  yatesCorrection?: boolean;
  /** Skip Fisher's exact test even when the expected counts call for it. */
  skipExact?: boolean;
}

export function chiSquareIndependence(
  table: ContingencyTable,
  variableNames: [string, string],
  options: ChiSquareOptions = {},
  rowsSupplied?: number,
): InferentialResult {
  const { observed, rowLabels, columnLabels } = table;
  const rows = rowLabels.length;
  const columns = columnLabels.length;

  if (rows < 2 || columns < 2) {
    throw new ChiSquareError('analysis.chiSquare.error.tooFewLevels', {
      variable: rows < 2 ? variableNames[0] : variableNames[1],
      levels: Math.min(rows, columns),
    });
  }

  const rowTotals = observed.map((row) => row.reduce((sum, value) => sum + value, 0));
  const columnTotals = Array.from({ length: columns }, (_, column) =>
    observed.reduce((sum, row) => sum + (row[column] as number), 0),
  );
  const n = rowTotals.reduce((sum, value) => sum + value, 0);

  if (n === 0) throw new ChiSquareError('analysis.chiSquare.error.emptyTable');

  const emptyRow = rowTotals.findIndex((total) => total === 0);
  const emptyColumn = columnTotals.findIndex((total) => total === 0);
  if (emptyRow >= 0 || emptyColumn >= 0) {
    throw new ChiSquareError('analysis.chiSquare.error.emptyCategory', {
      category: emptyRow >= 0 ? (rowLabels[emptyRow] as string) : (columnLabels[emptyColumn] as string),
    });
  }

  /* ------------------------------ expected counts ------------------------- */

  const expected = rowTotals.map((rowTotal) =>
    columnTotals.map((columnTotal) => (rowTotal * columnTotal) / n),
  );

  const flatExpected = expected.flat();
  const belowFive = flatExpected.filter((value) => value < MIN_EXPECTED).length;
  const belowOne = flatExpected.filter((value) => value < CRITICAL_EXPECTED).length;
  const sparseShare = belowFive / flatExpected.length;
  const minExpected = Math.min(...flatExpected);

  /* -------------------------------- statistic ----------------------------- */

  const isTwoByTwo = rows === 2 && columns === 2;
  const useYates = isTwoByTwo && options.yatesCorrection !== false;
  const df = (rows - 1) * (columns - 1);

  let statistic = 0;
  let uncorrected = 0;

  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < columns; j += 1) {
      const o = (observed[i] as number[])[j] as number;
      const e = (expected[i] as number[])[j] as number;
      if (e === 0) continue;

      uncorrected += (o - e) ** 2 / e;

      /*
       * Yates subtracts 0.5 from each absolute deviation before squaring. It
       * exists because χ² is a continuous approximation to a discrete
       * distribution, and without it a 2×2 table's p-value is too small. It is
       * known to over-correct — the resulting test is conservative, sometimes
       * markedly so — which is why Fisher's exact test is preferred outright
       * when the counts are small enough to compute it.
       */
      const deviation = useYates ? Math.max(0, Math.abs(o - e) - 0.5) : Math.abs(o - e);
      statistic += deviation ** 2 / e;
    }
  }

  const pValue = chiSquareSf(statistic, df);

  /* ------------------------------- effect size ---------------------------- */

  /*
   * Cramér's V: χ² rescaled by the sample size and the size of the table, which
   * is what makes it comparable across studies. Computed from the uncorrected
   * statistic, because the effect size describes the association in the data,
   * not the continuity-corrected test of it.
   */
  const smallerDimension = Math.min(rows, columns);
  const cramersV = Math.sqrt(uncorrected / (n * (smallerDimension - 1)));

  /* --------------------------- Fisher's exact test ------------------------ */

  /*
   * Computed for every 2×2 table small enough to afford it, not only when the
   * expected counts demand it. It is the exact answer, it costs a loop of at
   * most a few hundred terms, and having it beside the approximation lets a
   * reader see how good that approximation was. It becomes the *primary*
   * result only when the expected counts say χ² cannot be trusted.
   */
  let exact: { pValue: number; oddsRatio: number; oddsRatioCorrected: boolean } | null = null;

  if (isTwoByTwo && !options.skipExact && n <= FISHER_MAX_N) {
    exact = fisherExact2x2(observed as [number[], number[]]);
  }

  /* -------------------------------- warnings ------------------------------ */

  const warnings: AnalysisWarning[] = [];
  const assumptions: AssumptionCheck[] = [independenceCheck()];

  let expectedStatus: AssumptionCheck['status'] = 'met';

  if (belowOne > 0) {
    expectedStatus = 'violated';
    warnings.push({
      code: 'expected-count-below-one',
      severity: 'error',
      columns: [variableNames[0], variableNames[1]],
      params: { cells: belowOne, minimum: Number(minExpected.toFixed(2)) },
    });
  } else if (sparseShare > MAX_SPARSE_SHARE) {
    expectedStatus = 'violated';
    warnings.push({
      code: 'expected-counts-too-small',
      severity: 'warning',
      columns: [variableNames[0], variableNames[1]],
      params: {
        cells: belowFive,
        total: flatExpected.length,
        share: Number((sparseShare * 100).toFixed(1)),
        minimum: Number(minExpected.toFixed(2)),
      },
    });
  } else if (belowFive > 0) {
    warnings.push({
      code: 'some-expected-counts-small',
      severity: 'info',
      columns: [variableNames[0], variableNames[1]],
      params: { cells: belowFive, total: flatExpected.length, minimum: Number(minExpected.toFixed(2)) },
    });
  }

  assumptions.push({
    key: 'expected-cell-counts',
    status: expectedStatus,
    alternative: expectedStatus === 'violated' && isTwoByTwo ? 'chiSquare.independence' : undefined,
    detail: {
      minimumExpected: Number(minExpected.toFixed(3)),
      cellsBelowFive: belowFive,
      cells: flatExpected.length,
    },
  });

  /*
   * A violated expected-count assumption on a larger table has no exact
   * alternative available here. The honest advice is to merge sparse
   * categories, which is a decision about meaning that only the researcher can
   * make.
   */
  if (expectedStatus === 'violated' && !isTwoByTwo) {
    warnings.push({
      code: 'consider-merging-categories',
      severity: 'warning',
      columns: [variableNames[0], variableNames[1]],
      params: { rows, columns },
    });
  }

  if (exact?.oddsRatioCorrected) {
    warnings.push({
      code: 'odds-ratio-corrected-for-zero-cell',
      severity: 'info',
      columns: [variableNames[0], variableNames[1]],
      params: { oddsRatio: Number(exact.oddsRatio.toFixed(3)), adjustment: 0.5 },
    });
  }

  const usesExactAsPrimary = exact !== null && expectedStatus === 'violated';

  if (exact && usesExactAsPrimary) {
    warnings.push({
      code: 'exact-test-used',
      severity: 'info',
      columns: [variableNames[0], variableNames[1]],
      params: { exactP: Number(exact.pValue.toPrecision(3)), approximateP: Number(pValue.toPrecision(3)) },
    });
  }

  return {
    test: 'chiSquare.independence',
    variables: [variableNames[0], variableNames[1]],
    statistic: {
      name: useYates ? 'chi-square (Yates)' : 'chi-square',
      value: statistic,
    },
    df,
    pValue: usesExactAsPrimary && exact ? exact.pValue : pValue,
    effect: { name: 'cramersV', value: cramersV, band: bandForCramersV(cramersV, smallerDimension) },
    estimates: [],
    assumptions,
    warnings,
    n,
    rowsSupplied: rowsSupplied ?? n,
    rowsDropped: (rowsSupplied ?? n) - n,
    missingPolicy: 'listwise',
    secondary: exact
      ? {
          label: usesExactAsPrimary ? 'chi-square' : 'fisher-exact',
          statistic: usesExactAsPrimary
            ? { name: 'chi-square', value: statistic }
            : { name: 'Fisher exact', value: exact.oddsRatio },
          df: usesExactAsPrimary ? df : 0,
          pValue: usesExactAsPrimary ? pValue : exact.pValue,
          effect: null,
        }
      : undefined,
    detail: {
      primaryForm: usesExactAsPrimary ? 'fisher-exact' : useYates ? 'yates' : 'pearson',
      primaryReason: usesExactAsPrimary
        ? 'exact-required-small-expected-counts'
        : useYates
          ? 'yates-two-by-two'
          : 'pearson-standard',
      observed,
      expected,
      rowTotals,
      columnTotals,
      rowLabels,
      columnLabels,
      uncorrectedStatistic: uncorrected,
      minimumExpected: minExpected,
      cellsBelowFive: belowFive,
      cramersV,
      phi: isTwoByTwo ? Math.sqrt(uncorrected / n) : null,
      fisherExactP: exact?.pValue ?? null,
      oddsRatio: exact?.oddsRatio ?? null,
      oddsRatioCorrected: exact?.oddsRatioCorrected ?? false,
      /** Standardised residuals: which cells drive the association. */
      standardisedResiduals: observed.map((row, i) =>
        row.map((o, j) => {
          const e = (expected[i] as number[])[j] as number;
          return e === 0 ? Number.NaN : (o - e) / Math.sqrt(e);
        }),
      ),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                            Fisher's exact test                             */
/* -------------------------------------------------------------------------- */

/** log(n!) via the gamma function, which handles the sizes involved without overflow. */
function logFactorial(n: number): number {
  return logGamma(n + 1);
}

/** log of the hypergeometric probability of one 2×2 arrangement. */
function logHypergeometric(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  return (
    logFactorial(a + b) +
    logFactorial(c + d) +
    logFactorial(a + c) +
    logFactorial(b + d) -
    logFactorial(n) -
    logFactorial(a) -
    logFactorial(b) -
    logFactorial(c) -
    logFactorial(d)
  );
}

/**
 * Fisher's exact test for a 2×2 table, two-sided.
 *
 * With the margins held fixed there are only so many tables that could have
 * arisen; the p-value is the total probability of those at least as extreme as
 * the one observed. "At least as extreme" is defined by probability rather than
 * by the value of a statistic — the conventional two-sided definition, and the
 * one R and SciPy use — with a small tolerance so that arrangements which tie
 * with the observed table to within floating-point noise are counted.
 *
 * Exact, not approximate: this is the correct answer for a 2×2 table at any
 * cell size, which is why it takes over when the expected counts are too small
 * for χ² to be trusted.
 */
export function fisherExact2x2(observed: [number[], number[]]): {
  pValue: number;
  oddsRatio: number;
  /** True when a zero cell forced the Haldane–Anscombe correction. */
  oddsRatioCorrected: boolean;
} {
  const a = (observed[0] as number[])[0] as number;
  const b = (observed[0] as number[])[1] as number;
  const c = (observed[1] as number[])[0] as number;
  const d = (observed[1] as number[])[1] as number;

  const rowOne = a + b;
  const rowTwo = c + d;
  const columnOne = a + c;
  const n = rowOne + rowTwo;

  const logObserved = logHypergeometric(a, b, c, d);
  const tolerance = 1e-7;

  let total = 0;
  const lowest = Math.max(0, columnOne - rowTwo);
  const highest = Math.min(rowOne, columnOne);

  for (let x = lowest; x <= highest; x += 1) {
    const logProbability = logHypergeometric(x, rowOne - x, columnOne - x, rowTwo - columnOne + x);
    if (logProbability <= logObserved + tolerance) {
      total += Math.exp(logProbability);
    }
  }

  /*
   * The sample odds ratio, since the conditional maximum-likelihood estimate is
   * expensive and rarely what is reported. A zero in any cell makes the ratio
   * either zero or infinite, neither of which can be written in a results
   * table, so the Haldane–Anscombe correction adds a half to every cell. The
   * p-value is untouched by this — it comes from the exact enumeration above —
   * and the flag travels with the result so the correction is never silent.
   */
  const hasZeroCell = a === 0 || b === 0 || c === 0 || d === 0;
  const oddsRatio = hasZeroCell
    ? ((a + 0.5) * (d + 0.5)) / ((b + 0.5) * (c + 0.5))
    : (a * d) / (b * c);

  void n;

  return { pValue: Math.min(1, total), oddsRatio, oddsRatioCorrected: hasZeroCell };
}

/* -------------------------------------------------------------------------- */
/*                       Chi-square goodness of fit                           */
/* -------------------------------------------------------------------------- */

/**
 * Tests whether observed frequencies match an expected distribution.
 *
 * With no expectation supplied the null is a uniform one — every category
 * equally likely — which is the usual question ("are these options chosen
 * equally often?").
 */
export function chiSquareGoodnessOfFit(
  observed: number[],
  labels: string[],
  expectedProportions?: number[],
): InferentialResult {
  const k = observed.length;

  if (k < 2) {
    throw new ChiSquareError('analysis.chiSquare.error.tooFewCategories', { categories: k });
  }
  if (labels.length !== k) {
    throw new ChiSquareError('analysis.chiSquare.error.labelMismatch', {
      categories: k,
      labels: labels.length,
    });
  }

  const n = observed.reduce((sum, value) => sum + value, 0);
  if (n === 0) throw new ChiSquareError('analysis.chiSquare.error.emptyTable');

  let proportions: number[];
  if (expectedProportions) {
    if (expectedProportions.length !== k) {
      throw new ChiSquareError('analysis.chiSquare.error.expectedMismatch', {
        categories: k,
        expected: expectedProportions.length,
      });
    }
    const sum = expectedProportions.reduce((total, value) => total + value, 0);
    if (Math.abs(sum - 1) > 1e-6) {
      throw new ChiSquareError('analysis.chiSquare.error.proportionsDoNotSumToOne', {
        sum: Number(sum.toFixed(4)),
      });
    }
    proportions = expectedProportions;
  } else {
    proportions = new Array<number>(k).fill(1 / k);
  }

  const expected = proportions.map((proportion) => proportion * n);
  const statistic = observed.reduce(
    (sum, value, i) => sum + (value - (expected[i] as number)) ** 2 / (expected[i] as number),
    0,
  );
  const df = k - 1;
  const pValue = chiSquareSf(statistic, df);

  const belowFive = expected.filter((value) => value < MIN_EXPECTED).length;
  const warnings: AnalysisWarning[] = [];

  if (belowFive > 0) {
    warnings.push({
      code: 'expected-counts-too-small',
      severity: belowFive / k > MAX_SPARSE_SHARE ? 'warning' : 'info',
      columns: labels,
      params: { cells: belowFive, total: k, minimum: Number(Math.min(...expected).toFixed(2)) },
    });
  }

  /* Cohen's w, the goodness-of-fit effect size. */
  const w = Math.sqrt(statistic / n);

  return {
    test: 'chiSquare.goodnessOfFit',
    variables: labels,
    statistic: { name: 'chi-square', value: statistic },
    df,
    pValue,
    effect: { name: 'cohensW', value: w, band: bandForCramersV(w, 2) },
    estimates: [],
    assumptions: [
      independenceCheck(),
      {
        key: 'expected-cell-counts',
        status: belowFive / k > MAX_SPARSE_SHARE ? 'violated' : 'met',
        detail: { minimumExpected: Number(Math.min(...expected).toFixed(3)), cellsBelowFive: belowFive },
      },
    ],
    warnings,
    n,
    rowsSupplied: n,
    rowsDropped: 0,
    missingPolicy: 'listwise',
    detail: {
      observed,
      expected,
      expectedProportions: proportions,
      cohensW: w,
      standardisedResiduals: observed.map(
        (value, i) => (value - (expected[i] as number)) / Math.sqrt(expected[i] as number),
      ),
    },
  };
}
