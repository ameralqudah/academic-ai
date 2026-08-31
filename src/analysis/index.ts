/**
 * The data layer's public surface.
 *
 * Everything above this module — routes, services, UI — imports from here and
 * from nowhere deeper, so the internals stay free to change. The layer knows
 * nothing about HTTP, the database, or the AI provider, which is what makes it
 * testable without any of them (`npm run test:analysis`).
 */

export { DataParseError, MAX_COLUMNS, MAX_ROWS, detectDelimiter, parseCsv } from './parse';
export { parseXlsx } from './parse-xlsx';
export { profileDataset } from './profile';
export { applyCleaning, planCleaning } from './clean';
export { reportToText, toCsv } from './serialize';
export {
  chiSquareCdf,
  chiSquareQuantile,
  chiSquareSf,
  fCdf,
  fQuantile,
  fSf,
  normalCdf,
  normalQuantile,
  normalSf,
  studentizedRangeCdf,
  studentizedRangeQuantile,
  studentizedRangeSf,
  tCdf,
  tQuantile,
  tSf,
  tTwoTailed,
} from './distributions';
export {
  covariance,
  kurtosis,
  mean,
  median,
  pearson,
  quantile,
  rank,
  skewness,
  spearman,
  standardDeviation,
  toNumber,
  variance,
} from './stats-core';
export { logisticRegression, LogisticError } from './inference/logistic';
export {
  kruskalWallisTest,
  mannWhitneyTest,
  NonParametricError,
  wilcoxonSignedRankTest,
} from './inference/nonparametric';
export { bandForAlpha, cronbachAlpha } from './reliability';
export {
  backSubstitute,
  identity,
  inverseFromR,
  leastSquares,
  multiply,
  multiplyVector,
  qrDecompose,
  SingularMatrixError,
  transpose,
} from './linear-algebra';
export type { Matrix, QRDecomposition, Vector } from './linear-algebra';
export { AnovaError, oneWayAnova, tukeyHsd } from './inference/anova';
export {
  chiSquareGoodnessOfFit,
  chiSquareIndependence,
  ChiSquareError,
  crossTabulate,
  fisherExact2x2,
} from './inference/chi-square';
export type { ChiSquareOptions, ContingencyTable } from './inference/chi-square';
export { correlate, correlationMatrix, CorrelationError, fisherInterval } from './inference/correlation';
export { adjustPValues, multipleComparisonRisk } from './inference/multiple-comparisons';
export type { PAdjustMethod } from './inference/multiple-comparisons';
export { recommendTest, shouldCheckReliability } from './inference/recommend';
export type {
  Recommendation,
  RecommendationConfidence,
  RoleAssignment,
  TestCandidate,
} from './inference/recommend';
export {
  durbinWatsonStatistic,
  heteroscedasticityTrend,
  linearRegression,
  RegressionError,
  varianceInflationFactors,
} from './inference/regression';
export type { RegressionCoefficient, RegressionOptions } from './inference/regression';
export type { CorrelationCell, CorrelationMatrixResult, CorrelationMethod, CorrelationOptions } from './inference/correlation';
export type { AnovaOptions, TukeyComparison } from './inference/anova';
export {
  independentTTest,
  oneSampleTTest,
  pairedTTest,
  TTestError,
} from './inference/t-test';
export type { TTestOptions } from './inference/t-test';
export {
  assessHomogeneity,
  assessNormality,
  independenceCheck,
  levene,
  shapiroWilk,
  SHAPIRO_WILK_MAX_N,
  SHAPIRO_WILK_MIN_N,
} from './inference/assumptions';
export type {
  HomogeneityAssessment,
  LeveneCenter,
  LeveneResult,
  NormalityAssessment,
  ShapiroWilkResult,
} from './inference/assumptions';
export {
  bandForCohensD,
  bandForCorrelation,
  bandForCramersV,
  bandForEtaSquared,
} from './inference/types';
export type {
  AnalysisWarning,
  AssumptionCheck,
  AssumptionKey,
  AssumptionStatus,
  ConfidenceInterval,
  EffectBand,
  EffectSize,
  GroupEstimate,
  InferentialResult,
  MissingPolicy,
  TestKey,
  VariableRole,
  VariableSpec,
} from './inference/types';
export type {
  ReliabilityBand,
  ReliabilityItem,
  ReliabilityOptions,
  ReliabilityResult,
  ReliabilityWarning,
  ReliabilityWarningCode,
} from './reliability';
export * from './types';

import { DataParseError, parseCsv } from './parse';
import { parseXlsx } from './parse-xlsx';
import type { Dataset } from './types';

/** Files this product will read. Anything else is refused with a clear reason. */
export const ACCEPTED_EXTENSIONS = ['.csv', '.tsv', '.txt', '.xlsx', '.xlsm'] as const;

/** 12 MB: comfortably larger than any survey export, small enough to parse in a request. */
export const MAX_FILE_BYTES = 12 * 1024 * 1024;

/**
 * Reads an uploaded file by looking at its name, then its bytes.
 *
 * The extension decides the reader, but a mislabelled file is common enough
 * that a workbook signature is checked too: `.csv` files renamed from Excel
 * would otherwise produce a wall of binary as "data".
 */
export async function readUpload(file: {
  name: string;
  bytes: ArrayBuffer;
}): Promise<Dataset> {
  const name = file.name.toLowerCase();
  const bytes = new Uint8Array(file.bytes);

  if (bytes.byteLength === 0) throw new DataParseError('analysis.error.emptyFile');
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new DataParseError('analysis.error.tooLarge', {
      limitMb: Math.round(MAX_FILE_BYTES / (1024 * 1024)),
    });
  }

  // Every .xlsx is a zip, and every zip starts "PK".
  const looksLikeWorkbook = bytes[0] === 0x50 && bytes[1] === 0x4b;

  /*
   * The old binary .xls format, which is not a zip and not a spreadsheet this
   * parser reads. Detected by its compound-document signature so the refusal
   * can name the real problem — "this is the old format, re-save it" — rather
   * than the useless "this is not a workbook".
   */
  const looksLikeLegacyXls =
    bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;

  if (name.endsWith('.xlsx') || name.endsWith('.xlsm') || looksLikeWorkbook) {
    if (looksLikeWorkbook) return parseXlsx(file.bytes, file.name);
    if (looksLikeLegacyXls) throw new DataParseError('analysis.error.legacyXls');

    /*
     * Named .xlsx and holding something else. Before rejecting it, check
     * whether it is actually delimited text: a spreadsheet exported as CSV and
     * then renamed — or renamed by an email client — is a common enough
     * accident that reading it is far better service than refusing it.
     *
     * The test is deliberately narrow. The first line must decode as text and
     * contain a delimiter, which a binary file will fail. Guessing wrong here
     * would mean showing a wall of binary as "data", so the check errs toward
     * refusing.
     */
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 4096));
    const firstLine = head.split(/\r?\n/)[0] ?? '';
    const looksDelimited =
      firstLine.length > 0 &&
      /[,;\t]/.test(firstLine) &&
      !/[\u0000-\u0008\u000e-\u001f]/.test(firstLine);

    if (looksDelimited) {
      return parseCsv(new TextDecoder('utf-8').decode(bytes), file.name);
    }

    throw new DataParseError('analysis.error.notAWorkbook');
  }

  if (!ACCEPTED_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    throw new DataParseError('analysis.error.unsupportedType');
  }

  const text = new TextDecoder('utf-8').decode(bytes);
  return parseCsv(text, file.name);
}
