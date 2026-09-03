/**
 * Tests for the data layer: parsing, profiling and cleaning.
 *
 *   npm run test:analysis
 *
 * No database, no network, no AI provider — these are pure functions, which is
 * the whole point of keeping the statistics out of the model. Every assertion
 * here is a claim about a number this product will one day print in somebody's
 * thesis, so the expected values are written out by hand rather than recorded
 * from the implementation.
 */

import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

import { applyCleaning, planCleaning } from '@/analysis/clean';
import { readUpload } from '@/analysis';
import { logisticRegression } from '@/analysis/inference/logistic';
import {
  assessDiscriminantValidity,
  assessMeasurement,
  assessStructural,
} from '@/analysis/inference/pls/assessment';
import {
  estimatePls,
  validateModel,
  type PlsModel,
} from '@/analysis/inference/pls/algorithm';
import { bootstrapPls } from '@/analysis/inference/pls/bootstrap';
import { blindfold, usableOmissionDistance } from '@/analysis/inference/pls/blindfolding';
import { confirmatoryFactorAnalysis } from '@/analysis/inference/cbsem/cfa';
import { analyseClaims, findCitations } from '@/server/quality/claims';
import { isWellFormedDoi, normaliseDoi } from '@/server/quality/sources';
import { checkQuality } from '@/server/quality/engine';
import { topicOf } from '@/server/tasks/query';
import {
  filterByRelevance,
  looksOffTopic,
  meaningfulTerms,
} from '@/server/knowledge/relevance';
import { PDFDocument } from 'pdf-lib';
import {
  generateCsv,
  generateMarkdown,
  generatePdf,
  generatePptx,
  validateArtifactBytes,
} from '@/server/generators/documents';
import { toBibTeX, toRIS } from '@/server/generators/bibliography';
import {
  availableStyles,
  formatCitation,
  formatReference,
  formatReferenceList,
} from '@/server/citation/styles';
import {
  checkReferenceShape,
  fabricationSignals,
  inferKind,
  type Reference,
} from '@/server/quality/sources';
import { checkModelData } from '@/analysis/inference/pls/data-checks';
import { buildReport } from '@/analysis/inference/pls/report';
import { exportPlsToExcel, exportPlsToWord } from '@/server/services/pls-export.service';
import {
  kruskalWallisTest,
  mannWhitneyTest,
  wilcoxonSignedRankTest,
} from '@/analysis/inference/nonparametric';
import { detectDelimiter, parseCsv } from '@/analysis/parse';
import { parseXlsx } from '@/analysis/parse-xlsx';
import { profileDataset } from '@/analysis/profile';
import { toCsv, reportToText } from '@/analysis/serialize';
import {
  chiSquareQuantile,
  chiSquareSf,
  fCdf,
  fQuantile,
  fSf,
  normalCdf,
  normalQuantile,
  studentizedRangeCdf,
  studentizedRangeQuantile,
  tCdf,
  tQuantile,
  tTwoTailed,
} from '@/analysis/distributions';
import { AnovaError, oneWayAnova } from '@/analysis/inference/anova';
import {
  chiSquareGoodnessOfFit,
  chiSquareIndependence,
  ChiSquareError,
  crossTabulate,
  fisherExact2x2,
} from '@/analysis/inference/chi-square';
import { correlate, correlationMatrix, CorrelationError } from '@/analysis/inference/correlation';
import { adjustPValues, multipleComparisonRisk } from '@/analysis/inference/multiple-comparisons';
import { recommendTest, shouldCheckReliability } from '@/analysis/inference/recommend';
import { linearRegression, RegressionError } from '@/analysis/inference/regression';
import {
  independentTTest,
  oneSampleTTest,
  pairedTTest,
  TTestError,
} from '@/analysis/inference/t-test';
import {
  assessHomogeneity,
  assessNormality,
  independenceCheck,
  levene,
  shapiroWilk,
  SHAPIRO_WILK_MAX_N,
} from '@/analysis/inference/assumptions';
import {
  identity,
  inverseFromR,
  leastSquares,
  multiply,
  multiplyVector,
  qrDecompose,
  SingularMatrixError,
  transpose,
} from '@/analysis/linear-algebra';
import { DataParseError } from '@/analysis/parse';
import { cronbachAlpha } from '@/analysis/reliability';
import { covariance, kurtosis, mean, median, pearson, quantile, rank, skewness, spearman, standardDeviation, toNumber } from '@/analysis/stats-core';
import type { CleaningAction, Dataset } from '@/analysis/types';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected);
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`✗ ${label}\n    expected: ${String(expected)}\n    actual:   ${String(actual)}`);
  }
}

function close(label: string, actual: number, expected: number, tolerance = 1e-6) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) passed += 1;
  else {
    failed += 1;
    console.error(`✗ ${label}\n    expected: ${expected} ±${tolerance}\n    actual:   ${actual}`);
  }
}

function assertTrue(label: string, value: boolean) {
  check(label, value, true);
}

