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

import ExcelJS from 'exceljs';

import { applyCleaning, planCleaning } from '@/analysis/clean';
import { readUpload } from '@/analysis';
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
   * Mann–Whitney, which is not implemented. The recommender says so instead of
   * quietly promoting the t-test.
   */
  const ordinalSmall = recommendTest(smallSurvey, [
    { column: 'q1', role: 'dependent' },
    { column: 'gender', role: 'grouping' },
  ]);
  const mannWhitney = ordinalSmall.candidates.find(
    (candidate) => candidate.test === 'nonparametric.mannWhitney',
  );
  check('the right test is named', mannWhitney?.confidence, 'recommended');
  check('and marked as not yet built', mannWhitney?.available, false);
  check('so no runnable test is recommended', ordinalSmall.best, null);
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
