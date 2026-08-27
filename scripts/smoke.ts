/**
 * Smoke tests for the pure logic the product depends on — word counting in two
 * scripts, section-key mapping, the integrity guardrails, JSON tolerance, and
 * Word export.
 *
 *   npm run test:smoke
 *
 * No database, no network, no API keys. Runs in about a second, so it belongs in
 * CI ahead of the build.
 */

import { AlignmentType, Document, Packer, Paragraph, TextRun } from 'docx';

import { estimateTokens } from '@/ai/provider';
import { AnthropicProvider } from '@/ai/providers/anthropic';
import { inspectOutput, parseJsonOutput } from '@/ai/guardrails';
import { sectionI18nKey } from '@/lib/sections';
import { countWords, slugify, truncate } from '@/lib/text';

let failures = 0;

function assertTrue(name: string, value: boolean) {
  check(name, value, true);
}

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

console.log('\ntext utilities');
check('countWords en', countWords('The quick brown fox'), 4);
check('countWords ar', countWords('هذه دراسة تحليلية عن التعليم'), 5);
check('countWords ar with diacritics', countWords('هَذِهِ دِرَاسَةٌ'), 2);
check('countWords ar punctuation', countWords('السؤال الأول، والسؤال الثاني؟'), 4);
check('countWords empty', countWords('   '), 0);
check('truncate', truncate('abcdefghij', 5), 'abcd…');
check('slugify arabic', slugify('مشكلة الدراسة!'), 'مشكلة-الدراسة');

console.log('\nsection keys');
check('LITERATURE_REVIEW', sectionI18nKey('LITERATURE_REVIEW'), 'literatureReview');
check('DATA_ANALYSIS_PLAN', sectionI18nKey('DATA_ANALYSIS_PLAN'), 'dataAnalysisPlan');
check('CHAPTER_1', sectionI18nKey('CHAPTER_1'), 'chapter1');

console.log('\nacademic integrity guardrails');
check(
  'flags an English citation',
  inspectOutput('Prior work (Smith, 2019) found a positive effect.').flags,
  ['UNVERIFIED_CITATION'],
);
check(
  'flags an Arabic citation',
  inspectOutput('وأشار (الزهراني، 2021) إلى أن النتائج متباينة.').flags.includes(
    'UNVERIFIED_CITATION',
  ),
  true,
);
check(
  'flags a DOI',
  inspectOutput('See https://doi.org/10.1234/abcd.2020').flags.includes('DOI_PRESENT'),
  true,
);
check(
  'flags invented statistics outside a results section',
  inspectOutput('The correlation was r = 0.62, p < 0.01.', {
    expectsNoStatistics: true,
  }).flags.includes('FABRICATED_STATISTIC'),
  true,
);
check(
  'flags a claim to have run the study',
  inspectOutput('We conducted a survey of 300 students.').flags.includes('CLAIMED_EXPERIMENT'),
  true,
);
check(
  'leaves clean academic Arabic alone',
  inspectOutput('مشكلة الدراسة تتمثل في ضعف مهارات القراءة لدى طلبة المرحلة الأساسية.').flags
    .length,
  0,
);

console.log('\nprovider output parsing');
check('parses fenced JSON', parseJsonOutput('```json\n{"a":1}\n```'), { a: 1 });
check('parses JSON with prose around it', parseJsonOutput('Here you go: {"a":2} — enjoy'), {
  a: 2,
});
check('returns null on unparsable output', parseJsonOutput('not json at all'), null);
check('token estimate is positive for both scripts', estimateTokens('هذه دراسة') > 0 && estimateTokens('a study') > 0, true);

console.log('\nprompt caching economics');
const anthropic = new AnthropicProvider('test-key', 'test-model');
const uncached = anthropic.estimateCostMicroUsd({ tokensIn: 20_000, tokensOut: 1_000 });
const cachedRead = anthropic.estimateCostMicroUsd({
  tokensIn: 200,
  tokensOut: 1_000,
  cacheReadTokens: 19_800,
});
const cacheWrite = anthropic.estimateCostMicroUsd({
  tokensIn: 200,
  tokensOut: 1_000,
  cacheWriteTokens: 19_800,
});
assertTrue('a cache read is cheaper than sending the context again', cachedRead < uncached);
assertTrue('the first call (cache write) costs a little more', cacheWrite > uncached);
assertTrue(
  'a cache read saves most of the input cost',
  (uncached - cachedRead) / uncached > 0.5,
);
check('cost is reported in whole micro-dollars', Number.isInteger(cachedRead), true);

console.log('\nword export');
const document = new Document({
  sections: [
    {
      properties: {},
      children: [
        new Paragraph({
          children: [new TextRun({ text: 'مشكلة الدراسة', rightToLeft: true })],
          bidirectional: true,
          alignment: AlignmentType.RIGHT,
        }),
      ],
    },
  ],
});

const buffer = await Packer.toBuffer(document);
// A .docx is a zip archive: the first two bytes are always "PK".
check('produces a valid docx container', buffer.subarray(0, 2).toString('latin1'), 'PK');
check('docx is not empty', buffer.byteLength > 1000, true);

console.log(failures === 0 ? '\n✓ all smoke tests passed\n' : `\n✗ ${failures} failing\n`);
process.exit(failures === 0 ? 0 : 1);