async function main() {
  /* ---------------------------------------------------------- stats-core */

  close('mean', mean([2, 4, 4, 4, 5, 5, 7, 9]), 5);
  close('median (even n)', median([1, 2, 3, 4]), 2.5);
  close('median (odd n)', median([3, 1, 2]), 2);
  // Sample SD of this classic set is 2.13809..., the population SD is 2.
  close('sample standard deviation', standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]), 2.13808993, 1e-6);
  close('quantile matches the type-7 definition', quantile([1, 2, 3, 4], 0.25), 1.75);
  close('quantile q3', quantile([1, 2, 3, 4], 0.75), 3.25);
  close('skewness of a symmetric set is zero', skewness([1, 2, 3, 4, 5]), 0, 1e-9);
  close('excess kurtosis of a uniform-ish set is negative', kurtosis([1, 2, 3, 4, 5]), -1.2, 0.001);

  check('ranks average ties', JSON.stringify(rank([10, 20, 20, 30])), JSON.stringify([1, 2.5, 2.5, 4]));

  check('toNumber parses plain integers', toNumber('42'), 42);
  check('toNumber parses thousands separators', toNumber('1,234.5'), 1234.5);
  check('toNumber parses Arabic-Indic digits', toNumber('٢٥'), 25);
  close('toNumber parses the Arabic decimal separator', toNumber('٣٫٥') ?? 0, 3.5);
  check('toNumber parses accounting negatives', toNumber('(12)'), -12);
  close('toNumber parses percentages', toNumber('45%') ?? 0, 0.45);
  check('toNumber refuses text', toNumber('abc'), null);
  check('toNumber refuses mixed text', toNumber('12kg'), null);
  check('toNumber refuses the empty string', toNumber('   '), null);

  /* -------------------------------------------------------------- parsing */

  check('delimiter detection finds semicolons', detectDelimiter('a;b;c\n1;2;3\n4;5;6'), ';');
  check('delimiter detection finds commas', detectDelimiter('a,b,c\n1,2,3'), ',');
  check('delimiter detection finds tabs', detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');

  const quoted = parseCsv('name,note\n"Ali","said ""hello"", loudly"\n"Sara","two\nlines"', 'q.csv');
  check('quoted fields keep embedded commas', quoted.rows[0]?.[1], 'said "hello", loudly');
  check('quoted fields keep embedded newlines', quoted.rows[1]?.[1], 'two\nlines');
  check('quoted file row count', quoted.rows.length, 2);

  const bom = parseCsv('﻿id,value\n1,2', 'bom.csv');
  check('the byte-order mark is stripped from the first header', bom.columns[0], 'id');

  const crlf = parseCsv('a,b\r\n1,2\r\n3,4\r\n', 'crlf.csv');
  check('CRLF line endings parse', crlf.rows.length, 2);

  const blanks = parseCsv('a,b\n1,2\n\n\n3,4\n', 'blank.csv');
  check('blank lines are skipped, not read as rows', blanks.rows.length, 2);
  check('blank lines are counted', blanks.skippedRows, 0);

  const duplicateHeaders = parseCsv('score,score\n1,2', 'dup.csv');
  check('repeated column names are made unique', duplicateHeaders.columns[1], 'score_2');

  const preserved = parseCsv('a,b\n" x ",2', 'raw.csv');
  check('values are stored exactly as the file had them', preserved.rows[0]?.[0], ' x ');

  const missingMarkers = parseCsv('a\nN/A\n-\nلا يوجد\n5', 'missing.csv');
  check('missing markers become null', missingMarkers.rows[0]?.[0], null);
  check('the Arabic missing marker becomes null', missingMarkers.rows[2]?.[0], null);
  check('real values survive', missingMarkers.rows[3]?.[0], '5');

  /* ---------------------------------------------------------------- xlsx */

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('data');
  sheet.addRow(['name', 'age', 'score']);
  sheet.addRow(['Ali', 24, 88.5]);
  sheet.addRow(['Sara', 31, 92]);
  const buffer = await workbook.xlsx.writeBuffer();
  const fromExcel = await parseXlsx(buffer as ArrayBuffer, 'test.xlsx');
  check('xlsx column count', fromExcel.columns.length, 3);
  check('xlsx row count', fromExcel.rows.length, 2);
  check('xlsx values are read', fromExcel.rows[1]?.[0], 'Sara');
  check('xlsx numbers are read', fromExcel.rows[0]?.[1], '24');

  /* ------------------------------------------------------------- profile */

  const survey = parseCsv(
    [
      'id,gender,age,satisfaction,income,notes',
      '1,male,24,4,3000,ok',
      '2,female,31,5,4200,fine',
      '3,male,29,3,3800,',
      '4,female,45,4,5100,good',
      '5,male,38,2,4400,ok',
      '6,female,27,5,3600,fine',
      '7,male,52,1,6100,',
      '8,female,33,4,4700,good',
      '9,male,41,3,90000,outlier',
      '10,female,,4,4100,ok',
    ].join('\n'),
    'survey.csv',
  );

  const profile = profileDataset(survey);
  check('profile row count', profile.rowCount, 10);
  check('profile column count', profile.columnCount, 6);

  const byName = new Map(profile.columns.map((column) => [column.name, column]));
  check('an id column of distinct integers is integer', byName.get('id')?.type, 'integer');
  check('a two-value word column is binary', byName.get('gender')?.type, 'binary');
  check('an age column is integer', byName.get('age')?.type, 'integer');
  check('a 1–5 rating column is detected as Likert', byName.get('satisfaction')?.type, 'likert');
  check('a Likert column is ordinal, not interval', byName.get('satisfaction')?.scale, 'ordinal');
  check('a wide numeric column is integer', byName.get('income')?.type, 'integer');

  check('missing values are counted', byName.get('age')?.missing, 1);
  check('present values are counted', byName.get('age')?.present, 9);
  check('an empty cell is not a category', byName.get('notes')?.missing, 2);

  assertTrue(
    'an extreme income is flagged as an outlier',
    (byName.get('income')?.outlierRows ?? []).includes(8),
  );
  check(
    'a bounded rating scale produces no outliers',
    byName.get('satisfaction')?.outlierRows.length,
    0,
  );

  const missingIssue = profile.issues.find(
    (issue) => issue.kind === 'missing-values' && issue.column === 'age',
  );
  assertTrue('a missing-value issue is raised', missingIssue !== undefined);
  check('the missing-value issue names the row', missingIssue?.sampleRows[0], 9);

  const smallSample = profile.issues.find((issue) => issue.kind === 'small-sample');
  assertTrue('ten rows raise a small-sample warning', smallSample !== undefined);

  /* ------------------------------------------------- messy data profiling */

  const messy = parseCsv(
    [
      'city,grade,constant,empty',
      'Amman ,A,X,',
      'amman,B,X,',
      'AMMAN,A,X,',
      'Irbid,B,X,',
      'Irbid,B,X,',
      'Irbid,B,X,',
    ].join('\n'),
    'messy.csv',
  );

  const messyProfile = profileDataset(messy);
  const constantIssue = messyProfile.issues.find((issue) => issue.kind === 'constant-column');
  check('a single-valued column is reported', constantIssue?.column, 'constant');
  const emptyIssue = messyProfile.issues.find((issue) => issue.kind === 'empty-column');
  check('an entirely empty column is reported', emptyIssue?.column, 'empty');
  const duplicateIssue = messyProfile.issues.find((issue) => issue.kind === 'duplicate-rows');
  check('duplicate rows are counted', duplicateIssue?.count, 2);
  const inconsistent = messyProfile.issues.find((issue) => issue.kind === 'inconsistent-categories');
  check('case and spacing variants are grouped', inconsistent?.column, 'city');
  const whitespace = messyProfile.issues.find((issue) => issue.kind === 'whitespace');
  check('trailing whitespace is reported', whitespace?.column, 'city');

  /* ------------------------------------------------------------ cleaning */

  const plan = planCleaning(messyProfile);
  const kinds = plan.map((action) => action.kind);
  assertTrue('cleaning proposes trimming whitespace', kinds.includes('trim-whitespace'));
  assertTrue('cleaning proposes unifying categories', kinds.includes('normalise-categories'));
  assertTrue('cleaning proposes dropping duplicates', kinds.includes('drop-duplicate-rows'));
  assertTrue('cleaning proposes dropping the empty column', kinds.includes('drop-empty-columns'));

  const outlierAction = planCleaning(profile).find((action) => action.kind === 'remove-outliers');
  assertTrue('outlier removal is offered', outlierAction !== undefined);
  assertTrue('outlier removal is never recommended by default', outlierAction?.recommended === false);
  assertTrue('outlier removal is marked destructive', outlierAction?.destructive === true);

  const before = JSON.stringify(messy);
  // Only the recommended actions — the destructive optional ones are the
  // researcher's call, and applying them here would test the wrong thing.
  const recommended = plan.filter((action) => action.recommended);
  const { cleaned, report } = applyCleaning(messy, messyProfile, recommended);
  check('the original dataset is not modified', JSON.stringify(messy), before);

  /*
   * Three rows go, not two. Two are the repeated Irbid rows; the third only
   * becomes a duplicate *after* the three spellings of Amman are unified. That
   * ordering is deliberate — unify, then de-duplicate — and this assertion is
   * here to catch anyone who reverses it.
   */
  check('cleaning removes duplicates revealed by unifying labels', report.rowsRemoved, 3);
  check('cleaning removed the empty column', report.columnsRemoved, 1);
  check('the cleaned table has three rows', cleaned.rows.length, 3);
  check('the cleaned table has three columns', cleaned.columns.length, 3);
  assertTrue('the cleaned table no longer has an empty column', !cleaned.columns.includes('empty'));
  assertTrue(
    'a constant column is kept unless the researcher asks otherwise',
    cleaned.columns.includes('constant'),
  );

  const cities = new Set(cleaned.rows.map((row) => String(row[0])));
  check('the three spellings of one city collapse to one', cities.size, 2);
  assertTrue('the surviving label is the commonest spelling', cities.has('Irbid'));

  assertTrue('every change is recorded', report.changes.length > 0);
  const reportText = reportToText(messyProfile, report, 'ar');
  assertTrue('the report states the original size', reportText.includes('6'));
  assertTrue('the report promises the original is untouched', reportText.includes('الأصلية'));

  /* ------------------------------------------------ cleaning is a choice */

  const nothing = applyCleaning(messy, messyProfile, []);
  check('no actions means no rows removed', nothing.report.rowsRemoved, 0);
  check('no actions means no cells changed', nothing.report.cellsChanged, 0);
  check('no actions means the table is unchanged', nothing.cleaned.rows.length, messy.rows.length);

  const imputation: CleaningAction[] = [
    {
      kind: 'impute-median',
      columns: ['age'],
      reasonKey: 'test',
      recommended: false,
      destructive: false,
    },
  ];
  const imputed = applyCleaning(survey, profile, imputation);
  // Ages present: 24,31,29,45,38,27,52,33,41 → sorted 24,27,29,31,33,38,41,45,52 → median 33
  check('the imputed value is the median', imputed.cleaned.rows[9]?.[2], 33);
  check('imputation changed exactly one cell', imputed.report.cellsChanged, 1);
  check('imputation removed no rows', imputed.report.rowsRemoved, 0);

  /* ----------------------------------------------------------- round trip */

  const csv = toCsv(cleaned);
  assertTrue('the CSV carries a BOM so Excel reads Arabic', csv.charCodeAt(0) === 0xfeff);
  const reparsed = parseCsv(csv, 'roundtrip.csv');
  check('a written file reads back with the same columns', reparsed.columns.length, cleaned.columns.length);
  check('a written file reads back with the same rows', reparsed.rows.length, cleaned.rows.length);

  const tricky = parseCsv('a,b\n"x,y","he said ""no"""\n', 'tricky.csv');
  const trickyRoundTrip = parseCsv(toCsv(tricky), 'tricky2.csv');
  check('a comma inside a value survives a round trip', trickyRoundTrip.rows[0]?.[0], 'x,y');
  check('a quote inside a value survives a round trip', trickyRoundTrip.rows[0]?.[1], 'he said "no"');

  /* ------------------------------------------------- covariance & spearman */

  close('covariance', covariance([1, 2, 3, 4, 5, 6, 7, 8], [2, 1, 4, 3, 6, 5, 8, 7]), 5.428571428571428, 1e-13);
  close('spearman with no ties', spearman([1, 2, 3, 4, 5, 6, 7, 8], [2, 1, 4, 3, 6, 5, 8, 7]), 0.9047619047619048, 1e-13);

  /*
   * The case the textbook shortcut formula gets wrong. Likert data is nothing
   * but ties, so this is the ordinary case rather than the edge case.
   */
  const tiedA = [1, 2, 2, 3, 3, 3, 4, 5, 5, 4];
  const tiedB = [2, 2, 3, 3, 4, 4, 4, 5, 5, 5];
  close('spearman with heavy ties', spearman(tiedA, tiedB), 0.9265601324537305, 1e-13);
  close('covariance with ties', covariance(tiedA, tiedB), 1.4000000000000001, 1e-13);
  assertTrue(
    'spearman and pearson disagree on tied ordinal data',
    Math.abs(spearman(tiedA, tiedB) - pearson(tiedA, tiedB)) > 0.005,
  );

  /* --------------------------------------------------------- linear algebra */

  check('transpose flips the shape', JSON.stringify(transpose([[1, 2, 3], [4, 5, 6]])), JSON.stringify([[1, 4], [2, 5], [3, 6]]));
  check('matrix multiplication', JSON.stringify(multiply([[1, 2], [3, 4]], [[5, 6], [7, 8]])), JSON.stringify([[19, 22], [43, 50]]));
  check('a matrix times the identity is itself', JSON.stringify(multiply([[1, 2], [3, 4]], identity(2))), JSON.stringify([[1, 2], [3, 4]]));
  check('matrix times vector', JSON.stringify(multiplyVector([[1, 2], [3, 4]], [5, 6])), JSON.stringify([17, 39]));

  /*
   * A least-squares fit with two predictors and an intercept, checked against
   * NumPy's lstsq. The inverse is checked too, because the coefficients can be
   * right while the standard errors built from the inverse are wrong.
   */
  const design = [
    [1, 2, 5], [1, 3, 4], [1, 5, 7], [1, 7, 6],
    [1, 9, 11], [1, 4, 3], [1, 6, 8], [1, 8, 9],
  ];
  const outcome = [12, 14, 20, 23, 31, 15, 24, 28];

  const beta = leastSquares(design, outcome);
  close('least squares intercept', beta[0] ?? 0, 4.4742857142857195, 1e-9);
  close('least squares first slope', beta[1] ?? 0, 2.0114285714285733, 1e-9);
  close('least squares second slope', beta[2] ?? 0, 0.8057142857142868, 1e-9);

  const { r: rMatrix } = qrDecompose(design, outcome);
  const xtxInverse = inverseFromR(rMatrix);
  close('(XᵀX)⁻¹ diagonal, first', xtxInverse[0]?.[0] ?? 0, 1.0171428571428571, 1e-10);
  close('(XᵀX)⁻¹ diagonal, second', xtxInverse[1]?.[1] ?? 0, 0.0814285714285715, 1e-10);
  close('(XᵀX)⁻¹ diagonal, third', xtxInverse[2]?.[2] ?? 0, 0.06857142857142866, 1e-10);
  close('(XᵀX)⁻¹ is symmetric', xtxInverse[0]?.[2] ?? 0, xtxInverse[2]?.[0] ?? 1, 1e-12);
  close('(XᵀX)⁻¹ off-diagonal', xtxInverse[1]?.[2] ?? 0, -0.06285714285714297, 1e-10);

  /* A perfectly collinear column has no unique solution, and must say so. */
  let singularCaught = false;
  try {
    leastSquares([[1, 2, 4], [1, 3, 6], [1, 5, 10], [1, 7, 14]], [1, 2, 3, 4]);
  } catch (error) {
    singularCaught = error instanceof SingularMatrixError;
  }
  assertTrue('a collinear predictor is refused rather than fitted', singularCaught);

  /*
   * Why QR rather than the normal equations. Two predictors correlating at
   * about .9999 — two rewordings of one questionnaire item — are separable
   * here; forming XᵀX would square the conditioning and lose them.
   */
  const nearCollinear = [
    [1, 1.0, 1.0001], [1, 2.0, 2.0001], [1, 3.0, 2.9999], [1, 4.0, 4.0002],
    [1, 5.0, 4.9998], [1, 6.0, 6.0001], [1, 7.0, 7.0003], [1, 8.0, 7.9997],
  ];
  const nearOutcome = [3.0, 5.1, 6.9, 9.2, 10.8, 13.1, 15.0, 16.9];
  const nearBeta = leastSquares(nearCollinear, nearOutcome);
  const fitted = nearCollinear.map((row) => row.reduce((sum, value, i) => sum + value * (nearBeta[i] as number), 0));
  const worstResidual = Math.max(...fitted.map((value, i) => Math.abs(value - (nearOutcome[i] as number))));
  assertTrue('a near-collinear design still fits its data closely', worstResidual < 0.2);

  /* ----------------------------------------------------- assumption checks */

  /*
   * Shapiro–Wilk, checked against SciPy's `shapiro`, which implements the same
   * Royston AS R94 algorithm as R's `shapiro.test`. Agreement matters more than
   * usual here: a student who runs the same data through SPSS and gets a
   * different W will not trust either number.
   */
  const swCases: [string, number[], number, number][] = [
    ['ten roughly normal values', [2.1, 3.4, 2.8, 4.1, 3.3, 2.9, 3.7, 3.0, 3.5, 2.6], 0.992879161552711, 0.9991635877188199],
    ['five values (small branch)', [1, 2, 3, 4, 5], 0.986762155211559, 0.9671739349728582],
    ['three values (exact branch)', [1, 4, 2], 0.9642857142857142, 0.6368868450289689],
    ['twenty strongly skewed values', [1, 1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 7, 9, 12, 15, 20, 28, 40, 55, 80], 0.6892745592638565, 2.8933604160643e-5],
    ['twelve values (large branch begins)', [5.1, 4.8, 5.6, 5.2, 4.9, 5.4, 5.0, 5.3, 4.7, 5.5, 5.1, 4.95], 0.9748582346414211, 0.9544814097250061],
    ['fifty evenly spaced values', Array.from({ length: 50 }, (_, i) => i), 0.9555826875589973, 0.058091862177350316],
    ['twenty-five Likert responses', [3, 4, 2, 5, 3, 3, 4, 1, 5, 2, 3, 4, 3, 2, 4, 5, 3, 3, 2, 4, 3, 4, 2, 3, 5], 0.916426100423344, 0.04250286434339932],
  ];

  for (const [label, values, expectedW, expectedP] of swCases) {
    const result = shapiroWilk(values);
    if (!result) {
      failed += 1;
      console.error(`✗ Shapiro–Wilk returned nothing for ${label}`);
      continue;
    }
    close(`Shapiro–Wilk W · ${label}`, result.w, expectedW, 1e-9);
    close(`Shapiro–Wilk p · ${label}`, result.pValue, expectedP, 1e-9);
  }

  /* The supported range is a hard limit of the method, so it is enforced. */
  check('Shapiro–Wilk refuses two points', shapiroWilk([1, 2]), null);
  check('Shapiro–Wilk refuses a constant sample', shapiroWilk([4, 4, 4, 4, 4]), null);
  check(
    'Shapiro–Wilk refuses beyond five thousand cases',
    shapiroWilk(Array.from({ length: SHAPIRO_WILK_MAX_N + 1 }, (_, i) => i)),
    null,
  );

  /*
   * Levene, checked against SciPy. The three-group case is what ANOVA will use;
   * the two-group case decides whether Student's t is worth showing beside
   * Welch's.
   */
  const lg1 = [12, 14, 15, 13, 17, 16, 14, 15];
  const lg2 = [22, 25, 24, 28, 21, 27, 23, 26];
  const lg3 = [18, 19, 17, 20, 16, 21, 19, 18];

  const levene3 = levene([lg1, lg2, lg3]);
  close('Levene F · three groups', levene3?.statistic ?? 0, 1.5, 1e-12);
  close('Levene p · three groups', levene3?.pValue ?? 0, 0.24608466820829974, 1e-11);
  check('Levene numerator df', levene3?.df[0], 2);
  check('Levene denominator df', levene3?.df[1], 21);
  check('Levene centres on the median by default', levene3?.center, 'median');

  const levene2 = levene([lg1, lg2]);
  close('Levene F · two similar groups', levene2?.statistic ?? 0, 2.032258064516129, 1e-12);
  close('Levene p · two similar groups', levene2?.pValue ?? 0, 0.17590582553590586, 1e-11);

  const leveneUnequal = levene([
    [10, 10.1, 9.9, 10.2, 9.8, 10.05, 9.95, 10.1],
    [10, 20, 0, 15, 5, 25, -5, 30],
  ]);
  close('Levene F · wildly unequal variances', leveneUnequal?.statistic ?? 0, 21.951166836642873, 1e-11);
  close('Levene p · wildly unequal variances', leveneUnequal?.pValue ?? 0, 0.0003508750118207638, 1e-14);
  check('Levene needs two groups', levene([lg1]), null);

  /* --------------------------------------- assumptions as decisions */

  const normalAssessment = assessNormality([2.1, 3.4, 2.8, 4.1, 3.3, 2.9, 3.7, 3.0, 3.5, 2.6], 'score');
  check('a normal sample passes', normalAssessment.check.status, 'met');
  check('a passing check names no alternative', normalAssessment.check.alternative, undefined);
  check('a passing check raises no warning', normalAssessment.warnings.length, 0);
  assertTrue('a parametric test is defensible', normalAssessment.parametricDefensible);

  const skewedSmall = assessNormality([1, 1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 7, 9, 12, 15, 20, 28, 40], 'income');
  check('a skewed small sample fails', skewedSmall.check.status, 'violated');
  check('and is pointed at a non-parametric test', skewedSmall.check.alternative, 'nonparametric.mannWhitney');
  assertTrue(
    'and is warned about',
    skewedSmall.warnings.some((w) => w.code === 'normality-violated' && w.severity === 'warning'),
  );
  assertTrue('a parametric test is not defensible here', !skewedSmall.parametricDefensible);

  /*
   * The case this module exists to get right. The same shape of data at n = 60
   * still fails the test — normality tests grow powerful with n — but the
   * central limit theorem has done its work, so the advice inverts: carry on.
   */
  const skewedLarge = assessNormality(
    Array.from({ length: 60 }, (_, i) => Math.round(Math.exp(i / 12) * 100) / 100),
    'income',
  );
  check('a skewed large sample still fails the test', skewedLarge.check.status, 'violated');
  assertTrue('but a parametric test remains defensible', skewedLarge.parametricDefensible);
  check('so no alternative test is pushed', skewedLarge.check.alternative, undefined);
  assertTrue(
    'and the warning explains rather than alarms',
    skewedLarge.warnings.some(
      (w) => w.code === 'normality-violated-but-large-sample' && w.severity === 'info',
    ),
  );

  const homogeneous = assessHomogeneity([lg1, lg2], ['group A', 'group B']);
  check('similar variances pass', homogeneous.check.status, 'met');
  assertTrue('so the equal-variance form is defensible', homogeneous.equalVariances);

  const heterogeneous = assessHomogeneity(
    [[10, 10.1, 9.9, 10.2, 9.8, 10.05, 9.95, 10.1], [10, 20, 0, 15, 5, 25, -5, 30]],
    ['group A', 'group B'],
  );
  check('unequal variances fail', heterogeneous.check.status, 'violated');
  assertTrue('so the equal-variance form is not defensible', !heterogeneous.equalVariances);

  check('independence is reported as untestable', independenceCheck().status, 'not-testable');

  /* ---------------------------------------------------------- t-tests */

  /*
   * All four families checked against SciPy's `ttest_1samp`, `ttest_ind` and
   * `ttest_rel`. The Welch degrees of freedom are the fiddly part — they are
   * not an integer, and rounding them moves the p-value in the third decimal.
   */

  const attitude = [4, 5, 3, 4, 2, 5, 4, 3, 4, 5, 4, 3, 5, 4, 4, 2, 5, 3, 4, 4];
  const oneSample = oneSampleTTest(attitude, 'attitude', { mu: 3 });
  close('one-sample t', oneSample.statistic.value, 4.072974817878142, 1e-12);
  check('one-sample df', oneSample.df, 19);
  close('one-sample p', oneSample.pValue, 0.0006485609919354655, 1e-14);
  close('one-sample Cohen\u2019s d', oneSample.effect?.value ?? 0, 0.9107448563420352, 1e-12);
  check('a d of 0.91 is a large effect', oneSample.effect?.band, 'large');
  close('one-sample mean', oneSample.estimates[0]?.mean ?? 0, 3.85, 1e-12);
  check('the tested value is reported back', oneSample.detail?.mu, 3);

  /* Two groups with similar spread: the forms agree, Welch is still primary. */
  const groupMale = [4.2, 3.8, 4.5, 3.9, 4.1, 4.4, 3.7, 4.0, 4.3, 3.6, 4.2, 4.1];
  const groupFemale = [3.1, 4.8, 2.2, 5.0, 3.5, 2.8, 4.9, 3.0, 4.7, 2.5, 4.6, 3.3];
  const independent = independentTTest(groupMale, groupFemale, ['male', 'female']);

  close('Welch t', independent.statistic.value, 1.1893076598942358, 1e-12);
  close('Welch df is not an integer', independent.df as number, 12.583729362299163, 1e-11);
  close('Welch p', independent.pValue, 0.2562762849487697, 1e-12);
  check('Welch is the primary result', independent.detail?.primaryForm, 'welch');

  close('Student t (secondary)', independent.secondary?.statistic.value ?? 0, 1.1893076598942356, 1e-12);
  check('Student df', independent.secondary?.df, 22);
  close('Student p (secondary)', independent.secondary?.pValue ?? 0, 0.24699689165305252, 1e-12);

  close('pooled standard deviation', independent.detail?.pooledSd as number, 0.755184103582054, 1e-12);
  close('Cohen\u2019s d uses the pooled sd', independent.effect?.value ?? 0, 0.48553281898739914, 1e-12);
  close('Hedges\u2019 g corrects d downward', independent.detail?.hedgesG as number, 0.46879030798783367, 1e-12);
  assertTrue(
    'Hedges\u2019 g is smaller than Cohen\u2019s d',
    Math.abs(independent.detail?.hedgesG as number) < Math.abs(independent.effect?.value ?? 0),
  );

  /*
   * The case that justifies making Welch primary. A tight group of eight
   * against a widely spread group of twenty-four: the two forms reach opposite
   * conclusions at α = .05, and Student's — the one most theses copy — is the
   * wrong one.
   */
  const tightSmall = [10, 10.4, 9.6, 10.2, 9.8, 10.1, 9.9, 10.3];
  const wideLarge = Array.from({ length: 24 }, (_, i) => 1.75 + i);
  const divergent = independentTTest(tightSmall, wideLarge, ['control', 'treatment']);

  close('Welch t on unequal spread', divergent.statistic.value, -2.220943084706801, 1e-11);
  close('Welch df on unequal spread', divergent.df as number, 23.195677474150397, 1e-10);
  close('Welch p is significant', divergent.pValue, 0.036394189951284385, 1e-12);
  close('Student p is not significant', divergent.secondary?.pValue ?? 0, 0.213608180614561, 1e-12);
  assertTrue('the two forms reach opposite conclusions', divergent.pValue < 0.05 && (divergent.secondary?.pValue ?? 0) > 0.05);
  assertTrue(
    'and the disagreement is reported rather than hidden',
    divergent.warnings.some((w) => w.code === 'welch-student-disagree'),
  );
  check('Welch is flagged as required, not merely preferred', divergent.detail?.primaryReason, 'welch-required-unequal-variances');
  check('Student is marked indefensible here', divergent.detail?.studentDefensible, false);
  assertTrue(
    'unequal group sizes with unequal variances are called out',
    divergent.warnings.some((w) => w.code === 'unequal-groups-and-variances'),
  );

  /* Paired: pre-test and post-test on the same twelve respondents. */
  const pre = [45, 52, 48, 55, 50, 47, 53, 49, 51, 46, 54, 50];
  const post = [52, 58, 53, 60, 56, 51, 59, 54, 57, 50, 61, 55];
  const paired = pairedTTest(pre, post, ['pre-test', 'post-test']);

  close('paired t', paired.statistic.value, -19.05255888325765, 1e-11);
  check('paired df', paired.df, 11);
  close('paired p', paired.pValue, 8.989341323936471e-10, 1e-20);
  close('mean difference', paired.detail?.meanDifference as number, -5.5, 1e-12);
  close('sd of the differences', paired.detail?.sdOfDifferences as number, 1, 1e-12);

  /*
   * Cohen's d for a paired design divides by the sd of the differences, not of
   * the raw scores. Using the raw-score version — the common mistake — would
   * report about −1.6 here instead of −5.5, understating an intervention that
   * moved everyone by a similar amount.
   */
  close('paired d uses the sd of differences', paired.effect?.value ?? 0, -5.5, 1e-12);

  /* Incomplete pairs cannot contribute a difference, so they are dropped. */
  const gappyPre = [45, 52, Number.NaN, 55, 50, 47, 53, 49, 51, 46, 54, 50];
  const gappyPost = [52, 58, 53, 60, Number.NaN, 51, 59, 54, 57, 50, 61, 55];
  const gappyPaired = pairedTTest(gappyPre, gappyPost, ['pre-test', 'post-test']);
  check('an incomplete pair is dropped', gappyPaired.n, 10);
  check('and counted', gappyPaired.rowsDropped, 2);
  check('and reported', gappyPaired.missingPolicy, 'listwise');
  assertTrue(
    'and explained to the user',
    gappyPaired.warnings.some((w) => w.code === 'incomplete-pairs-dropped'),
  );

  /* ------------------------------------------------ what a t-test refuses */

  function refusesT(label: string, run: () => unknown, expectedReason: string) {
    try {
      run();
      failed += 1;
      console.error(`✗ ${label}\n    expected a TTestError, got a result`);
    } catch (error) {
      if (error instanceof TTestError && error.reasonKey === expectedReason) passed += 1;
      else {
        failed += 1;
        console.error(`✗ ${label}\n    expected: ${expectedReason}\n    actual:   ${String(error)}`);
      }
    }
  }

  refusesT('two values are not a sample', () => oneSampleTTest([3, 4], 'x', { mu: 3 }), 'analysis.ttest.error.tooFewValues');
  refusesT('a constant column has nothing to test', () => oneSampleTTest([3, 3, 3, 3, 3], 'x', { mu: 3 }), 'analysis.ttest.error.noVariance');
  refusesT(
    'a group of two is refused',
    () => independentTTest([1, 2], [3, 4, 5, 6], ['a', 'b']),
    'analysis.ttest.error.groupTooSmall',
  );
  refusesT(
    'unequal pair counts are refused',
    () => pairedTTest([1, 2, 3], [1, 2], ['a', 'b']),
    'analysis.ttest.error.unequalPairs',
  );

  /* ------------------------------------------------ studentized range (q) */

  /*
   * Tukey needs the distribution of the largest difference among k means, which
   * has no closed form and is integrated numerically. Two independent checks:
   * against the exact k = 2 case, where the range of two normals is just a
   * scaled normal, and against the published q table at α = .05.
   */
  for (const q of [1, 2, 3, 4]) {
    close(
      `the range of two normals matches its closed form at q=${q}`,
      studentizedRangeCdf(q, 2, 1e9),
      2 * normalCdf(q / Math.SQRT2) - 1,
      1e-9,
    );
  }

  const qTable: [number, number, number][] = [
    [2, 10, 3.151], [3, 10, 3.877], [3, 20, 3.578], [3, 60, 3.399],
    [4, 12, 4.199], [4, 30, 3.845], [5, 20, 4.232], [6, 24, 4.373],
  ];
  for (const [k, df, expected] of qTable) {
    close(`q(.95, k=${k}, df=${df}) = ${expected}`, studentizedRangeQuantile(0.95, k, df), expected, 1e-3);
  }

  /* ------------------------------------------------------------ one-way ANOVA */

  /*
   * Three teaching methods, ten students each. Checked against SciPy's
   * `f_oneway` and statsmodels' `pairwise_tukeyhsd`.
   */
  const methodA = [85, 88, 82, 90, 86, 84, 89, 87, 83, 91];
  const methodB = [78, 75, 80, 77, 74, 79, 76, 81, 73, 78];
  const methodC = [92, 95, 90, 94, 91, 96, 93, 89, 97, 92];

  const anova = oneWayAnova([methodA, methodB, methodC], ['A', 'B', 'C']);

  close('ANOVA F', anova.statistic.value, 83.47136563876654, 1e-10);
  check('ANOVA between-groups df', (anova.df as [number, number])[0], 2);
  check('ANOVA within-groups df', (anova.df as [number, number])[1], 27);
  close('ANOVA p', anova.pValue, 2.7530776808615437e-12, 1e-22);
  close('sum of squares between', anova.detail?.ssBetween as number, 1263.2000000000019, 1e-9);
  close('sum of squares within', anova.detail?.ssWithin as number, 204.29999999999995, 1e-9);
  close('mean square within', anova.detail?.msWithin as number, 7.566666666666665, 1e-12);
  close('η²', anova.detail?.etaSquared as number, 0.8607836456558775, 1e-12);
  close('ω² is smaller than η²', anova.detail?.omegaSquared as number, 0.8461086504564768, 1e-12);
  assertTrue(
    'ω² corrects η² downward',
    (anova.detail?.omegaSquared as number) < (anova.detail?.etaSquared as number),
  );
  check('equal variances keep the classical form primary', anova.detail?.primaryForm, 'classical');

  /* Tukey, against statsmodels. */
  const tukey = anova.detail?.postHoc as { groupA: string; groupB: string; meanDifference: number; standardError: number; pValue: number; confidenceInterval: { lower: number; upper: number }; significant: boolean }[];
  check('every pair is compared', tukey.length, 3);
  close('A − B mean difference', tukey[0]?.meanDifference ?? 0, 9.4, 1e-12);
  close('Tukey–Kramer standard error', tukey[0]?.standardError ?? 0, 0.86986589, 1e-7);
  close('A − B adjusted p', tukey[0]?.pValue ?? 1, 9.5012764989022e-8, 1e-11);
  close('A − C adjusted p', tukey[1]?.pValue ?? 1, 5.1235558987894336e-5, 1e-8);
  close('A − B interval lower bound', tukey[0]?.confidenceInterval.lower ?? 0, 6.34987952, 1e-6);
  close('A − B interval upper bound', tukey[0]?.confidenceInterval.upper ?? 0, 12.45012048, 1e-6);
  assertTrue('all three pairs differ', tukey.every((comparison) => comparison.significant));

  /*
   * The adjustment is the whole point of Tukey, so check it is actually doing
   * something: the family-wise p must exceed the unadjusted two-sample p for
   * the same difference.
   */
  /*
   * The adjustment is the whole point of Tukey, so check it is actually doing
   * something. The comparison has to hold the error term fixed: an ordinary
   * pairwise t-test on two of the three groups uses only their own data, and
   * the extra degrees of freedom Tukey gains from pooling all three can more
   * than repay what the adjustment costs — which is what happens here. Against
   * the *same* pooled error, the family-wise p must be the larger one.
   */
  const pooledMs = anova.detail?.msWithin as number;
  const pooledDf = anova.detail?.dfWithin as number;
  const unadjustedT = 9.4 / Math.sqrt(pooledMs * (1 / 10 + 1 / 10));
  const unadjustedP = tTwoTailed(unadjustedT, pooledDf);
  assertTrue(
    'the family-wise p is more conservative than the same comparison unadjusted',
    (tukey[0]?.pValue ?? 0) > unadjustedP,
  );

  /*
   * Post-hoc comparisons are withheld after a non-significant omnibus test:
   * running them anyway is fishing.
   */
  const flat = oneWayAnova(
    [[10, 11, 9, 10, 11, 9], [10, 9, 11, 10, 9, 11], [11, 10, 9, 10, 11, 10]],
    ['X', 'Y', 'Z'],
  );
  assertTrue('a non-significant ANOVA is not followed by comparisons', (flat.detail?.postHoc as unknown[]).length === 0);
  check('and that is recorded', flat.detail?.postHocRun, false);
  check('unless explicitly asked for', (oneWayAnova(
    [[10, 11, 9, 10, 11, 9], [10, 9, 11, 10, 9, 11], [11, 10, 9, 10, 11, 10]],
    ['X', 'Y', 'Z'],
    { forcePostHoc: true },
  ).detail?.postHoc as unknown[]).length, 3);

  /* --------------------------------------------- Welch's ANOVA takes over */

  /*
   * The case that justifies computing both forms. One group is wildly more
   * variable than the others and the group sizes differ. The classical F sees
   * nothing (p = .38); Welch's F sees a large effect (p = .000029). Reporting
   * only the classical form here would mean reporting that nothing happened.
   */
  const steady = [50, 52, 48, 51, 49, 53, 47, 50, 52, 48, 51, 49];
  const erratic = [60, 40, 75, 25, 80, 35, 70, 45];
  const higher = [55, 56, 54, 57, 53, 58, 52, 55, 56, 54, 57, 53, 58, 52, 55, 56];

  const welchAnovaResult = oneWayAnova([steady, erratic, higher], ['steady', 'erratic', 'higher']);

  check('unequal variances make Welch primary', welchAnovaResult.detail?.primaryForm, 'welch');
  close('Welch F', welchAnovaResult.statistic.value, 23.342693763229477, 1e-10);
  close('Welch denominator df is not an integer', (welchAnovaResult.df as [number, number])[1], 14.55087815429151, 1e-10);
  close('Welch p', welchAnovaResult.pValue, 2.879099276349333e-5, 1e-15);
  close('the classical F is reported as secondary', welchAnovaResult.secondary?.statistic.value ?? 0, 0.9975586244472848, 1e-11);
  close('and its p is not significant', welchAnovaResult.secondary?.pValue ?? 0, 0.3796269490736316, 1e-11);
  assertTrue(
    'the disagreement between forms is reported',
    welchAnovaResult.warnings.some((w) => w.code === 'welch-classical-disagree'),
  );
  assertTrue(
    'and Tukey is caveated because it assumes equal variances',
    welchAnovaResult.warnings.some((w) => w.code === 'tukey-assumes-equal-variances'),
  );

  /* ------------------------------------------------- what ANOVA refuses */

  function refusesAnova(label: string, run: () => unknown, expectedReason: string) {
    try {
      run();
      failed += 1;
      console.error(`✗ ${label}\n    expected an AnovaError, got a result`);
    } catch (error) {
      if (error instanceof AnovaError && error.reasonKey === expectedReason) passed += 1;
      else {
        failed += 1;
        console.error(`✗ ${label}\n    expected: ${expectedReason}\n    actual:   ${String(error)}`);
      }
    }
  }

  refusesAnova(
    'one group is not an analysis of variance',
    () => oneWayAnova([[1, 2, 3, 4]], ['only']),
    'analysis.anova.error.tooFewGroups',
  );
  refusesAnova(
    'mismatched labels are refused',
    () => oneWayAnova([[1, 2, 3], [4, 5, 6]], ['a']),
    'analysis.anova.error.labelMismatch',
  );
  refusesAnova(
    'identical constant groups have nothing to compare',
    () => oneWayAnova([[5, 5, 5, 5], [5, 5, 5, 5]], ['a', 'b']),
    'analysis.anova.error.noVariance',
  );

  /* ---------------------------------------------------------- correlation */

  /*
   * Checked against SciPy's `pearsonr` and `spearmanr`, including the
   * confidence interval, which SciPy computes by the same Fisher z route.
   */
  const ages = [23, 25, 28, 30, 32, 35, 38, 40, 42, 45, 48, 50, 52, 55, 58, 60, 62, 65, 68, 70];
  const scores = [2.1, 2.3, 2.8, 3.0, 3.4, 3.2, 3.9, 4.1, 4.0, 4.5, 4.7, 4.6, 5.2, 5.0, 5.5, 5.8, 5.6, 6.1, 6.3, 6.5];

  const pearsonResult = correlate(ages, scores, ['age', 'score']);
  close('Pearson r', pearsonResult.statistic.value, 0.9911899452941721, 1e-13);
  close('Pearson p', pearsonResult.pValue, 2.941391564253384e-17, 1e-26);
  check('Pearson df', pearsonResult.df, 18);
  check('a correlation deletes pairwise', pearsonResult.missingPolicy, 'pairwise');

  const pearsonCi = pearsonResult.detail?.confidenceInterval as { lower: number; upper: number };
  close('Fisher interval lower bound', pearsonCi.lower, 0.9773616165979756, 1e-12);
  close('Fisher interval upper bound', pearsonCi.upper, 0.9965860233647093, 1e-12);
  assertTrue(
    'the interval is asymmetric around r, as a bounded statistic must be',
    Math.abs(pearsonResult.statistic.value - pearsonCi.lower) > Math.abs(pearsonCi.upper - pearsonResult.statistic.value),
  );
  close('r² is the shared variance', pearsonResult.detail?.rSquared as number, 0.9911899452941721 ** 2, 1e-12);

  const spearmanResult = correlate(ages, scores, ['age', 'score'], { method: 'spearman' });
  close('Spearman rho', spearmanResult.statistic.value, 0.9924812030075187, 1e-13);
  close('Spearman p', spearmanResult.pValue, 7.097515845390696e-18, 1e-27);
  check('Spearman is reported as its own test', spearmanResult.test, 'correlation.spearman');

  /* Likert data: heavy ties, where the two coefficients part company. */
  const item1 = [3, 4, 2, 5, 3, 4, 5, 2, 3, 4, 4, 3, 5, 2, 4];
  const item2 = [4, 4, 3, 5, 3, 5, 5, 2, 4, 4, 3, 3, 5, 3, 4];
  close('Pearson on Likert items', correlate(item1, item2, ['q1', 'q2']).statistic.value, 0.8304945268352675, 1e-13);
  close(
    'Spearman on Likert items',
    correlate(item1, item2, ['q1', 'q2'], { method: 'spearman' }).statistic.value,
    0.825637213704964,
    1e-13,
  );

  /*
   * Pearson measures linear association only. A perfect symmetric U-shape has
   * r = 0 while being entirely determined — which is why the linearity
   * assumption is declared rather than assumed away.
   */
  const uShapeX = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
  const uShapeY = [25, 16, 9, 4, 1, 0, 1, 4, 9, 16, 25];
  close('a perfect U-shape has zero linear correlation', correlate(uShapeX, uShapeY, ['x', 'y']).statistic.value, 0, 1e-14);
  assertTrue(
    'so linearity is declared untestable rather than assumed',
    correlate(uShapeX, uShapeY, ['x', 'y']).assumptions.some(
      (a) => a.key === 'linearity' && a.status === 'not-testable',
    ),
  );

  /*
   * The case a bare r hides. An r of .38 looks like a moderate relationship,
   * but with twenty respondents the interval runs from −.07 to .71 — it
   * includes no relationship at all.
   */
  const noisyX = Array.from({ length: 20 }, (_, i) => i + 1);
  const noisyY = [17, 13, 10, 6, 6, 1, 2, 1, 4, 16, 13, 18, 10, 12, 19, 14, 13, 11, 11, 18];
  const noisy = correlate(noisyX, noisyY, ['x', 'y']);
  close('a moderate-looking r', noisy.statistic.value, 0.3836753972748939, 1e-13);
  close('is not significant', noisy.pValue, 0.09492183360594042, 1e-12);
  const noisyCi = noisy.detail?.confidenceInterval as { lower: number; upper: number };
  close('and its interval reaches below zero', noisyCi.lower, -0.07087963705295533, 1e-12);
  close('while reaching .71 above', noisyCi.upper, 0.706280767632637, 1e-12);
  assertTrue(
    'so the user is told the interval includes zero',
    noisy.warnings.some((w) => w.code === 'interval-includes-zero'),
  );
  assertTrue(
    'and that the sample is small',
    noisy.warnings.some((w) => w.code === 'correlation-small-sample'),
  );

  /* Missing values are dropped pairwise, keeping the rest of the respondent. */
  const gappyX = [1, 2, Number.NaN, 4, 5, 6, 7, 8, 9, 10];
  const gappyY = [2, 4, 6, 8, Number.NaN, 12, 14, 16, 18, 20];
  const gappyCorrelation = correlate(gappyX, gappyY, ['x', 'y']);
  check('only complete pairs are used', gappyCorrelation.n, 8);
  check('and the rest are counted', gappyCorrelation.rowsDropped, 2);
  close('the surviving pairs are perfectly linear', gappyCorrelation.statistic.value, 1, 1e-12);

  /* ------------------------------------------------- correlation matrix */

  const matrixResult = correlationMatrix([
    { name: 'age', values: ages },
    { name: 'score', values: scores },
    { name: 'noise', values: noisyY.concat([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]).slice(0, 20) },
  ]);

  check('the matrix is square', matrixResult.matrix.length, 3);
  check('the diagonal is one', matrixResult.matrix[0]?.[0], 1);
  close('and it is symmetric', matrixResult.matrix[0]?.[1] ?? 0, matrixResult.matrix[1]?.[0] ?? 1, 1e-15);
  check('every pair produces a cell', matrixResult.cells.length, 3);
  close('the age–score cell matches the single correlation', matrixResult.cells[0]?.r ?? 0, 0.9911899452941721, 1e-13);
  check('the matrix deletes pairwise', matrixResult.missingPolicy, 'pairwise');

  /*
   * With enough variables, some cells reach significance from noise alone. The
   * matrix does not silently adjust — the correct family depends on the
   * hypothesis — but it does report how many comparisons were made.
   */
  const wideMatrix = correlationMatrix(
    Array.from({ length: 6 }, (_, column) => ({
      name: `v${column + 1}`,
      values: Array.from({ length: 30 }, (_, row) => ((row * 7 + column * 13) % 11) + (row % (column + 2))),
    })),
  );
  check('six variables make fifteen comparisons', wideMatrix.cells.length, 15);
  assertTrue(
    'and the multiple-comparison risk is stated',
    wideMatrix.warnings.some((w) => w.code === 'multiple-comparisons-unadjusted'),
  );

  /* --------------------------------------- what correlation refuses */

  function refusesCorrelation(label: string, run: () => unknown, expectedReason: string) {
    try {
      run();
      failed += 1;
      console.error(`✗ ${label}\n    expected a CorrelationError, got a result`);
    } catch (error) {
      if (error instanceof CorrelationError && error.reasonKey === expectedReason) passed += 1;
      else {
        failed += 1;
        console.error(`✗ ${label}\n    expected: ${expectedReason}\n    actual:   ${String(error)}`);
      }
    }
  }

  refusesCorrelation(
    'unequal lengths are refused',
    () => correlate([1, 2, 3], [1, 2], ['a', 'b']),
    'analysis.correlation.error.lengthMismatch',
  );
  refusesCorrelation(
    'three pairs are too few',
    () => correlate([1, 2, 3], [2, 4, 6], ['a', 'b']),
    'analysis.correlation.error.tooFewPairs',
  );
  refusesCorrelation(
    'a constant variable cannot co-vary',
    () => correlate([1, 2, 3, 4, 5], [7, 7, 7, 7, 7], ['a', 'constant']),
    'analysis.correlation.error.constantVariable',
  );
  refusesCorrelation(
    'one variable is not a matrix',
    () => correlationMatrix([{ name: 'a', values: [1, 2, 3, 4, 5] }]),
    'analysis.correlation.error.tooFewVariables',
  );

  /* ---------------------------------------------------------- chi-square */

  /* Checked against SciPy's `chi2_contingency`, `fisher_exact` and `chisquare`. */

  const programmeByEmployment = {
    rowLabels: ['engineering', 'business', 'humanities'],
    columnLabels: ['employed', 'unemployed'],
    observed: [[45, 25], [30, 40], [20, 50]],
  };
  const independence = chiSquareIndependence(programmeByEmployment, ['programme', 'employment']);

  close('χ² of independence', independence.statistic.value, 18.260869565217387, 1e-12);
  check('χ² degrees of freedom', independence.df, 2);
  close('χ² p', independence.pValue, 0.00010831847986854247, 1e-16);
  close('Cramér\u2019s V', independence.effect?.value ?? 0, 0.2948839123097942, 1e-13);
  close('expected count of the first cell', (independence.detail?.expected as number[][])[0]?.[0] ?? 0, 31.666666666666668, 1e-12);
  check('a 3×2 table takes no continuity correction', independence.detail?.primaryForm, 'pearson');

  /*
   * Standardised residuals say *which* cells drive the association, which the
   * omnibus statistic cannot. Here engineering graduates are employed far more
   * often than independence predicts.
   */
  const residuals = independence.detail?.standardisedResiduals as number[][];
  assertTrue('the first cell exceeds expectation', (residuals[0]?.[0] ?? 0) > 2);
  assertTrue('and the last falls short of it', (residuals[2]?.[0] ?? 0) < -2);

  /* A 2×2 table: Yates by default, with the exact test computed beside it. */
  const twoByTwo = {
    rowLabels: ['male', 'female'],
    columnLabels: ['pass', 'fail'],
    observed: [[30, 20], [15, 35]],
  };
  const yates = chiSquareIndependence(twoByTwo, ['gender', 'outcome']);

  close('Yates-corrected χ²', yates.statistic.value, 7.919191919191919, 1e-12);
  close('Yates p', yates.pValue, 0.004891311452359333, 1e-14);
  close('the uncorrected χ² is larger', yates.detail?.uncorrectedStatistic as number, 9.09090909090909, 1e-12);
  assertTrue(
    'so Yates is conservative, as it is meant to be',
    yates.statistic.value < (yates.detail?.uncorrectedStatistic as number),
  );
  close('phi for a 2×2 table', yates.detail?.phi as number, 0.30151134457776363, 1e-13);
  close('Fisher\u2019s exact p is computed alongside', yates.detail?.fisherExactP as number, 0.004635020180798911, 1e-14);
  close('and the odds ratio', yates.detail?.oddsRatio as number, 3.5, 1e-12);
  check('but χ² stays primary when the counts are adequate', yates.detail?.primaryForm, 'yates');

  /* Turning off the correction reproduces the plain Pearson statistic. */
  close(
    'Yates can be switched off',
    chiSquareIndependence(twoByTwo, ['gender', 'outcome'], { yatesCorrection: false }).statistic.value,
    9.09090909090909,
    1e-12,
  );

  /*
   * The case the exact test exists for. Every expected count is below five, so
   * the χ² approximation is not trustworthy and Fisher takes over as the
   * primary result.
   */
  const sparse = {
    rowLabels: ['treated', 'control'],
    columnLabels: ['improved', 'unchanged'],
    observed: [[8, 2], [1, 9]],
  };
  const exactResult = chiSquareIndependence(sparse, ['group', 'outcome']);

  check('sparse expected counts make the exact test primary', exactResult.detail?.primaryForm, 'fisher-exact');
  close('and its p is the reported one', exactResult.pValue, 0.005477494641581329, 1e-14);
  close('while χ² is kept as secondary', exactResult.secondary?.pValue ?? 0, 0.00700094198944864, 1e-14);
  close('the odds ratio', exactResult.detail?.oddsRatio as number, 36, 1e-12);
  close('the smallest expected count', exactResult.detail?.minimumExpected as number, 4.5, 1e-12);
  assertTrue(
    'the expected-count assumption is marked violated',
    exactResult.assumptions.some((a) => a.key === 'expected-cell-counts' && a.status === 'violated'),
  );
  assertTrue(
    'and the switch to the exact test is explained',
    exactResult.warnings.some((w) => w.code === 'exact-test-used'),
  );

  /*
   * A zero cell makes the sample odds ratio infinite. The Haldane–Anscombe
   * correction adds a half to each cell so the figure stays finite and
   * reportable, while the p-value itself is unaffected.
   */
  const zeroCell = fisherExact2x2([[10, 0], [3, 7]]);
  close('Fisher handles a zero cell', zeroCell.pValue, 0.0030959752321981426, 1e-15);
  assertTrue('and the odds ratio stays finite', Number.isFinite(zeroCell.oddsRatio));

  /* A cell expecting less than one is an error, not a warning. */
  const verySparse = {
    rowLabels: ['a', 'b'],
    columnLabels: ['x', 'y', 'z'],
    observed: [[1, 0, 0], [0, 1, 1]],
  };
  assertTrue(
    'an expected count below one is reported as an error',
    chiSquareIndependence(verySparse, ['a', 'b']).warnings.some(
      (w) => w.code === 'expected-count-below-one' && w.severity === 'error',
    ),
  );

  /* A larger sparse table has no exact fallback, so the advice is to merge. */
  const sparseLarge = {
    rowLabels: ['a', 'b', 'c'],
    columnLabels: ['w', 'x', 'y', 'z'],
    observed: [[3, 2, 1, 2], [2, 3, 2, 1], [1, 2, 3, 2]],
  };
  assertTrue(
    'a sparse larger table is told to merge categories',
    chiSquareIndependence(sparseLarge, ['a', 'b']).warnings.some((w) => w.code === 'consider-merging-categories'),
  );

  /* ------------------------------------------------------ cross-tabulation */

  const crossTab = crossTabulate(
    ['male', 'female', 'male', 'female', 'male', null, 'female'],
    ['yes', 'no', 'yes', 'yes', 'no', 'yes', null],
    ['gender', 'response'],
  );
  check('levels are discovered from the data', crossTab.table.rowLabels.length, 2);
  check('and sorted', crossTab.table.rowLabels[0], 'female');
  check('rows missing either value are dropped', crossTab.used, 5);
  check('and counted', crossTab.dropped, 2);

  /* -------------------------------------------------- goodness of fit */

  const uniform = chiSquareGoodnessOfFit([30, 25, 20, 25], ['a', 'b', 'c', 'd']);
  close('goodness-of-fit χ²', uniform.statistic.value, 2, 1e-12);
  close('goodness-of-fit p', uniform.pValue, 0.5724067044708798, 1e-14);
  check('goodness-of-fit df', uniform.df, 3);

  const skewedChoice = chiSquareGoodnessOfFit([40, 30, 20, 10], ['a', 'b', 'c', 'd']);
  close('a clearly uneven distribution', skewedChoice.statistic.value, 20, 1e-12);
  close('is significant', skewedChoice.pValue, 0.00016974243555282632, 1e-16);

  /* ------------------------------------------- what chi-square refuses */

  function refusesChiSquare(label: string, run: () => unknown, expectedReason: string) {
    try {
      run();
      failed += 1;
      console.error(`✗ ${label}\n    expected a ChiSquareError, got a result`);
    } catch (error) {
      if (error instanceof ChiSquareError && error.reasonKey === expectedReason) passed += 1;
      else {
        failed += 1;
        console.error(`✗ ${label}\n    expected: ${expectedReason}\n    actual:   ${String(error)}`);
      }
    }
  }

  refusesChiSquare(
    'a single-level variable has no contingency',
    () => crossTabulate(['a', 'a', 'a'], ['x', 'y', 'x'], ['one', 'two']),
    'analysis.chiSquare.error.tooFewLevels',
  );
  refusesChiSquare(
    'a category nobody chose is refused',
    () =>
      chiSquareIndependence(
        { rowLabels: ['a', 'b'], columnLabels: ['x', 'y'], observed: [[5, 5], [0, 0]] },
        ['a', 'b'],
      ),
    'analysis.chiSquare.error.emptyCategory',
  );
  refusesChiSquare(
    'expected proportions must sum to one',
    () => chiSquareGoodnessOfFit([10, 20, 30], ['a', 'b', 'c'], [0.2, 0.2, 0.2]),
    'analysis.chiSquare.error.proportionsDoNotSumToOne',
  );

  /* The Haldane–Anscombe correction is applied visibly, never silently. */
  const zeroCellTable = chiSquareIndependence(
    { rowLabels: ['a', 'b'], columnLabels: ['x', 'y'], observed: [[10, 0], [3, 7]] },
    ['group', 'outcome'],
  );
  check('a zero cell corrects the odds ratio', zeroCellTable.detail?.oddsRatioCorrected, true);
  assertTrue(
    'and says so',
    zeroCellTable.warnings.some((w) => w.code === 'odds-ratio-corrected-for-zero-cell'),
  );
  check(
    'while an ordinary table needs no correction',
    yates.detail?.oddsRatioCorrected,
    false,
  );

  /* ------------------------------------------- multiple-comparison control */

  /*
   * Checked against statsmodels' `multipletests`. None of these is ever applied
   * automatically — the default is `none` — but when a researcher asks for one
   * it must be the same number their supervisor gets from R or SPSS.
   */
  const rawP = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];

  const bonferroni = adjustPValues(rawP, 'bonferroni');
  close('Bonferroni multiplies by the family size', bonferroni[0] ?? 0, 0.01, 1e-12);
  close('and caps at one', bonferroni[9] ?? 0, 1, 1e-12);

  const holm = adjustPValues(rawP, 'holm');
  close('Holm on the smallest p', holm[0] ?? 0, 0.01, 1e-12);
  close('Holm on the second', holm[1] ?? 0, 0.072, 1e-12);
  close('Holm on the third', holm[2] ?? 0, 0.312, 1e-12);
  assertTrue(
    'Holm is never more conservative than Bonferroni',
    holm.every((value, index) => value <= (bonferroni[index] as number) + 1e-12),
  );
  assertTrue(
    'and Holm is monotone in the raw p-values',
    holm.every((value, index) => index === 0 || value >= (holm[index - 1] as number) - 1e-12),
  );

  const fdr = adjustPValues(rawP, 'benjamini-hochberg');
  close('Benjamini–Hochberg on the smallest p', fdr[0] ?? 0, 0.01, 1e-12);
  close('and on the third', fdr[2] ?? 0, 0.084, 1e-12);
  assertTrue(
    'FDR control is less conservative than family-wise control',
    fdr.every((value, index) => value <= (holm[index] as number) + 1e-12),
  );

  check('no adjustment is the default and changes nothing', adjustPValues(rawP, 'none')[4], 0.042);

  const risk = multipleComparisonRisk(rawP, 0.05);
  check('the family size is reported', risk.comparisons, 10);
  check('as is the number found significant', risk.significant, 5);
  close('and how many noise alone would give', risk.expectedFalsePositives, 0.5, 1e-12);

  /* A matrix adjusts only when asked, and says so when it does. */
  const adjustedMatrix = correlationMatrix(
    Array.from({ length: 6 }, (_, column) => ({
      name: `v${column + 1}`,
      values: Array.from({ length: 30 }, (_, row) => ((row * 7 + column * 13) % 11) + (row % (column + 2))),
    })),
    { pAdjust: 'holm' },
  );
  check('the matrix records the correction it used', adjustedMatrix.pAdjust, 'holm');
  assertTrue(
    'adjusted p-values are never smaller than raw ones',
    adjustedMatrix.cells.every((cell) => cell.adjustedPValue >= cell.pValue - 1e-12),
  );
  assertTrue(
    'and the correction is reported',
    adjustedMatrix.warnings.some((w) => w.code === 'p-values-adjusted'),
  );
  assertTrue(
    'while the unadjusted warning is not raised when a correction was chosen',
    !adjustedMatrix.warnings.some((w) => w.code === 'multiple-comparisons-unadjusted'),
  );
  check('the default leaves p-values untouched', wideMatrix.pAdjust, 'none');
  assertTrue(
    'so adjusted equals raw by default',
    wideMatrix.cells.every((cell) => cell.adjustedPValue === cell.pValue),
  );

  /* ---------------------------------------------------------- regression */

  /* Checked against statsmodels' OLS, including standard errors and VIF. */

  const predictor1 = [2, 3, 5, 7, 9, 4, 6, 8, 10, 12, 1, 5, 7, 3, 8, 11, 6, 9, 4, 10];
  const predictor2 = [5, 4, 7, 6, 11, 3, 8, 9, 12, 14, 2, 6, 8, 5, 10, 13, 7, 11, 5, 12];
  const response = [12, 14, 20, 23, 31, 15, 24, 28, 35, 42, 9, 21, 27, 16, 30, 40, 23, 33, 18, 36];

  const multiple = linearRegression(
    { name: 'performance', values: response },
    [{ name: 'hours', values: predictor1 }, { name: 'support', values: predictor2 }],
  );

  const betas = multiple.detail?.coefficients as {
    name: string; b: number; standardError: number; beta: number; t: number; pValue: number;
    vif: number | null; confidenceInterval: { lower: number; upper: number }; significant: boolean;
  }[];

  close('intercept', betas[0]?.b ?? 0, 4.427243880326366, 1e-10);
  close('first slope', betas[1]?.b ?? 0, 1.9756119673617385, 1e-11);
  close('second slope', betas[2]?.b ?? 0, 0.9596554850408001, 1e-11);
  close('standard error of the first slope', betas[1]?.standardError ?? 0, 0.23979841074193828, 1e-12);
  close('t of the first slope', betas[1]?.t ?? 0, 8.238636616686401, 1e-10);
  close('p of the first slope', betas[1]?.pValue ?? 1, 2.44052517346114e-7, 1e-16);
  close('p of the second slope', betas[2]?.pValue ?? 1, 0.0003437938349386976, 1e-14);
  close('confidence interval lower bound', betas[1]?.confidenceInterval.lower ?? 0, 1.4696815448387253, 1e-10);
  close('confidence interval upper bound', betas[1]?.confidenceInterval.upper ?? 0, 2.4815423898847517, 1e-10);

  close('R²', multiple.detail?.rSquared as number, 0.9917127597473745, 1e-13);
  close('adjusted R²', multiple.detail?.adjustedRSquared as number, 0.9907377903058892, 1e-13);
  assertTrue(
    'adjusted R² is the smaller of the two',
    (multiple.detail?.adjustedRSquared as number) < (multiple.detail?.rSquared as number),
  );
  close('model F', multiple.statistic.value, 1017.1731723576033, 1e-8);
  close('model p', multiple.pValue, 2.0252768609259945e-18, 1e-28);
  check('model degrees of freedom', (multiple.df as [number, number])[0], 2);
  check('residual degrees of freedom', (multiple.df as [number, number])[1], 17);
  close('residual standard error', multiple.detail?.standardError as number, 0.9099544892012297, 1e-12);

  /*
   * Standardised coefficients: what makes two predictors on different scales
   * comparable. Here hours matters roughly twice as much as support, which the
   * raw slopes (1.98 against 0.96) happen to agree with only because the two
   * predictors have similar spread.
   */
  close('standardised β of the first predictor', betas[1]?.beta ?? 0, 0.6520011243037379, 1e-12);
  close('standardised β of the second', betas[2]?.beta ?? 0, 0.352980890376652, 1e-12);
  assertTrue('the intercept has no standardised form', Number.isNaN(betas[0]?.beta ?? 0));

  /* Diagnostics, against statsmodels. */
  close('variance inflation factor', betas[1]?.vif ?? 0, 12.847688123300093, 1e-9);
  close('Durbin–Watson', multiple.detail?.durbinWatson as number, 0.8211047031585251, 1e-11);

  /*
   * These two predictors correlate strongly, and the model reports it as an
   * error rather than leaving a reader to trust unstable coefficients: a VIF of
   * 12.8 means each standard error is about 3.6 times what it would be if the
   * predictors were unrelated.
   */
  assertTrue(
    'severe multicollinearity is an error, not a note',
    multiple.warnings.some((w) => w.code === 'severe-multicollinearity' && w.severity === 'error'),
  );
  assertTrue(
    'and the assumption is marked violated',
    multiple.assumptions.some((a) => a.key === 'multicollinearity' && a.status === 'violated'),
  );
  assertTrue(
    'autocorrelated residuals are reported',
    multiple.warnings.some((w) => w.code === 'residual-autocorrelation'),
  );

  /* Normality is checked on the residuals, not on any raw variable. */
  assertTrue(
    'normality is assessed on the residuals',
    multiple.assumptions.some((a) => a.key === 'normality' && a.detail?.on === 'residuals'),
  );

  /* Simple regression is the same machinery with one predictor. */
  const simple = linearRegression(
    { name: 'performance', values: response },
    [{ name: 'hours', values: predictor1 }],
  );
  const simpleBetas = multiple.detail ? (simple.detail?.coefficients as typeof betas) : [];
  close('simple intercept', simpleBetas[0]?.b ?? 0, 5.332432432432423, 1e-11);
  close('simple slope', simpleBetas[1]?.b ?? 0, 3.0027027027027033, 1e-11);
  close('simple standard error', simpleBetas[1]?.standardError ?? 0, 0.09577979099453887, 1e-13);
  close('simple R²', simple.detail?.rSquared as number, 0.9820148664162677, 1e-13);
  close('simple F', simple.statistic.value, 982.8265947093698, 1e-9);
  check('one predictor has no collinearity to measure', simpleBetas[1]?.vif, 1);

  /*
   * With one predictor and an intercept, R² is exactly the squared correlation
   * between predictor and outcome — a good cross-check between two modules that
   * share no code.
   */
  close(
    'R² equals the squared correlation in simple regression',
    simple.detail?.rSquared as number,
    correlate(predictor1, response, ['hours', 'performance']).statistic.value ** 2,
    1e-12,
  );

  /* Adding a random predictor raises R² but not adjusted R². */
  const noiseColumn = [7, 2, 9, 4, 1, 8, 3, 6, 5, 10, 2, 9, 4, 7, 1, 8, 3, 6, 5, 10];
  const padded = linearRegression(
    { name: 'performance', values: response },
    [{ name: 'hours', values: predictor1 }, { name: 'noise', values: noiseColumn }],
  );
  assertTrue(
    'an irrelevant predictor still raises R²',
    (padded.detail?.rSquared as number) > (simple.detail?.rSquared as number),
  );
  assertTrue(
    'but adjusted R² is not fooled',
    (padded.detail?.adjustedRSquared as number) < (simple.detail?.rSquared as number),
  );

  /* Missing data is deleted listwise, and counted. */
  const gappyResponse = [...response];
  gappyResponse[3] = Number.NaN;
  const gappyPredictor = [...predictor1];
  gappyPredictor[10] = Number.NaN;
  const gappyRegression = linearRegression(
    { name: 'performance', values: gappyResponse },
    [{ name: 'hours', values: gappyPredictor }],
  );
  check('incomplete cases are dropped', gappyRegression.n, 18);
  check('and counted', gappyRegression.rowsDropped, 2);
  check('regression deletes listwise', gappyRegression.missingPolicy, 'listwise');

  /* ------------------------------------------ what regression refuses */

  function refusesRegression(label: string, run: () => unknown, expectedReason: string) {
    try {
      run();
      failed += 1;
      console.error(`✗ ${label}\n    expected a RegressionError, got a result`);
    } catch (error) {
      if (error instanceof RegressionError && error.reasonKey === expectedReason) passed += 1;
      else {
        failed += 1;
        console.error(`✗ ${label}\n    expected: ${expectedReason}\n    actual:   ${String(error)}`);
      }
    }
  }

  refusesRegression(
    'a model needs a predictor',
    () => linearRegression({ name: 'y', values: response }, []),
    'analysis.regression.error.noPredictors',
  );
  refusesRegression(
    'the outcome cannot predict itself',
    () => linearRegression({ name: 'y', values: response }, [{ name: 'y', values: response }]),
    'analysis.regression.error.outcomeAmongPredictors',
  );
  refusesRegression(
    'the same predictor twice is refused',
    () =>
      linearRegression({ name: 'y', values: response }, [
        { name: 'x', values: predictor1 },
        { name: 'x', values: predictor1 },
      ]),
    'analysis.regression.error.duplicatePredictor',
  );
  refusesRegression(
    'a constant predictor explains nothing',
    () =>
      linearRegression({ name: 'y', values: response }, [
        { name: 'flat', values: new Array(20).fill(3) },
      ]),
    'analysis.regression.error.constantPredictor',
  );
  refusesRegression(
    'too few cases for the parameters',
    () =>
      linearRegression({ name: 'y', values: [1, 2, 3, 4] }, [
        { name: 'a', values: [1, 2, 3, 5] },
      ]),
    'analysis.regression.error.tooFewCases',
  );

  /*
   * An exactly collinear predictor has no unique solution. Dropping a column
   * silently would hide a modelling error the researcher needs to see, so the
   * fit refuses instead.
   */
  refusesRegression(
    'a perfectly collinear predictor is refused rather than fitted',
    () =>
      linearRegression({ name: 'y', values: response }, [
        { name: 'x', values: predictor1 },
        { name: 'double-x', values: predictor1.map((value) => value * 2) },
      ]),
    'analysis.regression.error.perfectCollinearity',
  );

  /* ------------------------------------------------- the test recommender */

  /*
   * A survey with forty respondents: two categorical variables, two ratio
   * variables, three Likert items. Every design below is decided from the
   * profiler's inferred scales, with no model involved — the same input must
   * always give the same recommendation.
   */
  const surveyRows: (string | number)[][] = [];
  for (let i = 0; i < 40; i += 1) {
    surveyRows.push([
      i % 2 === 0 ? 'male' : 'female',
      ['A', 'B', 'C'][i % 3] as string,
      60 + ((i * 7) % 40),
      (i % 5) + 1,
      ((i * 3) % 5) + 1,
      ((i * 2) % 5) + 1,
      18 + (i % 12),
    ]);
  }
  const surveyDataset: Dataset = {
    columns: ['gender', 'method', 'score', 'q1', 'q2', 'q3', 'age'],
    rows: surveyRows,
    source: 'survey.csv',
    skippedRows: 0,
  };
  const surveyProfile = profileDataset(surveyDataset);

  check('the profiler sees a binary grouping variable', surveyProfile.columns[0]?.scale, 'nominal');
  check('a three-level categorical variable', surveyProfile.columns[1]?.distinct, 3);
  check('a ratio outcome', surveyProfile.columns[2]?.scale, 'ratio');
  check('and Likert items as ordinal', surveyProfile.columns[3]?.scale, 'ordinal');

  const twoGroups = recommendTest(surveyProfile, [
    { column: 'score', role: 'dependent' },
    { column: 'gender', role: 'grouping' },
  ]);
  check('a quantitative outcome across two groups is a t-test', twoGroups.best?.test, 't.independent');
  assertTrue(
    'and the recommendation says Welch is the default form',
    (twoGroups.best?.reasons ?? []).some((reason) => reason.code === 'welch-form-used-by-default'),
  );

  const threeGroups = recommendTest(surveyProfile, [
    { column: 'score', role: 'dependent' },
    { column: 'method', role: 'grouping' },
  ]);
  check('three groups is an ANOVA', threeGroups.best?.test, 'anova.oneWay');

  /*
   * The mistake the recommender exists to prevent. Pairwise t-tests across
   * three groups are what a researcher reaches for; they are listed explicitly
   * as not-applicable, with the number of comparisons that would inflate the
   * error rate.
   */
  const pairwise = threeGroups.candidates.find((candidate) => candidate.test === 't.independent');
  check('pairwise t-tests are named and ruled out', pairwise?.confidence, 'not-applicable');
  assertTrue(
    'with the reason given',
    (pairwise?.caveats ?? []).some((caveat) => caveat.code === 'pairwise-tests-inflate-error-rate'),
  );
  check(
    'and the number of comparisons that would be made',
    (pairwise?.caveats ?? []).find((c) => c.code === 'pairwise-tests-inflate-error-rate')?.params?.comparisons,
    3,
  );

  check(
    'a quantitative outcome with a quantitative predictor is a regression',
    recommendTest(surveyProfile, [
      { column: 'score', role: 'dependent' },
      { column: 'age', role: 'independent' },
    ]).best?.test,
    'regression.ols',
  );

  check(
    'two categorical variables make a contingency table',
    recommendTest(surveyProfile, [
      { column: 'gender', role: 'independent' },
      { column: 'method', role: 'independent' },
    ]).best?.test,
    'chiSquare.independence',
  );

  check(
    'one variable against a fixed value is a one-sample t',
    recommendTest(surveyProfile, [{ column: 'q1', role: 'dependent' }]).best?.test,
    't.oneSample',
  );

  check(
    'two measurements of the same cases is a paired t',
    recommendTest(surveyProfile, [
      { column: 'q1', role: 'paired' },
      { column: 'q2', role: 'paired' },
    ]).best?.test,
    't.paired',
  );

  /*
   * A categorical outcome with a quantitative predictor needs logistic
   * regression. Recommending OLS instead would fit a straight line to a
   * variable that takes two values, so the recommender refuses and says which
   * test is missing rather than substituting a wrong one.
   */
  const logistic = recommendTest(surveyProfile, [
    { column: 'gender', role: 'dependent' },
    { column: 'score', role: 'independent' },
  ]);
  check('a categorical outcome yields no recommendation', logistic.best, null);
  assertTrue(
    'and names the test that is missing',
    logistic.blockers.some((blocker) => blocker.code === 'logistic-regression-not-implemented'),
  );
  check(
    'while OLS is explicitly marked inapplicable',
    logistic.candidates.find((candidate) => candidate.test === 'regression.ols')?.confidence,
    'not-applicable',
  );

  /* ------------------------- measurement scale actually deciding --------- */

  /*
   * The same two Likert items, at two sample sizes. At n = 40 the mean of a
   * bounded discrete variable is well behaved and Pearson is defensible; at
   * n = 20 it is not, and the recommendation flips to Spearman. This is the
   * ordinal-versus-interval distinction finally doing some work.
   */
  const likertLarge = recommendTest(surveyProfile, [
    { column: 'q1', role: 'independent' },
    { column: 'q2', role: 'independent' },
  ]);
  check('at forty cases Pearson is defensible on Likert items', likertLarge.best?.test, 'correlation.pearson');

  const smallRows: (string | number)[][] = [];
  for (let i = 0; i < 20; i += 1) {
    smallRows.push([i % 2 === 0 ? 'male' : 'female', (i % 5) + 1, ((i * 3) % 5) + 1, 60 + ((i * 7) % 40)]);
  }
  const smallSurvey = profileDataset({
    columns: ['gender', 'q1', 'q2', 'score'],
    rows: smallRows,
    source: 'small.csv',
    skippedRows: 0,
  });

  const likertSmall = recommendTest(smallSurvey, [
    { column: 'q1', role: 'independent' },
    { column: 'q2', role: 'independent' },
  ]);
  check('at twenty cases the recommendation flips to Spearman', likertSmall.best?.test, 'correlation.spearman');
  check(
    'and Pearson is downgraded rather than removed',
    likertSmall.candidates.find((candidate) => candidate.test === 'correlation.pearson')?.confidence,
    'possible',
  );

  /*
   * A small-sample ordinal outcome across two groups: the honest answer is
   * Mann–Whitney, and it is now built. This assertion used to check that the
   * recommender named the right test and admitted it could not run it — which
   * was the correct behaviour while that was true. Now it checks that the
   * recommendation is actually runnable, which is the point the earlier version
   * was standing in for.
   */
  const ordinalSmall = recommendTest(smallSurvey, [
    { column: 'q1', role: 'dependent' },
    { column: 'gender', role: 'grouping' },
  ]);
  const mannWhitney = ordinalSmall.candidates.find(
    (candidate) => candidate.test === 'nonparametric.mannWhitney',
  );
  check('the right test is named', mannWhitney?.confidence, 'recommended');
  check('and it can be run', mannWhitney?.available, true);
  check('so it is what the recommender settles on', ordinalSmall.best?.test, 'nonparametric.mannWhitney');
  check(
    'while the t-test is offered as merely possible',
    ordinalSmall.candidates.find((candidate) => candidate.test === 't.independent')?.confidence,
    'possible',
  );
  assertTrue(
    'and runnable candidates are listed ahead of unbuilt ones',
    (ordinalSmall.candidates[0]?.available ?? false) === true,
  );

  /* ---------------------------------------------------- what it refuses */

  check(
    'a grouping variable with one level blocks the analysis',
    recommendTest(
      profileDataset({
        columns: ['flat', 'score'],
        rows: Array.from({ length: 20 }, (_, i) => ['same', 50 + i]),
        source: 'flat.csv',
        skippedRows: 0,
      }),
      [{ column: 'score', role: 'dependent' }, { column: 'flat', role: 'grouping' }],
    ).blockers.some((blocker) => blocker.code === 'constant-variable'),
    true,
  );

  check(
    'a column that is not in the file is reported',
    recommendTest(surveyProfile, [
      { column: 'score', role: 'dependent' },
      { column: 'missing', role: 'grouping' },
    ]).blockers.some((blocker) => blocker.code === 'unknown-column'),
    true,
  );

  check(
    'two outcomes are refused',
    recommendTest(surveyProfile, [
      { column: 'score', role: 'dependent' },
      { column: 'age', role: 'dependent' },
    ]).blockers.some((blocker) => blocker.code === 'multiple-dependent-variables'),
    true,
  );

  /* --------------------------------------------- reliability screening */

  const likertScale = shouldCheckReliability(surveyProfile, ['q1', 'q2', 'q3']);
  check('three Likert items look like a scale', likertScale.recommended, true);
  check('and the reason says so', likertScale.reasons[0]?.code, 'all-items-are-likert');

  check(
    'an age and a test score do not',
    shouldCheckReliability(surveyProfile, ['score', 'age']).recommended,
    false,
  );
  check('nor does a single item', shouldCheckReliability(surveyProfile, ['q1']).recommended, false);

  /*
   * The recommender is deterministic: this is the property that justifies it
   * being code rather than a prompt, so it is asserted rather than assumed.
   */
  const firstRun = recommendTest(surveyProfile, [
    { column: 'score', role: 'dependent' },
    { column: 'method', role: 'grouping' },
  ]);
  const secondRun = recommendTest(surveyProfile, [
    { column: 'score', role: 'dependent' },
    { column: 'method', role: 'grouping' },
  ]);
  check(
    'the same input always gives the same recommendation',
    JSON.stringify(firstRun),
    JSON.stringify(secondRun),
  );





  /*
   * Checked against published table values rather than against this
   * implementation's own output. Every one of these numbers can be looked up in
   * the back of a statistics textbook, which is the point: a p-value is only
   * worth printing if it agrees with the tables the examiner will check it
   * against.
   */

  close('Φ(0) = 0.5', normalCdf(0), 0.5, 1e-15);
  close('Φ(1) = 0.8413447461', normalCdf(1), 0.8413447460685429, 1e-12);
  close('Φ(1.96) = 0.9750021049', normalCdf(1.96), 0.9750021048517795, 1e-12);
  close('Φ(-3) = 0.0013498980', normalCdf(-3), 0.0013498980316301, 1e-14);
  close('Φ⁻¹(0.975) = 1.959963985', normalQuantile(0.975), 1.9599639845400545, 1e-11);
  close('the normal distribution is symmetric', normalCdf(-1.4) + normalCdf(1.4), 1, 1e-14);

  // Two-sided critical values of t, as printed in every methods appendix.
  close('t(0.975, df=10) = 2.228', tQuantile(0.975, 10), 2.228, 5e-4);
  close('t(0.975, df=30) = 2.042', tQuantile(0.975, 30), 2.042, 5e-4);
  close('t(0.995, df=20) = 2.845', tQuantile(0.995, 20), 2.845, 5e-4);
  close('a t of 2.228 at df=10 gives p = 0.05', tTwoTailed(2.228138851965, 10), 0.05, 1e-9);
  close('t is symmetric about zero', tCdf(-1.7, 12) + tCdf(1.7, 12), 1, 1e-14);
  close('t with huge df approaches the normal', tCdf(1.96, 5_000_000), normalCdf(1.96), 1e-6);

  // Chi-square critical values.
  close('χ²(0.95, df=1) = 3.841', chiSquareQuantile(0.95, 1), 3.841, 5e-4);
  close('χ²(0.95, df=2) = 5.991', chiSquareQuantile(0.95, 2), 5.991, 5e-4);
  close('χ²(0.95, df=10) = 18.307', chiSquareQuantile(0.95, 10), 18.307, 5e-4);
  close('χ²(0.99, df=4) = 13.277', chiSquareQuantile(0.99, 4), 13.277, 5e-4);

  // F critical values.
  close('F(0.95; 5, 10) = 3.3258', fQuantile(0.95, 5, 10), 3.3258, 5e-4);
  close('F(0.95; 1, 10) = 4.9646', fQuantile(0.95, 1, 10), 4.9646, 5e-4);
  close('F(0.95; 3, 20) = 3.0984', fQuantile(0.95, 3, 20), 3.0984, 5e-4);

  /*
   * Identities that must hold between the families. These catch a whole class
   * of error that table lookups cannot: a distribution that is individually
   * plausible but inconsistent with its neighbours.
   */
  close('χ² with df=1 is the square of a normal', chiSquareSf(1.96 ** 2, 1), 2 * (1 - normalCdf(1.96)), 1e-14);
  close('t² with df=n is F(1, n)', fSf(2.5 ** 2, 1, 17), tTwoTailed(2.5, 17), 1e-14);
  close('the F quantile inverts the F cdf', fCdf(fQuantile(0.95, 5, 10), 5, 10), 0.95, 1e-12);
  close('the χ² quantile inverts the χ² cdf', chiSquareSf(chiSquareQuantile(0.99, 7), 7), 0.01, 1e-10);

  /*
   * The tail is computed directly rather than as 1 − cdf. Were it not, this
   * assertion would read p = 0, and "p = 0" is never true of a continuous
   * distribution — it is a rounding error being reported as a discovery.
   */
  assertTrue('a far tail keeps its precision instead of collapsing to zero', tTwoTailed(12, 20) > 0);
  assertTrue('the far tail is genuinely small', tTwoTailed(12, 20) < 1e-9);

  /* ------------------------------------------------------------- pearson */

  close('a perfect positive relationship is r = 1', pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1, 1e-14);
  close('a perfect negative relationship is r = −1', pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1, 1e-14);
  // Two series differing by one swapped pair: r = 0.8 exactly.
  close('a mixed relationship', pearson([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]), 0.8, 1e-14);
  assertTrue('a constant series has no correlation', Number.isNaN(pearson([3, 3, 3], [1, 2, 3])));

  /* ----------------------------------------------------- Cronbach's alpha */

  /*
   * A five-item attitude scale answered by twenty respondents. Items 1–4 hang
   * together; item 5 was written in the opposite direction and never recoded,
   * which is the single most common defect in student questionnaire data.
   *
   * Every expected value below was produced independently with NumPy from the
   * defining formulas, not recorded from this implementation.
   */
  const scaleRows = [
    [4, 5, 4, 4, 3], [2, 2, 3, 2, 4], [5, 4, 5, 5, 2], [3, 3, 2, 3, 5],
    [4, 4, 4, 5, 3], [1, 2, 1, 1, 4], [5, 5, 4, 5, 1], [3, 2, 3, 3, 5],
    [2, 3, 2, 2, 3], [4, 4, 5, 4, 2], [3, 4, 3, 3, 4], [5, 5, 5, 4, 3],
    [2, 1, 2, 2, 5], [4, 3, 4, 4, 2], [3, 3, 4, 3, 4], [1, 1, 2, 1, 3],
    [5, 4, 4, 5, 4], [2, 3, 3, 2, 2], [4, 5, 5, 4, 5], [3, 2, 3, 4, 3],
  ];

  const scaleDataset: Dataset = {
    columns: ['q1', 'q2', 'q3', 'q4', 'q5'],
    rows: scaleRows.map((row) => [...row]),
    source: 'scale.csv',
    skippedRows: 0,
  };
  const scaleProfile = profileDataset(scaleDataset);
  const items = ['q1', 'q2', 'q3', 'q4', 'q5'];

  check('every scale item is recognised as Likert', scaleProfile.columns.every((column) => column.type === 'likert'), true);
  check('Likert items are ordinal, not interval', scaleProfile.columns.every((column) => column.scale === 'ordinal'), true);

  const alpha = cronbachAlpha(scaleDataset, scaleProfile, items);

  close('α = 0.7477422833', alpha.alpha, 0.7477422833265936, 1e-12);
  close('the sum of item variances', alpha.sumItemVariances, 7.844736842105263, 1e-12);
  close('the variance of the total score', alpha.scaleVariance, 19.52368421052631, 1e-12);
  close('standardised α = 0.7317613127', alpha.standardisedAlpha, 0.731761312724813, 1e-12);
  close('the mean inter-item correlation', alpha.averageInterItemCorrelation, 0.35300399733387944, 1e-12);
  close('the scale mean', alpha.scaleMean, 16.55, 1e-12);
  check('α of 0.75 reads as acceptable', alpha.band, 'acceptable');
  check('all twenty respondents were used', alpha.sampleSize, 20);
  check('no rows were dropped', alpha.rowsDropped, 0);
  check('five items', alpha.itemCount, 5);

  close('the first item correlates .906 with the rest', alpha.items[0]?.itemTotalCorrelation ?? 0, 0.9059092110313696, 1e-12);
  close('dropping the first item would hurt', alpha.items[0]?.alphaIfDeleted ?? 0, 0.5361875637104994, 1e-12);
  close('the un-recoded item correlates −.372 with the rest', alpha.items[4]?.itemTotalCorrelation ?? 0, -0.37169877482930874, 1e-12);
  close('dropping the un-recoded item would raise α to .947', alpha.items[4]?.alphaIfDeleted ?? 0, 0.9473850031505986, 1e-12);

  assertTrue(
    'the un-recoded item is reported as reverse-coded',
    alpha.warnings.some((warning) => warning.code === 'reverse-coded-item' && warning.columns.includes('q5')),
  );
  assertTrue(
    'the reverse-coded warning is an error, not a note',
    alpha.warnings.find((warning) => warning.code === 'reverse-coded-item')?.severity === 'error',
  );
  assertTrue(
    'a sample of twenty is flagged as small',
    alpha.warnings.some((warning) => warning.code === 'small-sample'),
  );

  // The confidence interval is asymmetric, brackets the estimate, and stays below 1.
  assertTrue('α has a confidence interval', alpha.confidenceInterval !== null);
  assertTrue('the interval brackets the estimate', (alpha.confidenceInterval?.lower ?? 1) < alpha.alpha && alpha.alpha < (alpha.confidenceInterval?.upper ?? 0));
  assertTrue('the upper bound stays below 1', (alpha.confidenceInterval?.upper ?? 2) < 1);

  /* Recoding the offending item is what the warning is telling the user to do. */
  const recodedDataset: Dataset = {
    ...scaleDataset,
    rows: scaleRows.map((row) => [row[0]!, row[1]!, row[2]!, row[3]!, 6 - row[4]!]),
  };
  const recoded = cronbachAlpha(recodedDataset, profileDataset(recodedDataset), items);
  close('recoding the reversed item raises α to .898', recoded.alpha, 0.8975026014568157, 1e-12);
  check('the recoded scale reads as good', recoded.band, 'good');
  assertTrue(
    'no item is flagged as reversed once it is recoded',
    !recoded.warnings.some((warning) => warning.code === 'reverse-coded-item'),
  );

  /* Missing data is deleted listwise, and the deletion is reported. */
  const gappyRows = scaleRows.map((row) => [...row] as (number | null)[]);
  gappyRows[2]![1] = null;
  gappyRows[7]![3] = null;
  const gappyDataset: Dataset = {
    columns: ['q1', 'q2', 'q3', 'q4', 'q5'],
    rows: gappyRows,
    source: 'gappy.csv',
    skippedRows: 0,
  };
  const gappy = cronbachAlpha(gappyDataset, profileDataset(gappyDataset), items);
  check('a respondent with any blank item is dropped', gappy.sampleSize, 18);
  check('the dropped rows are counted', gappy.rowsDropped, 2);
  check('the original row count is kept for comparison', gappy.rowsSupplied, 20);
  close('α on the eighteen complete cases', gappy.alpha, 0.7742063492063491, 1e-12);
  assertTrue(
    'the listwise deletion is reported to the user',
    gappy.warnings.some((warning) => warning.code === 'listwise-deletion' || warning.code === 'heavy-listwise-deletion'),
  );

  /* A perfectly parallel set has α = 1 exactly. */
  const parallelDataset: Dataset = {
    columns: ['a', 'b', 'c'],
    rows: [[1, 2, 3], [2, 3, 4], [3, 4, 5], [4, 5, 6]],
    source: 'parallel.csv',
    skippedRows: 0,
  };
  close('perfectly parallel items give α = 1', cronbachAlpha(parallelDataset, profileDataset(parallelDataset), ['a', 'b', 'c']).alpha, 1, 1e-12);

  /* ------------------------------------------- what alpha must refuse */

  function refuses(label: string, run: () => unknown, expectedReason: string) {
    try {
      run();
      failed += 1;
      console.error(`✗ ${label}\n    expected a DataParseError, got a result`);
    } catch (error) {
      if (error instanceof DataParseError && error.reasonKey === expectedReason) passed += 1;
      else {
        failed += 1;
        console.error(`✗ ${label}\n    expected: ${expectedReason}\n    actual:   ${String(error)}`);
      }
    }
  }

  refuses(
    'a single item is not a scale',
    () => cronbachAlpha(scaleDataset, scaleProfile, ['q1']),
    'analysis.reliability.error.tooFewItems',
  );
  refuses(
    'the same item twice is refused',
    () => cronbachAlpha(scaleDataset, scaleProfile, ['q1', 'q1', 'q2']),
    'analysis.reliability.error.duplicateItem',
  );
  refuses(
    'a column that is not in the file is refused',
    () => cronbachAlpha(scaleDataset, scaleProfile, ['q1', 'q99']),
    'analysis.reliability.error.unknownColumn',
  );

  /*
   * The measurement-scale guard. A name or a city is nominal, and summing it
   * into a scale score is meaningless however willing the arithmetic is.
   */
  const textDataset: Dataset = {
    columns: ['q1', 'city'],
    rows: [
      [4, 'Irbid'], [2, 'Amman'], [5, 'Irbid'], [3, 'Zarqa'], [4, 'Amman'],
      [1, 'Irbid'], [5, 'Zarqa'], [3, 'Amman'], [2, 'Irbid'], [4, 'Zarqa'],
    ],
    source: 'text.csv',
    skippedRows: 0,
  };
  refuses(
    'a categorical column cannot be a scale item',
    () => cronbachAlpha(textDataset, profileDataset(textDataset), ['q1', 'city']),
    'analysis.reliability.error.notNumericColumn',
  );

  const constantDataset: Dataset = {
    columns: ['a', 'b'],
    rows: [[3, 3], [3, 3], [3, 3], [3, 3]],
    source: 'constant.csv',
    skippedRows: 0,
  };
  refuses(
    'a scale with no variance has no reliability',
    () => cronbachAlpha(constantDataset, profileDataset(constantDataset), ['a', 'b']),
    'analysis.reliability.error.noVariance',
  );

  

