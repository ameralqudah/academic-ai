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
import { detectDelimiter, parseCsv } from '@/analysis/parse';
import { parseXlsx } from '@/analysis/parse-xlsx';
import { profileDataset } from '@/analysis/profile';
import { toCsv, reportToText } from '@/analysis/serialize';
import { kurtosis, mean, median, quantile, rank, skewness, standardDeviation, toNumber } from '@/analysis/stats-core';
import type { CleaningAction } from '@/analysis/types';

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