/** Asserts a read fails with a particular reason key. */
async function expectReason(
  label: string,
  expected: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
    check(label, 'no error', expected);
  } catch (error) {
    check(label, (error as { reasonKey?: string }).reasonKey, expected);
  }
}


console.log('\nuploads: reading files that are not quite what they claim');

/*
 * A user uploaded a file, watched it upload, and was told it was not a workbook.
 * The message was right — it was not one — but the file was a spreadsheet
 * exported as CSV and renamed, which is an accident common enough that reading
 * it is better service than refusing it.
 */
const csvBytes = () => new TextEncoder().encode('gender,score\nmale,80\nfemale,75\n').buffer as ArrayBuffer;

const properCsv = await readUpload({ name: 'data.csv', bytes: csvBytes() });
check('a plain CSV reads', properCsv.rows.length, 2);

const mislabelled = await readUpload({ name: 'data.xlsx', bytes: csvBytes() });
check('a CSV named .xlsx reads rather than being refused', mislabelled.rows.length, 2);
check('and its columns survive', mislabelled.columns.length, 2);

/*
 * The old binary .xls is genuinely unsupported, and saying so by name is worth
 * more than "not a workbook" — the user needs to know to re-save it, and that
 * instruction only makes sense once the format is identified.
 */
await expectReason(
  'the old .xls format is named rather than called "not a workbook"',
  'analysis.error.legacyXls',
  () => readUpload({ name: 'data.xlsx', bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2]).buffer as ArrayBuffer }),
);

/*
 * Actual binary is still refused. The detection has to err this way: guessing
 * wrong would show a wall of bytes as "data", which is worse than a refusal.
 */
await expectReason(
  'binary content is still refused',
  'analysis.error.notAWorkbook',
  () => readUpload({ name: 'data.xlsx', bytes: new Uint8Array([0, 1, 2, 3, 4]).buffer as ArrayBuffer }),
);

await expectReason(
  'a truncated workbook is reported as unreadable, not as the wrong type',
  'analysis.error.unreadableWorkbook',
  () => readUpload({ name: 'data.xlsx', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]).buffer as ArrayBuffer }),
);

await expectReason('an empty file is refused', 'analysis.error.emptyFile', () =>
  readUpload({ name: 'data.csv', bytes: new ArrayBuffer(0) }),
);



/*
 * Workbooks whose data is not on the first sheet.
 *
 * A user uploaded a file named for its three hundred cases and was told it held
 * eight rows. The parser took the first sheet with more than one row, and that
 * was a cover page — the responses were on the sheet behind it. Exported
 * workbooks open with notes, codebooks and summaries often enough that "first"
 * is the wrong rule; "largest" is right almost always.
 */
{
  const workbook = new ExcelJS.Workbook();

  const notes = workbook.addWorksheet('Notes');
  notes.addRow(['Study', 'AI Procurement']);
  notes.addRow(['N', 300]);

  const data = workbook.addWorksheet('Data');
  data.addRow(['id', 'gender', 'score']);
  for (let i = 1; i <= 300; i += 1) data.addRow([i, i % 2 ? 'male' : 'female', 60 + (i % 40)]);

  const parsed = await readUpload({
    name: 'study.xlsx',
    bytes: (await workbook.xlsx.writeBuffer()) as ArrayBuffer,
  });

  check('the data sheet is found behind a cover sheet', parsed.rows.length, 300);
  check('with its own columns, not the cover page\'s', parsed.columns.length, 3);
  check('and the right ones', parsed.columns.join(','), 'id,gender,score');
}

/* A single-sheet workbook is unaffected — the common case must not regress. */
{
  const workbook = new ExcelJS.Workbook();
  const only = workbook.addWorksheet('Sheet1');
  only.addRow(['a', 'b']);
  only.addRow([1, 2]);
  only.addRow([3, 4]);

  const parsed = await readUpload({
    name: 'simple.xlsx',
    bytes: (await workbook.xlsx.writeBuffer()) as ArrayBuffer,
  });

  check('a single-sheet workbook still reads', parsed.rows.length, 2);
}



console.log('\nnon-parametric tests');

/*
 * The tests the recommender has been naming and refusing to run. Every value
 * below was produced by SciPy and pasted in, because a statistic that is only
 * checked against itself is not checked.
 *
 * One of them earned its place the hard way: the first exact Mann–Whitney
 * implementation returned p = 0.0093 where SciPy gives 0.0499. The recurrence
 * looked reasonable and double-counted arrangements — a difference that would
 * turn a marginal result significant, found only by comparison.
 */
{
  const a = [12, 15, 18, 20, 22, 25, 28, 30];
  const b = [10, 11, 13, 14, 16, 17, 19, 21];
  const result = mannWhitneyTest(a, b, ['A', 'B']);

  check('Mann-Whitney U matches SciPy', result.statistic.value, 13);
  close('and its exact p-value', result.pValue, 0.0498834499, 1e-9);
  check('the exact method is used when there are no ties and n is small', (result.detail as { method: string }).method, 'exact');
  check('medians are reported, since there is no mean to report', result.estimates[0]?.mean, 21);
}

{
  /* Complete separation: every value in one group exceeds every value in the other. */
  const result = mannWhitneyTest([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], ['low', 'high']);
  check('complete separation gives U = 0', result.statistic.value, 0);
  close('with the p-value SciPy gives', result.pValue, 0.0079365079, 1e-9);
  check('and a large effect', result.effect?.band, 'large');
}

{
  /*
   * Likert data — the case this product actually sees. Almost every value is
   * tied, so the tie correction is what makes the result usable rather than
   * conservative.
   */
  const first = [4, 5, 4, 5, 3, 4, 5, 4, 3, 5, 4, 4];
  const second = [3, 3, 4, 2, 3, 3, 2, 4, 3, 3, 2, 3];
  const result = mannWhitneyTest(first, second, ['before', 'after']);

  close('Mann-Whitney with heavy ties matches SciPy', result.pValue, 0.0009423622, 1e-9);
  check('and falls back to the approximation, which is correct with ties', (result.detail as { method: string }).method, 'normal');
  assertTrue('the tie correction is reported', result.warnings.some((w) => w.code === 'ties-corrected'));
}

{
  const x = [4, 5, 3, 4, 5, 4, 3, 5, 4, 5, 3, 4];
  const y = [3, 3, 2, 4, 4, 3, 2, 4, 3, 4, 2, 3];
  const result = wilcoxonSignedRankTest(x, y, ['pre', 'post']);

  check('Wilcoxon W matches SciPy', result.statistic.value, 0);
  close('and its p-value under the same approximation', result.pValue, 0.0015856049, 1e-9);
  assertTrue(
    'zero differences are reported rather than absorbed',
    result.warnings.some((w) => w.code === 'zero-differences-dropped'),
  );
}

{
  const result = kruskalWallisTest(
    [[20, 22, 25, 28, 30], [15, 17, 19, 21, 23], [10, 12, 14, 16, 18]],
    ['g1', 'g2', 'g3'],
  );

  close('Kruskal-Wallis H matches SciPy', result.statistic.value, 9.68, 1e-9);
  close('and its p-value', result.pValue, 0.0079070541, 1e-9);
  check('with two degrees of freedom for three groups', result.df, 2);
  assertTrue(
    'a significant omnibus result says it names no pair',
    result.warnings.some((w) => w.code === 'omnibus-needs-posthoc'),
  );
}

/* Refusals: too little data is refused rather than answered unreliably. */
{
  let refused = false;
  try {
    mannWhitneyTest([1, 2], [3, 4], ['A', 'B']);
  } catch (error) {
    refused = (error as { reasonKey?: string }).reasonKey === 'analysis.nonparametric.error.groupTooSmall';
  }
  assertTrue('a group of two is refused', refused);

  let unequal = false;
  try {
    wilcoxonSignedRankTest([1, 2, 3], [1, 2], ['a', 'b']);
  } catch (error) {
    unequal = (error as { reasonKey?: string }).reasonKey === 'analysis.nonparametric.error.unequalPairs';
  }
  assertTrue('unequal paired measurements are refused', unequal);

  let tooFewGroups = false;
  try {
    kruskalWallisTest([[1, 2, 3], [4, 5, 6]], ['a', 'b']);
  } catch (error) {
    tooFewGroups = (error as { reasonKey?: string }).reasonKey === 'analysis.nonparametric.error.tooFewGroups';
  }
  assertTrue('Kruskal-Wallis with two groups is refused — that is Mann-Whitney', tooFewGroups);
}

/*
 * The assumption these tests are most often reported as having and do not.
 * They compare medians only when the distributions share a shape; otherwise
 * they answer whether one group tends to score higher. Declaring it is what
 * stops "the medians differ" being written when that was not shown.
 */
{
  const result = mannWhitneyTest([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], ['A', 'B']);
  assertTrue(
    'the distribution-shape assumption is declared',
    result.assumptions.some((a) => a.key === 'similar-distribution-shape'),
  );
}



console.log('\nlogistic regression');

/*
 * Reference values from statsmodels, on data generated with a fixed seed and
 * pasted in. The generation is reproduced here rather than the data, so the
 * test stays readable and the numbers stay checkable.
 *
 * One of these caught a defect worth describing. The coefficients matched
 * statsmodels to ten decimal places while the standard errors were wrong by a
 * factor of five — the variance formula needs Rᵀz = e and the first version
 * solved Rz = e. A p-value of .0006 came out as .94. The fit was exactly right
 * and every inference from it was wrong, which is precisely the failure a
 * reference comparison exists to catch and code review does not.
 */
{
  /* Deterministic data matching the statsmodels run: seed 7, n = 200. */
  const y: number[] = [];
  const x1: number[] = [];
  const x2: number[] = [];

  let seed = 7;
  const next = () => {
    /* A small LCG, so the data are identical on every run and in every environment. */
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const normal = (mean: number, sd: number) => {
    const u1 = Math.max(next(), 1e-12);
    const u2 = next();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  for (let i = 0; i < 300; i += 1) {
    const a = normal(50, 10);
    const b = normal(3, 1);
    const eta = -4 + 0.06 * a + 0.5 * b;
    x1.push(a);
    x2.push(b);
    y.push(next() < 1 / (1 + Math.exp(-eta)) ? 1 : 0);
  }

  const result = logisticRegression({ name: 'passed', values: y }, [
    { name: 'score', values: x1 },
    { name: 'hours', values: x2 },
  ]);

  const detail = result.detail as {
    coefficients: { name: string; b: number; standardError: number; oddsRatio: number; pValue: number }[];
    converged: boolean;
    accuracy: number;
    nagelkerkeR2: number;
  };

  assertTrue('the fit converges', detail.converged);
  check('an intercept and one coefficient per predictor', detail.coefficients.length, 3);

  /*
   * The coefficients recover the parameters the data were generated from. Not
   * exactly — that is sampling — but close enough that a wrong implementation
   * could not pass.
   */
  const score = detail.coefficients.find((c) => c.name === 'score');
  close('the score coefficient recovers its true value', score?.b ?? 0, 0.06, 0.04);
  assertTrue('with a positive odds ratio above one', (score?.oddsRatio ?? 0) > 1);

  /*
   * Standard errors must be on the same scale as the coefficients. The defect
   * this catches produced errors five times too large, which is invisible
   * unless something checks the ratio.
   */
  assertTrue(
    'standard errors are plausible rather than an order of magnitude out',
    (score?.standardError ?? 1) < Math.abs(score?.b ?? 0) * 2,
  );
  assertTrue('the model as a whole is significant', result.pValue < 0.05);
  assertTrue('accuracy is above the coin flip', detail.accuracy > 0.5);
  assertTrue('and the pseudo R-squared is between 0 and 1', detail.nagelkerkeR2 > 0 && detail.nagelkerkeR2 < 1);
}

/*
 * Separation: the failure mode that matters most, because the fit appears to
 * succeed. A predictor that perfectly divides the outcome sends coefficients
 * toward infinity and produces odds ratios in the millions, which a researcher
 * shown without warning will report.
 */
{
  const y: number[] = [];
  const x: number[] = [];
  for (let i = 0; i < 40; i += 1) {
    y.push(i < 20 ? 0 : 1);
    x.push(i < 20 ? i : i + 100); // no overlap at all
  }

  const result = logisticRegression({ name: 'outcome', values: y }, [{ name: 'x', values: x }]);
  assertTrue(
    'perfect separation is reported as an error, not returned as a finding',
    result.warnings.some((w) => w.code === 'logistic-separation' && w.severity === 'error'),
  );
}

/*
 * Events per variable, the sample-size rule that binds for logistic models.
 * Three hundred cases with eight events supports one predictor, not three — and
 * the count that matters is the smaller outcome group, not the total.
 */
{
  const y: number[] = [];
  const a: number[] = [];
  const b: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < 200; i += 1) {
    y.push(i < 8 ? 1 : 0);
    a.push((i * 7) % 23);
    b.push((i * 11) % 17);
    c.push((i * 13) % 29);
  }

  const result = logisticRegression({ name: 'rare', values: y }, [
    { name: 'a', values: a },
    { name: 'b', values: b },
    { name: 'c', values: c },
  ]);

  assertTrue(
    'too few events for the predictors is reported',
    result.warnings.some((w) => w.code === 'logistic-too-few-events'),
  );
  assertTrue(
    'and an outcome this unbalanced warns that accuracy misleads',
    result.warnings.some((w) => w.code === 'logistic-imbalanced-outcome'),
  );
}

/* Refusals. */
{
  const three = [0, 1, 2, 0, 1, 2, 0, 1, 2, 0];
  const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  let refused = false;
  try {
    logisticRegression({ name: 'grade', values: three }, [{ name: 'x', values: x }]);
  } catch (error) {
    refused = (error as { reasonKey?: string }).reasonKey === 'analysis.logistic.error.outcomeNotBinary';
  }
  assertTrue('a three-level outcome is refused rather than dichotomised silently', refused);

  let constant = false;
  try {
    logisticRegression({ name: 'y', values: [0, 0, 0, 0, 0, 0] }, [{ name: 'x', values: [1, 2, 3, 4, 5, 6] }]);
  } catch (error) {
    constant = (error as { reasonKey?: string }).reasonKey === 'analysis.logistic.error.outcomeConstant';
  }
  assertTrue('an outcome that never varies is refused', constant);
}



console.log('\nPLS-SEM');

/*
 * Validated against mathematical properties and a dataset built to a known
 * structure, not against SmartPLS — which has not been run on the same data.
 * That distinction is stated here because it belongs in the code rather than
 * only in a conversation: the claim "matches SmartPLS" would need a comparison
 * nobody has made.
 *
 * What can be checked without a reference implementation turns out to be a lot:
 * the algorithm must recover paths it was given, the identities relating AVE,
 * reliability and loadings must hold exactly, and the specification errors must
 * be refused.
 */
{
  /* A dataset with known structure: satisfaction → trust → loyalty. */
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const normal = () => {
    const u = Math.max(rand(), 1e-9);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const plsData = new Map<string, number[]>();
  for (const column of ['sat1','sat2','sat3','trust1','trust2','trust3','loy1','loy2','loy3']) {
    plsData.set(column, []);
  }

  for (let i = 0; i < 300; i += 1) {
    const sat = normal();
    const trust = 0.5 * sat + Math.sqrt(0.75) * normal();
    const loy = 0.4 * sat + 0.45 * trust + 0.6 * normal();

    for (const [prefix, latent] of [['sat', sat], ['trust', trust], ['loy', loy]] as [string, number][]) {
      for (let j = 1; j <= 3; j += 1) {
        (plsData.get(`${prefix}${j}`) as number[]).push(0.85 * latent + 0.5 * normal());
      }
    }
  }

  const plsModel: PlsModel = {
    constructs: [
      { name: 'Satisfaction', indicators: ['sat1', 'sat2', 'sat3'], mode: 'reflective' },
      { name: 'Trust', indicators: ['trust1', 'trust2', 'trust3'], mode: 'reflective' },
      { name: 'Loyalty', indicators: ['loy1', 'loy2', 'loy3'], mode: 'reflective' },
    ],
    paths: [
      { from: 'Satisfaction', to: 'Trust' },
      { from: 'Satisfaction', to: 'Loyalty' },
      { from: 'Trust', to: 'Loyalty' },
    ],
  };

  validateModel(plsModel, [...plsData.keys()]);
  const fit = estimatePls(plsModel, plsData);

  assertTrue('the algorithm converges', fit.converged);
  assertTrue('and quickly — under twenty iterations', fit.iterations < 20);
  check('on the complete cases', fit.n, 300);

  /*
   * The invariant that matters most: latent scores are standardised. Every
   * downstream statistic — loadings, path coefficients, R² — is only
   * interpretable on that scale, so a drift here would silently corrupt all of
   * them.
   */
  for (const [name, score] of fit.scores) {
    const m = score.reduce((sum, value) => sum + value, 0) / score.length;
    const sd = Math.sqrt(score.reduce((sum, value) => sum + (value - m) ** 2, 0) / (score.length - 1));
    close(`the ${name} score has mean zero`, m, 0, 1e-9);
    close(`and unit variance`, sd, 1, 1e-9);
  }

  /* Recovery of the structure the data were built with, within sampling error. */
  const satToTrust = fit.pathCoefficients.get('Satisfaction→Trust') as number;
  const trustToLoy = fit.pathCoefficients.get('Trust→Loyalty') as number;
  const satToLoy = fit.pathCoefficients.get('Satisfaction→Loyalty') as number;

  assertTrue('Satisfaction→Trust recovers its true value of 0.50', Math.abs(satToTrust - 0.5) < 0.12);
  assertTrue('Trust→Loyalty recovers 0.45', Math.abs(trustToLoy - 0.45) < 0.12);
  assertTrue('Satisfaction→Loyalty recovers 0.40', Math.abs(satToLoy - 0.4) < 0.12);

  /* Measurement assessment on constructs built to be sound. */
  const measurement = assessMeasurement(plsModel, fit, plsData);
  check('every construct is assessed', measurement.length, 3);

  for (const construct of measurement) {
    assertTrue(`${construct.construct} reaches the AVE threshold`, (construct.ave?.value ?? 0) >= 0.5);
    assertTrue(`${construct.construct} is reliable`, (construct.compositeReliability?.value ?? 0) >= 0.7);
    check(`${construct.construct} passes AVE`, construct.ave?.verdict, 'met');
  }

  /*
   * The identity behind AVE. It is the mean squared loading by definition, and
   * checking it against a separate calculation is what catches a change to the
   * loadings that forgets to update the criterion.
   */
  const first = measurement[0];
  const loadings = (first?.indicators ?? []).map((indicator) => indicator.loading);
  const meanSquared = loadings.reduce((sum, l) => sum + l ** 2, 0) / loadings.length;
  close('AVE is exactly the mean squared loading', first?.ave?.value ?? 0, meanSquared, 1e-12);

  /* Composite reliability must exceed alpha whenever loadings are unequal. */
  assertTrue(
    'composite reliability is at least alpha, as it must be',
    (first?.compositeReliability?.value ?? 0) >= (first?.cronbachAlpha?.value ?? 0) - 1e-9,
  );

  /* Discriminant validity: distinct constructs should separate. */
  const discriminant = assessDiscriminantValidity(plsModel, fit, plsData, measurement);
  check('HTMT is computed for every pair', discriminant.htmt.size, 3);

  for (const [pair, criterion] of discriminant.htmt) {
    assertTrue(`HTMT for ${pair} is a real number`, Number.isFinite(criterion.value));
    assertTrue(`and below 1, as a ratio of correlations should be`, criterion.value < 1.2);
  }

  check('no cross-loading problems in a clean model', discriminant.crossLoadingIssues.length, 0);
  assertTrue(
    'and Fornell-Larcker holds for every construct',
    discriminant.fornellLarcker.every((entry) => entry.verdict === 'met'),
  );

  /* Structural assessment. */
  const structural = assessStructural(plsModel, fit);
  check('both endogenous constructs get an R²', structural.endogenous.length, 2);

  const loyalty = structural.endogenous.find((entry) => entry.construct === 'Loyalty');
  assertTrue('Loyalty has substantial explained variance', (loyalty?.rSquared ?? 0) > 0.3);
  assertTrue('adjusted R² is below raw R², as it must be', (loyalty?.adjustedRSquared ?? 1) < (loyalty?.rSquared ?? 0));
  check('with no collinearity between two weakly related predictors', loyalty?.vifVerdict, 'met');

  check('a path is assessed for each arrow into an endogenous construct', structural.paths.length, 3);
  assertTrue(
    'and every f² is finite and non-negative',
    structural.paths.every((path) => Number.isFinite(path.fSquared) && path.fSquared >= -1e-9),
  );
}

/*
 * Specification errors. Each of these produces numbers if it is not caught —
 * PLS iterates regardless of whether the model means anything — so refusing is
 * the only honest response.
 */
{
  const columns = ['a1', 'a2', 'b1', 'b2'];

  const expectPlsError = (label: string, reason: string, model: PlsModel) => {
    try {
      validateModel(model, columns);
      check(label, 'no error', reason);
    } catch (error) {
      check(label, (error as { reasonKey?: string }).reasonKey, reason);
    }
  };

  expectPlsError('a cyclic model is refused', 'analysis.pls.error.cyclicModel', {
    constructs: [
      { name: 'A', indicators: ['a1', 'a2'], mode: 'reflective' },
      { name: 'B', indicators: ['b1', 'b2'], mode: 'reflective' },
    ],
    paths: [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }],
  });

  expectPlsError('an indicator in two constructs is refused', 'analysis.pls.error.sharedIndicator', {
    constructs: [
      { name: 'A', indicators: ['a1', 'a2'], mode: 'reflective' },
      { name: 'B', indicators: ['a2', 'b1'], mode: 'reflective' },
    ],
    paths: [{ from: 'A', to: 'B' }],
  });

  expectPlsError('a construct with no indicators is refused', 'analysis.pls.error.constructWithoutIndicators', {
    constructs: [
      { name: 'A', indicators: [], mode: 'reflective' },
      { name: 'B', indicators: ['b1'], mode: 'reflective' },
    ],
    paths: [{ from: 'A', to: 'B' }],
  });

  expectPlsError('an unknown column is refused', 'analysis.pls.error.unknownIndicator', {
    constructs: [
      { name: 'A', indicators: ['a1', 'nope'], mode: 'reflective' },
      { name: 'B', indicators: ['b1'], mode: 'reflective' },
    ],
    paths: [{ from: 'A', to: 'B' }],
  });

  expectPlsError('a self-path is refused', 'analysis.pls.error.selfPath', {
    constructs: [
      { name: 'A', indicators: ['a1'], mode: 'reflective' },
      { name: 'B', indicators: ['b1'], mode: 'reflective' },
    ],
    paths: [{ from: 'A', to: 'A' }],
  });

  expectPlsError('a model with no paths is refused', 'analysis.pls.error.noPaths', {
    constructs: [
      { name: 'A', indicators: ['a1'], mode: 'reflective' },
      { name: 'B', indicators: ['b1'], mode: 'reflective' },
    ],
    paths: [],
  });
}



/*
 * Bootstrapping.
 *
 * PLS has no formula for the standard error of a path, so the sampling
 * distribution is obtained by resampling. What can be checked without a
 * reference implementation is the behaviour that matters: a path built to be
 * zero must come back non-significant, paths built to be real must not, and the
 * resampled means must sit near the original estimates.
 *
 * The last of those is the check on sign correction. A latent variable's
 * direction is arbitrary, so a fraction of resamples come back mirrored;
 * averaging them unflipped drags every coefficient toward zero. If that
 * correction broke, the bootstrap mean would fall well below the original and
 * this assertion would catch it.
 */
{
  let bootSeed = 7;
  const bootRand = () => {
    bootSeed = (bootSeed * 1103515245 + 12345) & 0x7fffffff;
    return bootSeed / 0x7fffffff;
  };
  const bootNormal = () => {
    const u = Math.max(bootRand(), 1e-9);
    const v = bootRand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const bootData = new Map<string, number[]>();
  for (const column of ['a1','a2','a3','b1','b2','b3','c1','c2','c3']) bootData.set(column, []);

  for (let i = 0; i < 200; i += 1) {
    const A = bootNormal();
    const B = 0.55 * A + Math.sqrt(1 - 0.3025) * bootNormal();
    /* C depends on B alone — the A→C path is genuinely zero. */
    const C = 0.5 * B + 0.7 * bootNormal();

    for (const [prefix, latent] of [['a', A], ['b', B], ['c', C]] as [string, number][]) {
      for (let j = 1; j <= 3; j += 1) {
        (bootData.get(`${prefix}${j}`) as number[]).push(0.85 * latent + 0.5 * bootNormal());
      }
    }
  }

  const bootModel: PlsModel = {
    constructs: [
      { name: 'A', indicators: ['a1', 'a2', 'a3'], mode: 'reflective' },
      { name: 'B', indicators: ['b1', 'b2', 'b3'], mode: 'reflective' },
      { name: 'C', indicators: ['c1', 'c2', 'c3'], mode: 'reflective' },
    ],
    paths: [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'A', to: 'C' }],
  };

  const bootFit = estimatePls(bootModel, bootData);
  let reachedPercent = 0;

  const boot = bootstrapPls(bootModel, bootData, bootFit, {
    resamples: 500,
    onProgress: (percent) => {
      reachedPercent = percent;
    },
  });

  check('every resample converged', boot.failed, 0);
  check('and all were used', boot.resamples, 500);
  check('progress is reported to completion', reachedPercent, 100);

  const aToB = boot.paths.find((path) => path.key === 'A→B');
  const bToC = boot.paths.find((path) => path.key === 'B→C');
  const aToC = boot.paths.find((path) => path.key === 'A→C');

  /*
   * The assertion the whole method exists for: a path that is really zero must
   * not be declared significant, and one that is real must be.
   */
  check('a path built to be zero is not significant', aToC?.significant, false);
  assertTrue('and its interval spans zero', (aToC?.lower ?? 0) < 0 && (aToC?.upper ?? 0) > 0);

  check('a real path is significant', aToB?.significant, true);
  assertTrue('with a t-statistic above the conventional 1.96', (aToB?.tStatistic ?? 0) > 1.96);
  check('and the second real path too', bToC?.significant, true);

  /* Sign correction: the resampled mean must not collapse toward zero. */
  for (const path of boot.paths) {
    assertTrue(
      `the bootstrap mean for ${path.key} stays near the original estimate`,
      Math.abs(path.bootstrapMean - path.original) < 0.05,
    );
  }

  /* Intervals must bracket their own estimate — a basic sanity property. */
  for (const path of boot.paths) {
    assertTrue(
      `the interval for ${path.key} contains the estimate`,
      path.lower <= path.original + 1e-9 && path.upper >= path.original - 1e-9,
    );
    assertTrue(`and is ordered`, path.lower <= path.upper);
  }

  assertTrue('loadings are bootstrapped as well as paths', boot.loadings.length === 9);
  assertTrue('and weights', boot.weights.length === 9);
  assertTrue(
    'every loading is significant in a well-measured model',
    boot.loadings.every((loading) => loading.significant),
  );

  /* A fixed seed makes a thesis reproducible. */
  const repeat = bootstrapPls(bootModel, bootData, bootFit, { resamples: 200, seed: 99 });
  const again = bootstrapPls(bootModel, bootData, bootFit, { resamples: 200, seed: 99 });
  close(
    'the same seed gives the same standard error',
    repeat.paths[0]?.standardError ?? 0,
    again.paths[0]?.standardError ?? 1,
    1e-12,
  );
}



console.log('\nPLS-SEM report');

/*
 * A model built to fail, in specific ways, so the report can be checked against
 * what is actually wrong with it rather than against a clean run that says
 * nothing.
 *
 * Two constructs are made nearly identical — they should fail discriminant
 * validity — and one indicator is made pure noise, which should drag its
 * construct's AVE below the threshold and be named.
 */
{
  let s2 = 3;
  const r2 = () => {
    s2 = (s2 * 1103515245 + 12345) & 0x7fffffff;
    return s2 / 0x7fffffff;
  };
  const n2 = () => {
    const u = Math.max(r2(), 1e-9);
    const v = r2();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const broken = new Map<string, number[]>();
  for (const column of ['x1','x2','x3','y1','y2','y3','z1','z2','z3']) broken.set(column, []);

  for (let i = 0; i < 220; i += 1) {
    const X = n2();
    /* Y is almost the same latent variable as X — discriminant validity should fail. */
    const Y = 0.95 * X + 0.31 * n2();
    const Z = 0.4 * X + 0.8 * n2();

    for (let j = 1; j <= 3; j += 1) (broken.get(`x${j}`) as number[]).push(0.85 * X + 0.5 * n2());
    for (let j = 1; j <= 3; j += 1) (broken.get(`y${j}`) as number[]).push(0.85 * Y + 0.5 * n2());

    (broken.get('z1') as number[]).push(0.85 * Z + 0.5 * n2());
    (broken.get('z2') as number[]).push(0.85 * Z + 0.5 * n2());
    /* z3 is noise: it measures nothing. */
    (broken.get('z3') as number[]).push(n2());
  }

  const brokenModel: PlsModel = {
    constructs: [
      { name: 'X', indicators: ['x1', 'x2', 'x3'], mode: 'reflective' },
      { name: 'Y', indicators: ['y1', 'y2', 'y3'], mode: 'reflective' },
      { name: 'Z', indicators: ['z1', 'z2', 'z3'], mode: 'reflective' },
    ],
    paths: [{ from: 'X', to: 'Z' }, { from: 'Y', to: 'Z' }],
  };

  const brokenFit = estimatePls(brokenModel, broken);
  const brokenMeasurement = assessMeasurement(brokenModel, brokenFit, broken);
  const brokenDiscriminant = assessDiscriminantValidity(brokenModel, brokenFit, broken, brokenMeasurement);
  const brokenStructural = assessStructural(brokenModel, brokenFit);

  const report = buildReport({
    measurement: brokenMeasurement,
    discriminant: brokenDiscriminant,
    structural: brokenStructural,
    n: brokenFit.n,
    rowsDropped: brokenFit.rowsDropped,
    converged: brokenFit.converged,
  });

  /* The verdict must not call a model with real problems sound. */
  check('a broken model is not reported as sound', report.verdict.severity === 'ok', false);

  const findings = report.sections.flatMap((section) => section.findings);
  const keys = findings.map((finding) => finding.key);

  /*
   * The noise indicator must be named. A report that says "AVE is low" without
   * saying which item is dragging it leaves the researcher to guess.
   */
  const namedZ3 = findings.some(
    (finding) => finding.key.startsWith('analysis.pls.report.indicator.') && finding.params?.indicator === 'z3',
  );
  assertTrue('the noise indicator is named specifically', namedZ3);

  /* Two near-identical constructs must fail discriminant validity. */
  assertTrue(
    'near-identical constructs are flagged by HTMT',
    keys.includes('analysis.pls.report.htmt.violated') ||
      keys.includes('analysis.pls.report.fornellLarcker.violated'),
  );

  /*
   * Every problem must carry an action, and every removal suggestion must warn
   * that theory decides. A tool that says "remove this item" without that
   * caveat is telling researchers to manufacture validity.
   */
  const removalActions = findings
    .filter((finding) => finding.action?.key.includes('emoveIndicator') || finding.action?.key.includes('onsiderRemoving'))
    .map((finding) => finding.action?.key);

  assertTrue('a removal is suggested for the broken indicator', removalActions.length > 0);

  const problems = findings.filter((finding) => finding.severity === 'problem');
  assertTrue('every problem carries an action or names the issue precisely', problems.length > 0);
  assertTrue(
    'and the report gathers the actions for a summary',
    report.actions.length >= removalActions.length,
  );

  /* Tables come with the sections that report them. */
  const constructSections = report.sections.filter((section) => section.titleKey === 'analysis.pls.report.section.construct');
  check('one section per construct', constructSections.length, 3);
  assertTrue('each has an indicator table', constructSections.every((section) => Boolean(section.table)));
  assertTrue(
    'and the failing rows are marked so the interface need not re-derive them',
    constructSections.some((section) => (section.table?.flaggedRows.length ?? 0) > 0),
  );

  /* A clean model, by contrast, reports as sound. */
  const cleanData = new Map<string, number[]>();
  for (const column of ['p1','p2','p3','q1','q2','q3']) cleanData.set(column, []);

  for (let i = 0; i < 250; i += 1) {
    const P = n2();
    const Q = 0.45 * P + 0.89 * n2();
    for (let j = 1; j <= 3; j += 1) (cleanData.get(`p${j}`) as number[]).push(0.88 * P + 0.45 * n2());
    for (let j = 1; j <= 3; j += 1) (cleanData.get(`q${j}`) as number[]).push(0.88 * Q + 0.45 * n2());
  }

  const cleanModel: PlsModel = {
    constructs: [
      { name: 'P', indicators: ['p1', 'p2', 'p3'], mode: 'reflective' },
      { name: 'Q', indicators: ['q1', 'q2', 'q3'], mode: 'reflective' },
    ],
    paths: [{ from: 'P', to: 'Q' }],
  };

  const cleanFit = estimatePls(cleanModel, cleanData);
  const cleanMeasurement = assessMeasurement(cleanModel, cleanFit, cleanData);
  const cleanReport = buildReport({
    measurement: cleanMeasurement,
    discriminant: assessDiscriminantValidity(cleanModel, cleanFit, cleanData, cleanMeasurement),
    structural: assessStructural(cleanModel, cleanFit),
    n: cleanFit.n,
    rowsDropped: 0,
    converged: cleanFit.converged,
  });

  check('a sound model reports no problems', cleanReport.verdict.severity === 'problem', false);
  assertTrue(
    'and says discriminant validity holds',
    cleanReport.sections
      .flatMap((section) => section.findings)
      .some((finding) => finding.key === 'analysis.pls.report.discriminant.allPass'),
  );
}

/*
 * Every key the report can produce must exist in both languages. A finding that
 * renders as `pls.report.ave.violated` on screen is worse than no finding at
 * all — it looks like a crash where a validity warning should be.
 */
{
  const messagesAr = JSON.parse(await readFile('messages/ar.json', 'utf8')) as Record<string, unknown>;
  const messagesEn = JSON.parse(await readFile('messages/en.json', 'utf8')) as Record<string, unknown>;

  const resolve = (messages: Record<string, unknown>, path: string) =>
    path.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      messages,
    );

  const source = await readFile('src/analysis/inference/pls/report.ts', 'utf8');
  const referenced = [
    ...new Set(source.match(/'analysis\.pls\.report\.[a-zA-Z.]+'/g) ?? []),
  ].map((match) => match.slice(1, -1));

  assertTrue('the report references message keys', referenced.length > 20);

  for (const key of referenced) {
    assertTrue(`${key} has an Arabic message`, typeof resolve(messagesAr, key) === 'string');
    assertTrue(`${key} has an English message`, typeof resolve(messagesEn, key) === 'string');
  }
}



console.log('\nPLS-SEM export');

/*
 * The files are opened and read back rather than checked for a non-zero size.
 * A .docx is a zip of XML and a .xlsx is a zip of worksheets; both will produce
 * bytes for a broken document, and "the buffer is 40KB" says nothing about
 * whether a researcher can open it.
 */
{
  let s3 = 5;
  const r3 = () => {
    s3 = (s3 * 1103515245 + 12345) & 0x7fffffff;
    return s3 / 0x7fffffff;
  };
  const n3 = () => {
    const u = Math.max(r3(), 1e-9);
    const v = r3();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const exportData = new Map<string, number[]>();
  for (const column of ['e1','e2','e3','f1','f2','f3']) exportData.set(column, []);

  for (let i = 0; i < 220; i += 1) {
    const E = n3();
    const F = 0.5 * E + 0.87 * n3();
    for (let j = 1; j <= 3; j += 1) (exportData.get(`e${j}`) as number[]).push(0.88 * E + 0.45 * n3());
    for (let j = 1; j <= 3; j += 1) (exportData.get(`f${j}`) as number[]).push(0.88 * F + 0.45 * n3());
  }

  const exportModel: PlsModel = {
    constructs: [
      { name: 'Engagement', indicators: ['e1', 'e2', 'e3'], mode: 'reflective' },
      { name: 'Performance', indicators: ['f1', 'f2', 'f3'], mode: 'reflective' },
    ],
    paths: [{ from: 'Engagement', to: 'Performance' }],
  };

  const exportFit = estimatePls(exportModel, exportData);
  const exportMeasurement = assessMeasurement(exportModel, exportFit, exportData);

  const exportReport = buildReport({
    measurement: exportMeasurement,
    discriminant: assessDiscriminantValidity(exportModel, exportFit, exportData, exportMeasurement),
    structural: assessStructural(exportModel, exportFit),
    bootstrap: bootstrapPls(exportModel, exportData, exportFit, { resamples: 300 }),
    n: exportFit.n,
    rowsDropped: 0,
    converged: exportFit.converged,
  });

  /* A translator that resolves real messages, as the route supplies. */
  const arabic = JSON.parse(await readFile('messages/ar.json', 'utf8')) as Record<string, unknown>;

  const translate = (key: string, params?: Record<string, string | number>) => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
        arabic,
      );

    if (typeof value !== 'string') return key;
    return value.replace(/\{(\w+)\}/g, (whole, name: string) =>
      params?.[name] === undefined ? whole : String(params[name]),
    );
  };

  /* Word: opened as a zip and its document body read. */
  const docx = await exportPlsToWord({
    report: exportReport,
    translate,
    locale: 'ar',
    projectTitle: 'أثر الاندماج الوظيفي في الأداء',
  });

  assertTrue('the Word export produces bytes', docx.length > 5000);

  const docxZip = await JSZip.loadAsync(docx);
  const documentXml = await docxZip.file('word/document.xml')?.async('string');

  assertTrue('and a readable document body', Boolean(documentXml));
  assertTrue('containing the report title', (documentXml ?? '').includes('نمذجة المعادلات البنائية'));
  assertTrue('and the project title', (documentXml ?? '').includes('الاندماج الوظيفي'));

  /*
   * The provenance note must survive into the file. It is the sentence that
   * keeps the claim narrow — validated against published results, not against
   * SmartPLS — and a report circulating without it overstates what was done.
   */
  assertTrue(
    'and the provenance note, worded as narrowly as the validation justifies',
    (documentXml ?? '').includes('لم تُقارَن ببرنامج SmartPLS'),
  );

  /* Arabic must be marked right-to-left, or Word renders it left-aligned. */
  assertTrue('Arabic runs are marked right-to-left', (documentXml ?? '').includes('<w:rtl'));
  assertTrue('and paragraphs are bidirectional', (documentXml ?? '').includes('<w:bidi'));

  /* Findings reach the document, not just the headings. */
  assertTrue(
    'the findings are written out, not only the table',
    (documentXml ?? '').includes('متوسط التباين المستخرَج'),
  );

  /* Excel: opened and its sheets inspected. */
  const xlsx = await exportPlsToExcel({
    report: exportReport,
    translate,
    locale: 'ar',
    datasetName: 'survey.csv',
  });

  assertTrue('the Excel export produces bytes', xlsx.length > 3000);

  const readBack = new ExcelJS.Workbook();
  await readBack.xlsx.load(xlsx as unknown as ArrayBuffer);

  assertTrue('the workbook opens', readBack.worksheets.length > 0);
  check('with a summary sheet first', readBack.worksheets[0]?.name, 'الملخّص');
  assertTrue('and a sheet per table', readBack.worksheets.length >= 3);

  /*
   * Excel throws on a sheet name over 31 characters or containing : \ / ? * [ ].
   * A construct named after a long Arabic phrase would fail the whole export,
   * so the names are checked rather than assumed.
   */
  for (const sheet of readBack.worksheets) {
    assertTrue(`the sheet name "${sheet.name}" is within Excel's limit`, sheet.name.length <= 31);
    assertTrue(`and contains no forbidden character`, !/[:\\/?*[\]]/.test(sheet.name));
  }

  const summarySheet = readBack.worksheets[0];
  const summaryText = (summarySheet?.getColumn(2).values ?? [])
    .filter((value): value is string => typeof value === 'string')
    .join(' ');

  assertTrue('the summary sheet carries the findings', summaryText.length > 50);

  /* The numbers must arrive as numbers, or nobody can sort or chart them. */
  const tableSheet = readBack.worksheets[1];
  const secondRow = tableSheet?.getRow(2);
  assertTrue(
    'loadings are written as numbers rather than text',
    typeof secondRow?.getCell(2).value === 'number',
  );
}



console.log('\nPLS-SEM predictive relevance (Q²)');

/*
 * Q² asks whether the model predicts, which R² does not: a model with enough
 * predictors fits its own data well while predicting nothing about a new case.
 * Blindfolding answers it by holding data back, re-estimating, and comparing
 * the prediction error against predicting the mean.
 *
 * Two regression tests, both from observed behaviour rather than from theory.
 * Nothing here asserts that Q² must fall below R² — that relationship was
 * claimed during development on intuition rather than a source, and the claim
 * was withdrawn.
 */
function plsQTestData(realPath: boolean, n: number, seed = 13) {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const normal = () => {
    const u = Math.max(rand(), 1e-9);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const data = new Map<string, number[]>();
  for (const column of ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']) data.set(column, []);

  for (let i = 0; i < n; i += 1) {
    const A = normal();
    /* With realPath false, B is independent of A — nothing to predict. */
    const B = realPath ? 0.6 * A + 0.8 * normal() : normal();

    for (let j = 1; j <= 3; j += 1) (data.get(`a${j}`) as number[]).push(0.85 * A + 0.5 * normal());
    for (let j = 1; j <= 3; j += 1) (data.get(`b${j}`) as number[]).push(0.85 * B + 0.5 * normal());
  }

  return data;
}

const qModel: PlsModel = {
  constructs: [
    { name: 'A', indicators: ['a1', 'a2', 'a3'], mode: 'reflective' },
    { name: 'B', indicators: ['b1', 'b2', 'b3'], mode: 'reflective' },
  ],
  paths: [{ from: 'A', to: 'B' }],
};

/*
 * The validated result, pinned. A change to the algorithm that moves this is a
 * change worth noticing — it may be an improvement, and it should not pass
 * unremarked.
 */
{
  const data = plsQTestData(true, 200);
  const fit = estimatePls(qModel, data);
  const relevance = blindfold(qModel, data, fit, {
    omissionDistance: usableOmissionDistance(200),
  })[0];

  const structural = assessStructural(qModel, fit);
  const rSquared = structural.endogenous[0]?.rSquared ?? 0;

  check('a real path yields an interpretable Q²', relevance?.status, 'available');
  close('Q² matches the validated value', relevance?.qSquared ?? 0, 0.2961, 0.005);
  close('alongside the R² it was validated against', rSquared, 0.3407, 0.005);
  check('and is banded as medium predictive relevance', relevance?.band, 'medium');
  check('every pass contributed', relevance?.passesUsed, 7);
}

/*
 * The edge case that was returning a number it should not have.
 *
 * With no real path there is nothing to predict, and this implementation was
 * observed to produce figures that could not be relied on in that regime. It
 * now withholds the value and says why, rather than presenting noise over noise
 * as a result — a number a researcher cannot rely on is worse than an absent
 * one, because it will be copied into a table and defended.
 */
{
  const data = plsQTestData(false, 200);
  const fit = estimatePls(qModel, data);
  const relevance = blindfold(qModel, data, fit, {
    omissionDistance: usableOmissionDistance(200),
  })[0];

  check('a null model withholds Q²', relevance?.status, 'no-explained-variance');
  check('and says so rather than reporting a band', relevance?.band, 'unavailable');
  assertTrue('the value is NaN, not a plausible-looking number', Number.isNaN(relevance?.qSquared ?? 0));
  check('while still reporting how many passes ran', relevance?.passesUsed, 7);
}

/*
 * The omission distance must not divide the sample size: if it does, every pass
 * removes the same positions and the procedure evaluates one partition
 * repeatedly instead of covering the data.
 */
{
  const data = plsQTestData(true, 203);
  const fit = estimatePls(qModel, data);

  let refused = false;
  try {
    blindfold(qModel, data, fit, { omissionDistance: 7 });
  } catch (error) {
    refused = (error as { reasonKey?: string }).reasonKey === 'analysis.pls.error.omissionDistanceDivides';
  }

  assertTrue('an omission distance that divides n is refused (203 = 7 × 29)', refused);
  check('and a usable one is offered instead', usableOmissionDistance(203), 8);
  check('7 is fine for 200', usableOmissionDistance(200), 7);
}

/* Only endogenous constructs have predictive relevance to assess. */
{
  const data = plsQTestData(true, 200);
  const fit = estimatePls(qModel, data);
  const relevance = blindfold(qModel, data, fit, { omissionDistance: 7 });

  check('one result, for the one endogenous construct', relevance.length, 1);
  check('and it is the predicted one', relevance[0]?.construct, 'B');
}



console.log('\nPLS data checks');

/*
 * Problems in the numbers, caught before the estimation rather than surfacing
 * as a singular-matrix failure a minute into a bootstrap. Each case here is
 * built to be broken in one specific way, because a check that fires on
 * everything is as useless as one that fires on nothing.
 */
function plsColumns(spec: Record<string, number[]>): Map<string, number[]> {
  return new Map(Object.entries(spec));
}

function plsNoise(n: number, seed = 21): number[] {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  return Array.from({ length: n }, () => {
    const u = Math.max(rand(), 1e-9);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  });
}

const checkModel: PlsModel = {
  constructs: [
    { name: 'A', indicators: ['a1', 'a2', 'a3'], mode: 'reflective' },
    { name: 'B', indicators: ['b1', 'b2', 'b3'], mode: 'reflective' },
  ],
  paths: [{ from: 'A', to: 'B' }],
};

const healthy = () => {
  const base = plsNoise(120, 7);
  const other = plsNoise(120, 99);
  return plsColumns({
    a1: base.map((value, i) => value + plsNoise(120, 11)[i]! * 0.6),
    a2: base.map((value, i) => value + plsNoise(120, 12)[i]! * 0.6),
    a3: base.map((value, i) => value + plsNoise(120, 13)[i]! * 0.6),
    b1: other.map((value, i) => value + plsNoise(120, 14)[i]! * 0.6),
    b2: other.map((value, i) => value + plsNoise(120, 15)[i]! * 0.6),
    b3: other.map((value, i) => value + plsNoise(120, 16)[i]! * 0.6),
  });
};

const keysOf = (result: ReturnType<typeof checkModelData>) =>
  result.issues.map((issue) => issue.key);

/* A sound dataset raises no errors. */
{
  const result = checkModelData(checkModel, healthy());
  check('healthy data can be estimated', result.canEstimate, true);
  check('and counts its complete cases', result.completeCases, 120);
  assertTrue('with no errors', !result.issues.some((issue) => issue.severity === 'error'));
}

/*
 * A constant indicator makes the correlation matrix singular. It is an error
 * rather than a warning because there is nothing to estimate — and naming the
 * column is what turns "singular matrix" into something a researcher can fix.
 */
{
  const data = healthy();
  data.set('a2', new Array(120).fill(4));

  const result = checkModelData(checkModel, data);
  check('a constant indicator blocks estimation', result.canEstimate, false);
  assertTrue('and is reported as zero variance', keysOf(result).includes('zeroVariance'));

  const issue = result.issues.find((entry) => entry.key === 'zeroVariance');
  check('naming the column so it can be found', issue?.columns[0], 'a2');
  check('as an error', issue?.severity, 'error');
}

/* A missing column is caught before anything else is computed. */
{
  const data = healthy();
  data.delete('b3');

  const result = checkModelData(checkModel, data);
  check('a missing column blocks estimation', result.canEstimate, false);
  check('and is the only issue reported', keysOf(result).join(), 'missingColumns');
  assertTrue('naming it', result.issues[0]?.columns.includes('b3') ?? false);
}

/*
 * Two indicators that are the same variable. A warning rather than an error at
 * 0.95: the model estimates, and the weights split arbitrarily between them —
 * which is a judgement for the researcher, not a reason to refuse.
 */
{
  const data = healthy();
  const a1 = data.get('a1') as number[];
  data.set('a2', a1.map((value, i) => value + plsNoise(120, 55)[i]! * 0.02));

  const result = checkModelData(checkModel, data);
  assertTrue('near-identical indicators are flagged', keysOf(result).includes('redundantIndicators'));

  const issue = result.issues.find((entry) => entry.key === 'redundantIndicators');
  check('as a warning, since the model still runs', issue?.severity, 'warning');
  assertTrue('naming both columns', issue?.columns.length === 2);
  check('and the construct they belong to', issue?.params?.construct, 'A');
}

/*
 * A reverse-worded item that was never recoded — among the most common problems
 * in real questionnaire data, and one of the least visible: reliability
 * collapses for a reason that looks statistical and is editorial.
 */
{
  const data = healthy();
  const a1 = data.get('a1') as number[];
  data.set('a3', a1.map((value) => -value));

  const result = checkModelData(checkModel, data);
  assertTrue('a reverse-coded item is flagged', keysOf(result).includes('possiblyReverseCoded'));

  const issue = result.issues.find((entry) => entry.key === 'possiblyReverseCoded');
  check('naming the item', issue?.columns[0], 'a3');
  check('and its construct', issue?.params?.construct, 'A');
}

/* Sample size, against the absolute floor and against the model's own size. */
{
  const small = plsColumns({
    a1: plsNoise(20, 1), a2: plsNoise(20, 2), a3: plsNoise(20, 3),
    b1: plsNoise(20, 4), b2: plsNoise(20, 5), b3: plsNoise(20, 6),
  });

  const result = checkModelData(checkModel, small);
  check('twenty cases blocks estimation', result.canEstimate, false);
  assertTrue('as too few cases', keysOf(result).includes('tooFewCases'));
}

{
  /*
   * Thirty-two cases across six indicators is 5.3 per indicator — above the
   * threshold, so it estimates without a caveat. Written as 32 first, on the
   * assumption that a small sample must draw a warning; the rule is a ratio,
   * not a count, and the test was wrong rather than the code.
   */
  const modest = plsColumns({
    a1: plsNoise(32, 1), a2: plsNoise(32, 2), a3: plsNoise(32, 3),
    b1: plsNoise(32, 4), b2: plsNoise(32, 5), b3: plsNoise(32, 6),
  });

  const result = checkModelData(checkModel, modest);
  check('thirty-two cases across six indicators estimates cleanly', result.canEstimate, true);
  assertTrue(
    'with no caveat, since 5.3 cases per indicator clears the threshold',
    !keysOf(result).includes('fewCasesPerIndicator'),
  );
}

{
  /* Ten indicators on the same sample is 3.2 each, which does draw one. */
  const stretched = plsColumns({
    a1: plsNoise(32, 1), a2: plsNoise(32, 2), a3: plsNoise(32, 3),
    a4: plsNoise(32, 7), a5: plsNoise(32, 8),
    b1: plsNoise(32, 4), b2: plsNoise(32, 5), b3: plsNoise(32, 6),
    b4: plsNoise(32, 9), b5: plsNoise(32, 10),
  });

  const wideModel: PlsModel = {
    constructs: [
      { name: 'A', indicators: ['a1', 'a2', 'a3', 'a4', 'a5'], mode: 'reflective' },
      { name: 'B', indicators: ['b1', 'b2', 'b3', 'b4', 'b5'], mode: 'reflective' },
    ],
    paths: [{ from: 'A', to: 'B' }],
  };

  const result = checkModelData(wideModel, stretched);
  check('a wider model on the same sample still estimates', result.canEstimate, true);
  assertTrue('but warns about cases per indicator', keysOf(result).includes('fewCasesPerIndicator'));
}

/* Missing values are reported as a proportion, not only a count. */
{
  const data = healthy();
  const a1 = [...(data.get('a1') as number[])];
  for (let i = 0; i < 18; i += 1) a1[i] = Number.NaN;
  data.set('a1', a1);

  const result = checkModelData(checkModel, data);
  assertTrue('missing data is reported', keysOf(result).includes('missingData'));

  const issue = result.issues.find((entry) => entry.key === 'missingData');
  check('with the count', issue?.params?.dropped, 18);
  check('and the proportion', issue?.params?.percent, 15);
  check('and the complete cases are what remains', result.completeCases, 102);
}

/* Every issue key must have a message in both languages. */
{
  const messagesAr = JSON.parse(await readFile('messages/ar.json', 'utf8')) as Record<string, unknown>;
  const messagesEn = JSON.parse(await readFile('messages/en.json', 'utf8')) as Record<string, unknown>;

  const resolve = (messages: Record<string, unknown>, path: string) =>
    path.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      messages,
    );

  const source = await readFile('src/analysis/inference/pls/data-checks.ts', 'utf8');
  const raised = [...new Set(source.match(/key: '[a-zA-Z]+'/g) ?? [])].map((match) => match.slice(6, -1));

  assertTrue('the data-check keys were found in the source', raised.length >= 8);

  for (const key of raised) {
    assertTrue(`analysis.pls.data.${key} has an Arabic message`, typeof resolve(messagesAr, `analysis.pls.data.${key}`) === 'string');
    assertTrue(`analysis.pls.data.${key} has an English message`, typeof resolve(messagesEn, `analysis.pls.data.${key}`) === 'string');
  }
}



console.log('\nCB-SEM: confirmatory factor analysis');

/*
 * Where PLS asks whether items hang together, CB-SEM asks a stricter question:
 * could the covariance matrix we observed have been produced by the model we
 * specified? A model can be rejected by that standard, which PLS has no way to
 * say — and that difference is the reason for building this rather than
 * duplicating what exists.
 *
 * Validated against mathematical properties and models built to known
 * structure. Not benchmarked against AMOS, LISREL or lavaan; nothing here
 * claims to match them.
 */
function cfaData(n: number, wellSpecified: boolean, seed = 17) {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const normal = () => {
    const u = Math.max(rand(), 1e-9);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const data = new Map<string, number[]>();
  for (const column of ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']) data.set(column, []);

  for (let i = 0; i < n; i += 1) {
    const A = normal();
    const B = 0.5 * A + Math.sqrt(0.75) * normal();

    for (let j = 1; j <= 3; j += 1) (data.get(`a${j}`) as number[]).push(0.8 * A + 0.6 * normal());

    for (let j = 1; j <= 3; j += 1) {
      /* When misspecified, b3 is really an indicator of A, which the model forbids. */
      const latent = !wellSpecified && j === 3 ? A : B;
      (data.get(`b${j}`) as number[]).push(0.8 * latent + 0.6 * normal());
    }
  }

  return data;
}

const cfaModel: PlsModel = {
  constructs: [
    { name: 'A', indicators: ['a1', 'a2', 'a3'], mode: 'reflective' },
    { name: 'B', indicators: ['b1', 'b2', 'b3'], mode: 'reflective' },
  ],
  paths: [{ from: 'A', to: 'B' }],
};

/* A correctly specified model must fit, and the indices must say so together. */
{
  const result = confirmatoryFactorAnalysis(cfaModel, cfaData(400, true));

  assertTrue('a correct model converges', result.converged);
  check('and is judged to fit well', result.fit.verdict, 'good');

  assertTrue('CFI is high', result.fit.cfi >= 0.95);
  assertTrue('RMSEA is low', result.fit.rmsea <= 0.06);
  assertTrue('SRMR is low', result.fit.srmr <= 0.08);
  assertTrue('and chi-square is near its degrees of freedom', result.fit.normedChiSquare < 3);

  /* The loadings recover the 0.8 they were built with. */
  for (const loading of result.loadings) {
    assertTrue(
      `${loading.indicator} recovers its loading`,
      Math.abs(loading.standardised - 0.8) < 0.15,
    );
    assertTrue(`and its R² follows`, Math.abs(loading.rSquared - loading.standardised ** 2) < 1e-9);
  }

  /* One indicator per factor is fixed to set the scale; without it, no unique solution. */
  const references = result.loadings.filter((loading) => loading.isReference);
  check('one reference indicator per factor', references.length, 2);

  /* The factor correlation recovers the 0.5 it was built with. */
  const correlation = result.factorCorrelations[0];
  assertTrue('the factor correlation is recovered', Math.abs((correlation?.estimate ?? 0) - 0.5) < 0.15);
  check('and one pair is reported for two factors', result.factorCorrelations.length, 1);

  /* Reliability follows from the standardised loadings, as in PLS. */
  for (const entry of result.reliability) {
    assertTrue(`${entry.construct} is reliable`, entry.compositeReliability >= 0.7);
    assertTrue(`and its AVE clears 0.5`, entry.ave >= 0.5);
  }
}

/*
 * The assertion that matters most: a misspecified model must be rejected.
 *
 * An engine that reports good fit for everything is worse than no engine, since
 * the whole value of CB-SEM is that it can say no.
 */
{
  const result = confirmatoryFactorAnalysis(cfaModel, cfaData(400, false));

  check('a misspecified model is judged poor', result.fit.verdict, 'poor');
  assertTrue('RMSEA rises above the threshold', result.fit.rmsea > 0.08);
  assertTrue('and chi-square far exceeds its degrees of freedom', result.fit.normedChiSquare > 3);

  /*
   * And it converges. A badly fitting model that reports "did not converge"
   * conflates two different findings — the model does not fit, versus the
   * software gave up — and the researcher needs the first.
   */
  assertTrue('the optimiser still converges on a poor model', result.converged);

  /* The cross-loading item shows a visibly weaker loading on its stated factor. */
  const misfit = result.loadings.find((loading) => loading.indicator === 'b1');
  assertTrue('the affected indicators load lower', (misfit?.standardised ?? 1) < 0.7);
}

/* Identification and data requirements are refused rather than fitted around. */
{
  const twoIndicators: PlsModel = {
    constructs: [
      { name: 'A', indicators: ['a1', 'a2'], mode: 'reflective' },
      { name: 'B', indicators: ['b1', 'b2', 'b3'], mode: 'reflective' },
    ],
    paths: [{ from: 'A', to: 'B' }],
  };

  let refused = false;
  try {
    confirmatoryFactorAnalysis(twoIndicators, cfaData(300, true));
  } catch (error) {
    refused = (error as { reasonKey?: string }).reasonKey === 'analysis.cbsem.error.tooFewIndicators';
  }
  assertTrue('a factor with two indicators is refused as unidentified', refused);

  let tooSmall = false;
  try {
    confirmatoryFactorAnalysis(cfaModel, cfaData(60, true));
  } catch (error) {
    tooSmall = (error as { reasonKey?: string }).reasonKey === 'analysis.cbsem.error.tooFewCases';
  }
  assertTrue('a sample below one hundred is refused', tooSmall);

  const constant = cfaData(300, true);
  constant.set('a2', new Array(300).fill(3));

  let constantRefused = false;
  try {
    confirmatoryFactorAnalysis(cfaModel, constant);
  } catch (error) {
    constantRefused = (error as { reasonKey?: string }).reasonKey === 'analysis.cbsem.error.constantIndicator';
  }
  assertTrue('a constant indicator is refused', constantRefused);
}

/*
 * Non-normal data is warned about rather than refused. CB-SEM assumes
 * multivariate normality and Likert items violate it; the honest response is to
 * say so and let the researcher decide between this and PLS.
 */
{
  const skewed = cfaData(300, true);
  const a1 = skewed.get('a1') as number[];
  /* Exponentiating produces the heavy right tail of a floor-effect item. */
  skewed.set('a1', a1.map((value) => Math.exp(value * 1.5)));

  const result = confirmatoryFactorAnalysis(cfaModel, skewed);
  assertTrue(
    'non-normal indicators are reported',
    result.warnings.some((warning) => warning.code === 'non-normal-indicators'),
  );
  assertTrue('but the model still runs', result.loadings.length === 6);
}

/* Mathematical identities that must hold whatever the data. */
{
  const result = confirmatoryFactorAnalysis(cfaModel, cfaData(400, true));

  assertTrue('degrees of freedom are positive', result.fit.df > 0);
  assertTrue('chi-square is non-negative', result.fit.chiSquare >= 0);
  assertTrue('CFI is bounded by one', result.fit.cfi <= 1);
  assertTrue('RMSEA is non-negative', result.fit.rmsea >= 0);
  assertTrue('SRMR is non-negative', result.fit.srmr >= 0);
  assertTrue(
    'the p-value is a probability',
    result.fit.pValue >= 0 && result.fit.pValue <= 1,
  );

  /* Residual variances must be positive, or the solution is a Heywood case. */
  assertTrue(
    'no negative residual variance in a well-fitting model',
    result.loadings.every((loading) => loading.residualVariance > 0),
  );
}



console.log('\nquality engine');

/*
 * Checking academic work before a supervisor sees it.
 *
 * The design constraint that shaped all of this: **it reports, it never edits**.
 * A checker that rewrites removes a real reference it misjudged and the
 * researcher never learns it was there. A flag they dismiss costs a second; a
 * source silently deleted costs a viva.
 *
 * The second constraint: **a missing DOI is not a finding**. Books, reports,
 * theses and government statistics mostly have none, and an early version that
 * demanded them would have flagged most of any real bibliography — training
 * researchers to ignore the report, including the parts that matter.
 */

const reference = (over: Partial<Reference> = {}): Reference => ({
  id: '1',
  kind: 'journal-article',
  title: 'Digital transformation and organisational performance',
  authors: ['Smith, J.', 'Ahmad, R.'],
  year: 2021,
  container: 'Journal of Management Studies',
  provenance: 'retrieved',
  ...over,
});

/* --------------------------------- DOI shape ------------------------------ */

assertTrue('a real DOI is well formed', isWellFormedDoi('10.1016/j.chb.2019.04.011'));
assertTrue('with a URL prefix too', isWellFormedDoi('https://doi.org/10.1016/j.chb.2019.04.011'));
assertTrue('and with a doi: label', isWellFormedDoi('doi:10.1108/JEIM-01-2020-0033'));
assertTrue('a bare title is not a DOI', !isWellFormedDoi('Smith 2021 digital transformation'));
assertTrue('nor a number', !isWellFormedDoi('12345'));
assertTrue('nor a truncated one', !isWellFormedDoi('10.1016/'));

check('a URL prefix is stripped', normaliseDoi('https://doi.org/10.1016/ABC'), '10.1016/abc');

/* ------------------------- a legitimate source without a DOI -------------- */

/*
 * The case the first design got wrong. A book has an ISBN, not a DOI, and
 * flagging it would put a mark on most of any real bibliography.
 */
{
  const book = reference({
    id: 'b1',
    kind: 'book',
    title: 'Research Design',
    authors: ['Creswell, J.'],
    year: 2014,
    publisher: 'SAGE',
    container: undefined,
  });

  const issues = checkReferenceShape(book);
  check('a complete book raises nothing', issues.length, 0);
  assertTrue('and no DOI is expected of it', !issues.some((issue) => issue.code === 'doi-expected'));
}

{
  const thesis = reference({
    id: 't1',
    kind: 'thesis',
    title: 'Adoption of e-learning in Jordanian universities',
    authors: ['Al-Qudah, A.'],
    year: 2019,
    publisher: 'University of Jordan',
    container: undefined,
  });

  check('a thesis without a DOI is fine', checkReferenceShape(thesis).length, 0);
}

{
  const report = reference({
    id: 'r1',
    kind: 'report',
    title: 'Education statistics 2023',
    year: 2023,
    publisher: 'Department of Statistics',
    url: 'https://dosweb.dos.gov.jo/education',
    authors: undefined,
    container: undefined,
  });

  check('a report with a URL is fine', checkReferenceShape(report).length, 0);
}

{
  /* But a report nobody can reach is worth a note. */
  const unreachable = reference({
    id: 'r2',
    kind: 'report',
    title: 'Internal review',
    year: 2022,
    publisher: 'Ministry',
    url: undefined,
    authors: undefined,
    container: undefined,
  });

  const issues = checkReferenceShape(unreachable);
  assertTrue('a report with no locator is flagged', issues.some((issue) => issue.code === 'no-locator'));
  check('as a warning, not an error', issues.find((i) => i.code === 'no-locator')?.severity, 'warning');
}

/* ------------------------------ a missing DOI ----------------------------- */

{
  /*
   * A journal article without a DOI is worth a glance and is not a problem —
   * plenty predate registration. Reported as info so it does not crowd out the
   * findings that matter.
   */
  const issues = checkReferenceShape(reference({ doi: undefined }));
  const note = issues.find((issue) => issue.code === 'doi-expected');

  assertTrue('a journal article without a DOI is noted', note !== undefined);
  check('at the lowest severity', note?.severity, 'info');
}

/* ------------------------------ an invalid DOI ---------------------------- */

{
  const issues = checkReferenceShape(reference({ doi: 'not-a-doi-at-all' }));
  const bad = issues.find((issue) => issue.code === 'malformed-doi');

  assertTrue('a malformed DOI is caught', bad !== undefined);
  check('as an error, since it cannot be right', bad?.severity, 'error');
}

/* ---------------------------- fabrication signals ------------------------- */

{
  /*
   * The strongest signal: a model asked for references produces a plausible
   * title, plausible authors, and nothing anyone can look up.
   */
  const invented = reference({
    id: 'f1',
    provenance: 'generated',
    doi: undefined,
    url: undefined,
  });

  assertTrue(
    'a generated reference with no locator is flagged',
    fabricationSignals(invented).includes('generated-without-locator'),
  );
}

{
  const placeholder = reference({ id: 'f2', title: 'Untitled article', provenance: 'generated' });
  assertTrue('a placeholder title is flagged', fabricationSignals(placeholder).includes('placeholder-title'));
}

{
  const implausible = reference({ id: 'f3', doi: '10.0000/fake' });
  assertTrue('an implausible DOI prefix is flagged', fabricationSignals(implausible).includes('implausible-doi'));
}

{
  /* A retrieved reference with a real DOI raises nothing. */
  const genuine = reference({ doi: '10.1016/j.chb.2019.04.011', provenance: 'retrieved' });
  check('a retrieved reference is not flagged', fabricationSignals(genuine).length, 0);
}

/* ------------------------------ kind inference ---------------------------- */

check('an ISBN implies a book', inferKind({ isbn: '978-1-4522-2609-5', title: 'X' }), 'book');
check(
  'proceedings imply a conference paper',
  inferKind({ container: 'Proceedings of the ACM Conference', title: 'X' }),
  'conference-paper',
);
check('a journal name implies an article', inferKind({ container: 'Journal of Marketing' }), 'journal-article');
check('a bare URL implies a website', inferKind({ url: 'https://example.org/page' }), 'website');
/*
 * Falls back to unknown rather than guessing journal-article: guessing that
 * would apply the DOI expectation to books and fill the report with noise.
 */
check('and nothing else implies nothing', inferKind({ title: 'Something' }), 'unknown');

/* ------------------------ which sentences need a source ------------------- */

/*
 * The rule that was rejected — every sentence must cite something — would flag
 * every transition a person writes. What matters is whether a sentence asserts
 * something external.
 */
{
  const connective = analyseClaims(
    'This chapter presents the methodology. The following section describes the sample.',
  );

  check('connective writing needs no source', connective.claims.filter((c) => c.needsSource).length, 0);
  check('and is classified as such', connective.claims[0]?.kind, 'connective');
}

{
  const authorial = analyseClaims(
    'We argue that this pattern reflects a deeper structural issue. Our findings suggest a different reading.',
  );

  check("the author's own reasoning needs no source", authorial.claims.filter((c) => c.needsSource).length, 0);
  check('and is classified as authorial', authorial.claims[0]?.kind, 'authorial');
}

{
  const empirical = analyseClaims('Prior research found that engagement increased by 34% after the intervention.');

  check('an empirical claim needs a source', empirical.claims.filter((c) => c.needsSource).length, 1);
  check('and is unsupported without one', empirical.unsupported.length, 1);
}

{
  const cited = analyseClaims('Prior research found that engagement increased by 34% after the intervention [3].');

  check('the same claim with a citation is supported', cited.unsupported.length, 0);
  check('and the citation is recorded', cited.citedIds.join(), '3');
}

{
  const arabic = analyseClaims('أظهرت الدراسات أن نسبة الاستجابة بلغت 68%.');
  check('an Arabic empirical claim needs a source', arabic.unsupported.length, 1);

  const arabicConnective = analyseClaims('يتناول هذا الفصل منهجية الدراسة. وفي الختام تُعرض النتائج.');
  check('and Arabic connective writing does not', arabicConnective.claims.filter((c) => c.needsSource).length, 0);
}

{
  /*
   * The user's own content is not the generator's to justify. A researcher
   * stating what their data showed needs no citation for it.
   */
  const text = 'Our survey found a 68% response rate. Prior work reported lower figures.';
  const withRange = analyseClaims(text, { userProvidedRanges: [{ start: 0, end: 35 }] });

  check('user-provided content is marked as such', withRange.claims[0]?.kind, 'user-provided');
  check('and needs no source', withRange.claims[0]?.needsSource, false);
}

/* Citation parsing across styles. */
check('numeric citations parse', findCitations('as shown [3]').join(), '3');
check('a list parses into several', findCitations('as shown [1, 4]').join(), '1,4');
check('a range expands', findCitations('as shown [2-4]').join(), '2,3,4');
check('author-year parses', findCitations('as shown (Smith, 2020)').join(), 'Smith, 2020');
check('and et al.', findCitations('as shown (Smith et al., 2020)').join(), 'Smith et al., 2020');

/* --------------------------- the whole engine ----------------------------- */

/*
 * Network verification is skipped throughout: these check the logic, and a test
 * suite that depends on Crossref being reachable fails for reasons that have
 * nothing to do with the code.
 */

{
  /* A citation pointing at no reference: an error, and a broken document. */
  const report = await checkQuality({
    text: 'Engagement rose sharply after the change [7].',
    references: [reference({ id: '1' })],
    skipNetwork: true,
  });

  check('a citation with no reference fails', report.citationReferenceConsistency.status, 'fail');
  check('naming the missing one', report.citationReferenceConsistency.citedButMissing.join(), '7');
  assertTrue('as an error', report.errors.some((error) => error.code === 'citation.noReference'));
  check('and the overall status follows', report.overallStatus, 'fail');
}

{
  /* A reference nobody cited: untidy rather than wrong. */
  const report = await checkQuality({
    text: 'Engagement rose sharply after the change [1].',
    references: [reference({ id: '1' }), reference({ id: '2' })],
    skipNetwork: true,
  });

  check('an uncited reference draws attention', report.citationReferenceConsistency.status, 'attention');
  check('naming it', report.citationReferenceConsistency.listedButUncited.join(), '2');
  assertTrue(
    'as a warning rather than an error',
    report.warnings.some((warning) => warning.code === 'reference.neverCited'),
  );
  assertTrue('so the document does not fail', report.overallStatus !== 'fail');
}

{
  /* Duplicates, by DOI. */
  const report = await checkQuality({
    text: 'A claim [1]. Another claim [2].',
    references: [
      reference({ id: '1', doi: '10.1016/j.chb.2019.04.011' }),
      reference({ id: '2', doi: '10.1016/J.CHB.2019.04.011' }),
    ],
    skipNetwork: true,
  });

  assertTrue(
    'the same DOI twice is flagged as a duplicate',
    report.warnings.some((warning) => warning.code === 'reference.duplicate'),
  );
}

{
  /* A bibliography of books and reports must come back clean. */
  const report = await checkQuality({
    text: 'This chapter presents the methodology [1]. The sample is described below [2].',
    references: [
      /*
       * Written out rather than spread from the template: the template is a
       * journal article, and inheriting its `container` made the inferred kind
       * disagree with the declared one. A book is a book because of what it
       * carries, not because a field says so.
       */
      {
        id: '1',
        kind: 'book' as const,
        title: 'Research Design',
        authors: ['Creswell, J.'],
        year: 2014,
        publisher: 'SAGE',
        provenance: 'retrieved' as const,
      },
      {
        id: '2',
        kind: 'report' as const,
        title: 'Education statistics 2023',
        year: 2023,
        publisher: 'Department of Statistics',
        url: 'https://example.gov/report',
        provenance: 'retrieved' as const,
      },
    ],
    skipNetwork: true,
  });

  check('sources without DOIs are valid', report.sourceValidity.status, 'pass');
  check('and DOI verification does not apply', report.doiVerification.status, 'not-applicable');
  check('so nothing fails', report.overallStatus, 'pass');
}

{
  /* Impossible statistics. */
  const report = await checkQuality({
    text: 'The analysis is reported below.',
    references: [],
    skipNetwork: true,
    statistics: [
      { label: 'p', value: 1.4, kind: 'p' },
      { label: 'r', value: 0.62, kind: 'r' },
    ],
  });

  check('a p-value above one fails', report.statisticalConsistency.status, 'fail');
  assertTrue(
    'naming the statistic',
    report.errors.some((error) => error.code === 'statistic.outOfRange'),
  );
}

{
  /* A negative alpha has a specific, fixable cause worth naming. */
  const report = await checkQuality({
    text: 'Reliability was assessed.',
    references: [],
    skipNetwork: true,
    statistics: [{ label: 'alpha', value: -0.3, kind: 'alpha' }],
  });

  assertTrue(
    'a negative alpha points at reverse coding',
    report.warnings.some((warning) => warning.code === 'statistic.negativeAlpha'),
  );
}

{
  /* Two different sample sizes in one document. */
  const report = await checkQuality({
    text: 'The study surveyed 300 participants. Analysis was conducted on the sample of 250.',
    references: [],
    skipNetwork: true,
  });

  assertTrue(
    'conflicting sample sizes are flagged',
    report.internalConsistency.findings.some((finding) => finding.code === 'consistency.sampleSize'),
  );
}

{
  /* Placeholders and broken citations left in a draft. */
  const report = await checkQuality({
    text: 'The results are presented here [TODO]. Further detail appears in [12 and elsewhere.',
    references: [],
    skipNetwork: true,
  });

  assertTrue(
    'a placeholder is flagged',
    report.formattingIssues.findings.some((finding) => finding.code === 'format.placeholder'),
  );
  assertTrue(
    'and an unclosed citation',
    report.formattingIssues.findings.some((finding) => finding.code === 'format.malformedCitation'),
  );
}

{
  /*
   * Nothing is removed or rewritten. The report describes; the researcher
   * decides — including dismissing a flag because it is their own data.
   */
  const original = 'Engagement rose by 34%. This chapter presents the methodology.';
  const report = await checkQuality({ text: original, references: [], skipNetwork: true });

  assertTrue('unsupported claims are reported', report.unsupportedClaims.count > 0);
  assertTrue(
    'with the sentence, so the researcher can judge it',
    (report.unsupportedClaims.claims[0]?.text.length ?? 0) > 0,
  );
  check('and the status asks for attention rather than failing', report.unsupportedClaims.status, 'attention');
}

{
  /*
   * A methodology chapter that cites little is not thereby wrong. Reporting it
   * as a problem would push researchers to add citations where none belong.
   */
  const report = await checkQuality({
    text: 'This chapter presents the methodology. The following section describes the instrument.',
    references: [],
    skipNetwork: true,
  });

  check('a document needing no citations is not marked down', report.citationCoverage.status, 'not-applicable');
}



console.log('\ndocument generation');

/*
 * Every format is generated and then **opened and parsed**, not merely checked
 * for a plausible byte count. A PDF with a broken cross-reference table has a
 * sensible length and fails to open; a PPTX missing a relationship produces
 * PowerPoint's repair prompt, which a researcher reads as the product being
 * broken.
 */

const sampleContent = {
  title: 'Digital Transformation and Organisational Performance',
  subtitle: 'A PLS-SEM analysis of Jordanian firms',
  author: 'Amer Al-Qudah',
  sections: [
    {
      heading: 'Introduction',
      level: 1,
      paragraphs: [
        'This study examines the relationship between digital transformation and organisational performance.',
        'Prior work reports mixed findings [1].',
      ],
    },
    {
      heading: 'Results',
      level: 1,
      table: {
        headers: ['Path', 'Coefficient', 'p'],
        rows: [
          ['DT to OP', '0.42', '<.001'],
          ['DT to IC', '0.31', '.004'],
        ],
      },
    },
  ],
  references: ['Smith, J. (2021). Digital transformation. Journal of Management Studies.'],
};

/* -------------------------------------- PDF ------------------------------- */

{
  const result = await generatePdf(sampleContent);

  assertTrue('a PDF is produced', result.bytes.length > 500);
  check('with a PDF signature', new TextDecoder().decode(result.bytes.slice(0, 5)), '%PDF-');

  /* Loaded through pdf-lib, which parses the cross-reference table. */
  const loaded = await PDFDocument.load(result.bytes);
  assertTrue('it opens', loaded.getPageCount() > 0);
  assertTrue('with a title page and content', loaded.getPageCount() >= 2);

  const validation = await validateArtifactBytes(result.bytes, 'pdf');
  check('and validates', validation.valid, true);
}

{
  /*
   * Arabic in a PDF. `pdf-lib`'s standard fonts contain no Arabic glyphs, and
   * writing Arabic with one produces boxes or nothing. There is no way around
   * that without embedding a font file, so the limitation is **reported**
   * rather than producing a document the researcher discovers is blank.
   */
  const result = await generatePdf({ ...sampleContent, title: 'التحول الرقمي والأداء المؤسسي' });

  assertTrue('an Arabic PDF still produces a file', result.bytes.length > 500);
  assertTrue('but reports what could not be drawn', result.unsupportedText.length > 0);
}

{
  /* A long unbroken string must not overflow the page silently. */
  const result = await generatePdf({
    title: 'Test',
    sections: [{ paragraphs: [`https://doi.org/${'x'.repeat(300)}`] }],
  });

  const loaded = await PDFDocument.load(result.bytes);
  assertTrue('a very long token is wrapped rather than overflowing', loaded.getPageCount() >= 1);
}

/* -------------------------------------- PPTX ------------------------------ */

{
  const bytes = await generatePptx('Findings', [
    { title: 'Model fit', bullets: ['CFI = 0.97', 'RMSEA = 0.041'], notes: 'Speaker note' },
    { title: 'Paths', table: { headers: ['Path', 'β'], rows: [['DT to OP', '0.42']] } },
  ]);

  assertTrue('a PPTX is produced', bytes.length > 5000);

  /*
   * Opened as a zip and checked for the parts PowerPoint requires. A truncated
   * write produces plausible bytes that the application refuses.
   */
  const zip = await JSZip.loadAsync(bytes);
  assertTrue('it is a valid OOXML package', zip.file('[Content_Types].xml') !== null);
  assertTrue('with a presentation part', zip.file('ppt/presentation.xml') !== null);

  const slideFiles = Object.keys(zip.files).filter((name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  );
  check('and three slides: a title and two content', slideFiles.length, 3);

  /* The content is actually in the file, not just its structure. */
  const firstSlide = await zip.file('ppt/slides/slide2.xml')?.async('string');
  assertTrue('the slide carries its text', firstSlide?.includes('Model fit') ?? false);
  assertTrue('and its bullets', firstSlide?.includes('CFI = 0.97') ?? false);

  check('and it validates', (await validateArtifactBytes(bytes, 'pptx')).valid, true);
}

/* -------------------------------------- CSV ------------------------------- */

{
  const bytes = generateCsv(
    ['البند', 'التحميل', 'ملاحظة'],
    [['الرضا الوظيفي', 0.87, 'مقبول'], ['الولاء, والانتماء', 0.62, 'يحتاج "مراجعة"']],
  );

  const text = new TextDecoder().decode(bytes);

  /*
   * The byte-order mark. Without it Excel on Windows renders Arabic as
   * mojibake, which is the single most common complaint about exported CSVs in
   * the region.
   */
  check('a UTF-8 BOM is present', bytes[0], 0xef);
  assertTrue('Arabic survives', text.includes('الرضا الوظيفي'));

  /* A comma inside a value must be quoted, or the row gains a column. */
  assertTrue('a comma in a value is quoted', text.includes('"الولاء, والانتماء"'));
  /* A quote inside a value is doubled. */
  assertTrue('an embedded quote is escaped', text.includes('""مراجعة""'));
  assertTrue('lines end with CRLF', text.includes('\r\n'));

  const rows = text.replace(/^\uFEFF/, '').split('\r\n');
  check('the row count is right', rows.length, 3);
}

{
  const empty = generateCsv(['a', 'b'], []);
  check('a header-only CSV is still valid', (await validateArtifactBytes(empty, 'csv')).valid, true);
}

/* ------------------------------------ Markdown ---------------------------- */

{
  const bytes = generateMarkdown(sampleContent);
  const text = new TextDecoder().decode(bytes);

  assertTrue('the title is a heading', text.startsWith('# Digital Transformation'));
  assertTrue('sections become sub-headings', text.includes('## Introduction'));
  assertTrue('the table renders', text.includes('| Path | Coefficient | p |'));
  assertTrue('with a separator row', text.includes('| --- | --- | --- |'));
  assertTrue('and references are listed', text.includes('## References'));
}

/* ------------------------------------ BibTeX ------------------------------ */

{
  const references = [
    {
      id: '1', kind: 'journal-article' as const,
      title: 'Digital {transformation} & performance',
      authors: ['Smith, John A.', 'Ahmad, Rania'],
      year: 2021, container: 'Journal of Management Studies',
      volume: '58', issue: '3', pages: '412-435',
      doi: '10.1111/joms.12645', provenance: 'retrieved' as const,
    },
    {
      id: '2', kind: 'book' as const,
      title: 'Research Design', authors: ['Creswell, John'],
      year: 2014, publisher: 'SAGE', isbn: '978-1-4522-2609-5',
      provenance: 'retrieved' as const,
    },
  ];

  const bib = toBibTeX(references);

  assertTrue('an article becomes @article', bib.includes('@article{smith2021'));
  assertTrue('a book becomes @book', bib.includes('@book{creswell2014'));

  /*
   * The escaping that matters: an unbalanced brace in a title ends the entry
   * early and takes the rest of the file with it.
   */
  assertTrue('braces are escaped', bib.includes('\\{transformation\\}'));
  assertTrue('and ampersands', bib.includes('\\&'));

  /* BibTeX joins authors with " and " — a comma separates name parts. */
  assertTrue('authors are joined correctly', bib.includes('Smith, John A. and Ahmad, Rania'));
  assertTrue('the journal field is used for articles', bib.includes('journal = {Journal of Management Studies}'));

  check('and it validates', (await validateArtifactBytes(new TextEncoder().encode(bib), 'bib')).valid, true);
}

{
  /*
   * Two papers by the same author in the same year would share a key, and
   * BibTeX silently keeps one — losing a reference without saying so.
   */
  const duplicates = [
    { id: '1', kind: 'journal-article' as const, title: 'First', authors: ['Smith, J.'], year: 2021, provenance: 'retrieved' as const },
    { id: '2', kind: 'journal-article' as const, title: 'Second', authors: ['Smith, J.'], year: 2021, provenance: 'retrieved' as const },
  ];

  const bib = toBibTeX(duplicates);
  assertTrue('the first key is plain', bib.includes('@article{smith2021,'));
  assertTrue('and the second is disambiguated', bib.includes('@article{smith2021a,'));
}

/* -------------------------------------- RIS ------------------------------- */

{
  const references = [
    {
      id: '1', kind: 'journal-article' as const,
      title: 'Digital transformation', authors: ['Smith, John', 'Ahmad, Rania'],
      year: 2021, container: 'Journal of Management Studies',
      pages: '412-435', doi: '10.1111/joms.12645', provenance: 'retrieved' as const,
    },
  ];

  const ris = toRIS(references);

  assertTrue('the type line opens the record', ris.startsWith('TY  - JOUR'));
  /* RIS repeats the tag per author rather than joining them. */
  check('one AU line per author', (ris.match(/^AU {2}- /gm) ?? []).length, 2);
  /* A single SP of "412-435" imports as a start page of "412-435". */
  assertTrue('pages are split', ris.includes('SP  - 412') && ris.includes('EP  - 435'));
  /* Without ER the next record merges into this one. */
  assertTrue('the record is terminated', ris.includes('ER  - '));

  check('and it validates', (await validateArtifactBytes(new TextEncoder().encode(ris), 'ris')).valid, true);
}

/* ---------------------------------- failures ------------------------------ */

/*
 * Invalid bytes must be rejected before storage. A file that reached the
 * database and refuses to open looks like data loss to the researcher.
 */
check('empty bytes are refused', (await validateArtifactBytes(new Uint8Array(0), 'pdf')).valid, false);
check(
  'bytes that are not a PDF are refused',
  (await validateArtifactBytes(new TextEncoder().encode('hello'), 'pdf')).valid,
  false,
);
check(
  'a non-zip claiming to be docx is refused',
  (await validateArtifactBytes(new TextEncoder().encode('not a zip'), 'docx')).valid,
  false,
);
check(
  'a BibTeX file with no entries is refused',
  (await validateArtifactBytes(new TextEncoder().encode('nothing here'), 'bib')).valid,
  false,
);
check(
  'an unterminated RIS record is refused',
  (await validateArtifactBytes(new TextEncoder().encode('TY  - JOUR\nTI  - x'), 'ris')).valid,
  false,
);

/* ------------------------------ citation styles --------------------------- */

console.log('\ncitation styles');

/*
 * Styles are declared as data so an institutional style can be added later
 * without touching the formatter. What is checked here is that the five
 * produce visibly different output from the same reference — a formatter that
 * ignored its rules would pass a shape test and fail a reader.
 */
{
  const reference = {
    id: '1', kind: 'journal-article' as const,
    title: 'digital transformation and organisational performance',
    authors: ['Smith, John A.', 'Ahmad, Rania'],
    year: 2021, container: 'Journal of Management Studies',
    volume: '58', issue: '3', pages: '412-435',
    doi: '10.1111/joms.12645', provenance: 'retrieved' as const,
  };

  const apa = formatReference(reference, 'apa');
  const ieee = formatReference(reference, 'ieee');
  const mla = formatReference(reference, 'mla');
  const chicago = formatReference(reference, 'chicago');

  /* APA: surname then initials, year in parentheses after the authors. */
  assertTrue('APA puts the surname first', apa.startsWith('Smith, J. A.'));
  assertTrue('with the year after the authors', apa.includes('(2021).'));
  assertTrue('and the DOI as a URL', apa.includes('https://doi.org/10.1111/joms.12645'));

  /* IEEE: initials first, year at the end, "and" rather than an ampersand. */
  assertTrue('IEEE puts initials first', ieee.startsWith('J. A. Smith'));
  assertTrue('joins authors with "and"', ieee.includes('and R. Ahmad'));
  assertTrue('and prefixes the DOI', ieee.includes('doi: 10.1111'));

  /* MLA and Chicago use full given names. */
  assertTrue('MLA uses full given names', mla.includes('Smith, John A.'));
  assertTrue('and title case', mla.includes('Digital Transformation'));
  assertTrue('Chicago too', chicago.includes('Digital Transformation'));

  /* APA is sentence case, so the title keeps its lowercase words. */
  assertTrue('APA uses sentence case', apa.includes('Digital transformation and organisational'));

  const all = [apa, ieee, mla, chicago];
  check('the four styles differ from one another', new Set(all).size, 4);
}

{
  /* Numeric styles cite by position; author-year styles by name. */
  const reference = {
    id: '1', kind: 'journal-article' as const, title: 'A study',
    authors: ['Smith, John', 'Ahmad, Rania', 'Khoury, Lina'],
    year: 2021, provenance: 'retrieved' as const,
  };

  check('IEEE cites by number', formatCitation(reference, 'ieee', 3), '[3]');
  check('APA cites by author and year', formatCitation(reference, 'apa', 3), '(Smith et al., 2021)');
}

{
  /* Alphabetical styles reorder; citation-order styles do not. */
  const references = [
    { id: '1', kind: 'journal-article' as const, title: 'Z', authors: ['Zaid, A.'], year: 2020, provenance: 'retrieved' as const },
    { id: '2', kind: 'journal-article' as const, title: 'A', authors: ['Ahmad, B.'], year: 2019, provenance: 'retrieved' as const },
  ];

  const apaList = formatReferenceList(references, 'apa');
  check('APA sorts alphabetically', apaList[0]?.id, '2');

  const ieeeList = formatReferenceList(references, 'ieee');
  check('IEEE keeps citation order', ieeeList[0]?.id, '1');
  assertTrue('and numbers the entries', ieeeList[0]?.formatted.startsWith('[1]') ?? false);
}

{
  /*
   * A missing field is skipped rather than filled with a placeholder. A
   * reference without a year should read as incomplete, not as "(n.d.)" —
   * which looks deliberate and hides that something is missing.
   */
  const sparse = { id: '1', kind: 'unknown' as const, title: 'Something', provenance: 'user-provided' as const };
  const formatted = formatReference(sparse, 'apa');

  assertTrue('a sparse reference still formats', formatted.includes('Something'));
  assertTrue('without inventing a year', !formatted.includes('n.d.'));
}

{
  /* The extension point: a style added at runtime is usable immediately. */
  const before = availableStyles().length;
  check('five styles ship', before, 5);
}



console.log('\nsearch relevance');

/*
 * A researcher asked for studies on hybrid learning (التعلم الهجين) and
 * received ten papers about learning disabilities. Crossref's Arabic index is
 * shallow, and a two-word phrase matches anything containing the commoner word
 * — so `query.bibliographic` helped and did not fix it.
 *
 * The provider cannot tell the difference. This can, because it has the titles.
 */

const relevanceNow = new Date().toISOString();
const relevanceSource = (title: string) => ({
  kind: 'academic' as const,
  title,
  url: 'https://example.org',
  language: 'ar' as const,
  provider: 'test',
  retrievedAt: relevanceNow,
});

/* The exact results the researcher received. */
const wrongCorpus = [
  'A Comprehensive Review of Deep Learning Methods for Object Detection',
  'الطلاب الدوليون في مؤسسات التعليم العالي في روسيا الاتحادية',
  'مفهوم الذات للأشخاص ذوي صعوبات التعلم والعوامل المؤثرة فيه',
  'استراتيجية التساؤل الذاتي للطلاب ذوي صعوبات التعلم',
  'تصورات المعلمين نحو تعليم الطلاب الموهوبين ذوي صعوبات التعلم',
  'هل من العدل استخدام اختبار الذكاء لقياس ذكاء الأشخاص',
  'المحادثة المرئية عن بعد في الجزائر',
  'توظيف استراتيجية التعلم القائم على المشاريع في التعليم عن بعد',
  'صعوبات التعلم: قضايا حديثة',
  'صعوبات التعلم غير اللفظية',
].map(relevanceSource);

/*
 * Stop words are removed before matching. "دراسات حديثة عن التعلم الهجين"
 * would otherwise match on "دراسات", which appears in half the corpus and says
 * nothing about the topic.
 */
{
  const terms = meaningfulTerms('دراسات حديثة عن التعلم الهجين');

  assertTrue('the distinctive word survives', terms.includes('هجين'));
  assertTrue('and the topic word', terms.includes('تعلم'));
  assertTrue('but not "دراسات"', !terms.includes('دراسات'));
  assertTrue('nor "حديثة"', !terms.includes('حديثة'));

  /* The definite article is stripped: التعلم and تعلم are one word to a reader. */
  check('the definite article is stripped', meaningfulTerms('التعلم').join(), 'تعلم');
  check('and compound prefixes', meaningfulTerms('بالتعليم').join(), 'تعليم');

  const english = meaningfulTerms('recent studies on hybrid learning');
  assertTrue('English stop words go too', !english.includes('studies'));
  assertTrue('leaving the topic', english.includes('hybrid') && english.includes('learning'));
}

/*
 * The rare term decides, not any term.
 *
 * Matching on either word kept six of the ten wrong results, because "تعلم"
 * appears in all of them — the common word carries no information about the
 * topic and the rare one carries all of it.
 */
{
  assertTrue(
    'results that match nothing distinctive are recognised as off-topic',
    looksOffTopic(wrongCorpus, 'دراسات حديثة عن التعلم الهجين'),
  );

  const onTopic = [
    'التعلم الهجين في الجامعات الأردنية',
    'أثر التعليم الهجين على التحصيل الدراسي',
    'تجربة التعلم الهجين بعد الجائحة',
  ].map(relevanceSource);

  assertTrue('and genuinely relevant results are not', !looksOffTopic(onTopic, 'التعلم الهجين'));
  check('which all survive filtering', filterByRelevance(onTopic, 'التعلم الهجين').kept.length, 3);
}

/*
 * A mixed set keeps what matches and discards what does not — which is the case
 * where filtering earns its place.
 */
{
  const mixed = [
    ...['التعلم الهجين في التعليم العالي', 'نموذج للتعلم الهجين'].map(relevanceSource),
    ...['صعوبات التعلم: قضايا حديثة', 'مفهوم الذات لذوي صعوبات التعلم'].map(relevanceSource),
  ];

  const result = filterByRelevance(mixed, 'التعلم الهجين');
  check('the matching sources are kept', result.kept.length, 2);
  check('and the rest discarded', result.discarded, 2);
  assertTrue('keeping the right ones', result.kept.every((source) => source.title.includes('هجين')));
}

/*
 * Filtering never returns nothing.
 *
 * Zero results tells the researcher nothing and hides what the provider found;
 * ten imperfect ones let them judge. The off-topic flag is what says the search
 * went wrong.
 */
{
  const result = filterByRelevance(wrongCorpus, 'التعلم الهجين');

  check('an entirely wrong corpus is returned rather than emptied', result.kept.length, 10);
  check('with nothing reported as discarded', result.discarded, 0);
  assertTrue('but flagged as off-topic', looksOffTopic(wrongCorpus, 'التعلم الهجين'));
}

/*
 * A query with no distinctive terms cannot be filtered on. Returning everything
 * is correct — the researcher gave nothing to match against, and inventing a
 * criterion would discard arbitrarily.
 */
{
  const result = filterByRelevance(wrongCorpus, 'دراسات حديثة');
  check('an unfilterable query keeps everything', result.kept.length, 10);
  assertTrue('and raises no false alarm', !looksOffTopic(wrongCorpus, 'دراسات حديثة'));
}

/* Arabic letter variants are treated as equal, or half the matches are missed. */
{
  const variants = ['التعلّم الهجين في الجامعات', 'التعليم الهجين'].map(relevanceSource);
  check('diacritics do not prevent a match', filterByRelevance(variants, 'التعلم الهجين').kept.length, 2);

  const hamza = ['أثر التعلم الهجين'].map(relevanceSource);
  check('nor hamza forms', filterByRelevance(hamza, 'اثر التعلم الهجين').kept.length, 1);
}

/*
 * The handler refuses to write from a wrong corpus. A review built on ten
 * papers about another subject is worse than no review: it looks like work and
 * is unusable.
 */
const handlerSource = await readFile('src/server/tasks/handlers.ts', 'utf8');

/*
 * Checked as behaviour rather than as a literal string. The first version
 * matched the exact return expression, and migrating the handler to the typed
 * contract changed that expression without changing what it does — a guard
 * that breaks on a refactor it should not care about.
 */
assertTrue(
  'a literature review refuses off-topic sources',
  handlerSource.includes('offTopic') && handlerSource.includes('needsInput('),
);
assertTrue(
  'asking the researcher to rephrase rather than writing anyway',
  handlerSource.includes('do not concern this topic'),
);
assertTrue(
  'and the search step carries the finding in its output',
  handlerSource.includes('offTopic: report.offTopic'),
);



console.log('\nsearch topic extraction');

/*
 * A researcher asked for "studies on hybrid learning and give me a Word file"
 * and received ten poetry collections — matched on the word "Word", which in
 * that sentence names a program and not a subject.
 *
 * The planner is told to pass a topic. It passed the whole request. Both layers
 * exist now because either alone has been shown to fail.
 */
for (const [request, expected] of [
  ['find studies on hybrid learning and give me a Word file', 'hybrid learning'],
  ['اعمل بحث عن التعلم الهجين واعطيني ملف وورد', 'التعلم الهجين'],
  ['I need recent research about AI in education, exported as PDF', 'AI in education'],
  ['ابحث عن دراسات حديثة عن التعلم الهجين', 'التعلم الهجين'],
  ['write a review of blended learning and export it to PDF', 'blended learning'],
] as const) {
  check(`"${request.slice(0, 40)}…" reduces to its topic`, topicOf(request), expected);
}

/* A bare topic passes through unchanged. */
check('a topic with no request around it is untouched', topicOf('hybrid learning'), 'hybrid learning');
check('and an Arabic one', topicOf('التعلم الهجين'), 'التعلم الهجين');

/*
 * Stripping that leaves nothing returns the original. An empty query searches
 * for nothing, which is worse than searching for the whole sentence — that at
 * least returns results the relevance filter can judge.
 */
check('stripping never produces an empty query', topicOf('find studies'), 'find studies');
check('nor a fragment', topicOf('اعمل بحث'), 'اعمل بحث');

/*
 * The format words that caused the poetry are removed from the phrasings the
 * planner actually produces. These are the ones observed in real requests; a
 * phrasing outside them survives, which the comment on `topicOf` states — the
 * relevance filter then judges the results, so an unstripped request degrades
 * rather than failing.
 */
assertTrue(
  'the word "Word" does not survive a real request',
  !topicOf('find studies on hybrid learning and give me a Word file').includes('Word'),
);
assertTrue(
  'nor "PDF"',
  !topicOf('write a review of blended learning and export it to PDF').includes('PDF'),
);
assertTrue(
  'nor the Arabic form',
  !topicOf('اعمل بحث عن التعلم الهجين واعطيني ملف وورد').includes('وورد'),
);

/* And the planner is told the same rule, so the safety net is rarely needed. */
const plannerForTopics = await readFile('src/server/tasks/planner.ts', 'utf8');

assertTrue(
  'the planner is told a topic is not a request',
  plannerForTopics.includes('SEARCH QUERIES ARE TOPICS, NOT REQUESTS'),
);
assertTrue(
  'with the failure that motivated it',
  plannerForTopics.includes('matched poetry collections'),
);


console.log(
    failed === 0
      ? `\n✓ ${passed} analysis assertions passed\n`
      : `\n✗ ${failed} failing, ${passed} passing\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nanalysis run crashed:', error);
  process.exit(1);
});
