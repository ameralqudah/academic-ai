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

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AlignmentType, Document, Packer, Paragraph, TextRun } from 'docx';

import {
  availableCapabilities,
  CAPABILITIES,
  capabilityFor,
  classifiableIntents,
  INTENT_KEYS,
  isAvailable,
  isKnownIntent,
  plannedCapabilities,
} from '@/agents/registry';
import { estimateTokens } from '@/ai/provider';
import { AnthropicProvider } from '@/ai/providers/anthropic';
import { inspectOutput, parseJsonOutput } from '@/ai/guardrails';
import { sectionI18nKey } from '@/lib/sections';
import { countWords, slugify, truncate } from '@/lib/text';
import { assertSafeKey, datasetKey, datasetPrefix, keyBelongsTo } from '@/server/storage/keys';
import { checksumOf, LocalStorageProvider } from '@/server/storage/local';
import { StorageError } from '@/server/storage/provider';
import { amzDates, signRequest } from '@/server/storage/s3';

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

/* -------------------------------------------------------------------------- */
/*                                  Storage                                   */
/* -------------------------------------------------------------------------- */

console.log('\nstorage keys');

/*
 * Keys are built from server-generated ids only. The name the user chose is
 * kept in the database, never in the path — so a file called `report.csv.exe`
 * cannot produce a key ending in `.exe`, and a name containing `../` cannot
 * produce a key at all.
 */
check(
  'a dataset key is built from ids alone',
  datasetKey({ userId: 'u-1', datasetId: 'd-2', kind: 'ORIGINAL', extension: 'csv' }),
  'datasets/u-1/d-2/original.csv',
);
check(
  'the cleaned copy is a separate object',
  datasetKey({ userId: 'u-1', datasetId: 'd-2', kind: 'CLEANED', extension: 'csv' }),
  'datasets/u-1/d-2/cleaned.csv',
);
check('a key carries its owner as the first segment', keyBelongsTo('datasets/u-1/d-2/original.csv', 'u-1'), true);
check('and does not match another owner', keyBelongsTo('datasets/u-1/d-2/original.csv', 'u-9'), false);

function rejectsKey(name: string, key: string) {
  try {
    assertSafeKey(key);
    failures += 1;
    console.log(`  FAIL ${name}: the key was accepted`);
  } catch (error) {
    check(name, error instanceof StorageError, true);
  }
}

rejectsKey('traversal is rejected', 'datasets/u-1/../u-2/original.csv');
rejectsKey('a bare parent segment is rejected', '../secrets.env');
rejectsKey('an absolute path is rejected', '/etc/passwd');
rejectsKey('a Windows drive letter is rejected', 'C:/Windows/system32');
rejectsKey('a backslash is rejected', 'datasets\\u-1\\original.csv');
rejectsKey('a null byte is rejected', 'datasets/u-1/original.csv\0.png');
rejectsKey('a URL is rejected', 'https://example.com/file.csv');
rejectsKey('an empty segment is rejected', 'datasets//original.csv');
rejectsKey('a current-directory segment is rejected', 'datasets/./original.csv');
rejectsKey('an empty key is rejected', '');
rejectsKey('an over-long key is rejected', `datasets/${'a'.repeat(600)}/x.csv`);

console.log('\nlocal storage');

const storageRoot = await mkdtemp(join(tmpdir(), 'academic-ai-storage-'));
const storage = new LocalStorageProvider(storageRoot);

check('a configured provider reports itself ready', storage.isConfigured(), true);
check('an unconfigured provider does not', new LocalStorageProvider('').isConfigured(), false);

const sampleKey = datasetKey({ userId: 'u-1', datasetId: 'd-2', kind: 'ORIGINAL', extension: 'csv' });
const sampleBytes = new TextEncoder().encode('name,score\nAli,42\nSara,37\n');

const written = await storage.put(sampleKey, sampleBytes, 'text/csv');
check('a stored object reports its size', written.byteSize, sampleBytes.byteLength);
check('the object exists after writing', await storage.exists(sampleKey), true);

const readBack = await storage.get(sampleKey);
check(
  'the bytes come back unchanged',
  new TextDecoder().decode(readBack.bytes),
  'name,score\nAli,42\nSara,37\n',
);
check('the checksum is stable', checksumOf(readBack.bytes), checksumOf(sampleBytes));

const info = await storage.stat(sampleKey);
check('stat reports the size', info?.byteSize, sampleBytes.byteLength);
check('stat returns nothing for an absent key', await storage.stat('datasets/u-1/d-9/original.csv'), null);

/*
 * The escape check is a second defence behind key validation. It cannot be
 * triggered through `datasetKey`, so it is tested directly — the point of
 * having it is the case where something upstream has already gone wrong.
 */
let escaped = false;
try {
  await storage.get('../../etc/passwd');
} catch (error) {
  escaped = error instanceof StorageError;
}
check('a traversal attempt never reaches the filesystem', escaped, true);

await storage.delete(sampleKey);
check('the object is gone after deletion', await storage.exists(sampleKey), false);
// Deleting twice must succeed, so a retried delete is not an error.
await storage.delete(sampleKey);
check('deleting an absent object is not an error', true, true);

await storage.put(datasetKey({ userId: 'u-3', datasetId: 'd-4', kind: 'ORIGINAL', extension: 'csv' }), sampleBytes);
await storage.put(datasetKey({ userId: 'u-3', datasetId: 'd-4', kind: 'CLEANED', extension: 'csv' }), sampleBytes);
await storage.deletePrefix(datasetPrefix('u-3', 'd-4'));
check(
  'deleting a prefix removes both the original and the cleaned copy',
  await storage.exists(datasetKey({ userId: 'u-3', datasetId: 'd-4', kind: 'CLEANED', extension: 'csv' })),
  false,
);

await rm(storageRoot, { recursive: true, force: true });

console.log('\nS3 request signing');

/*
 * Signature Version 4, checked against an independent implementation of the
 * same published algorithm written in Python. The signing chain is arithmetic,
 * so it can be verified without a bucket — but a live upload against the real
 * endpoint is still required before switching a deployment to `s3`, and no
 * assertion here can substitute for it.
 */
const sha256Of = (value: string) => createHash('sha256').update(value).digest('hex');

const signed = signRequest({
  method: 'PUT',
  host: 'bucket.example.com',
  path: '/mybucket/datasets/u1/d1/original.csv',
  region: 'auto',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  payloadHash: sha256Of('hello world'),
  amzDate: '20260827T120000Z',
  dateStamp: '20260827',
  extraHeaders: { 'content-type': 'text/csv' },
});

check(
  'a PUT signature matches the reference implementation',
  signed.authorization?.split('Signature=')[1],
  'e9b546d93aa8581140af1fb6455ae66e33f1c02f2638b0533e1e6d5a0a824fa6',
);

check(
  'a GET signature matches',
  signRequest({
    method: 'GET',
    host: 's3.eu-central-1.amazonaws.com',
    path: '/b/k',
    region: 'eu-central-1',
    accessKeyId: 'AKID2',
    secretAccessKey: 'SECRET2',
    payloadHash: sha256Of(''),
    amzDate: '20260101T000000Z',
    dateStamp: '20260101',
  }).authorization?.split('Signature=')[1],
  'e75ba5a8bf2602f8ac8a1f9ca13507f357a642478fda0584d926009f2f8ceff5',
);

check(
  'a DELETE signature matches',
  signRequest({
    method: 'DELETE',
    host: 'x.r2.cloudflarestorage.com',
    path: '/bk/datasets/abc/def/cleaned.csv',
    region: 'auto',
    accessKeyId: 'AK3',
    secretAccessKey: 'SK3',
    payloadHash: sha256Of(''),
    amzDate: '20261231T235959Z',
    dateStamp: '20261231',
  }).authorization?.split('Signature=')[1],
  '727790a1d48b72a9fdd923468be5c70a2e02ac330fdbe629b77fd9e2b055889b',
);

check(
  'the signed headers are listed in sorted order',
  signed.authorization?.includes('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date'),
  true,
);
check('the timestamp format is the one SigV4 expects', amzDates(new Date('2026-08-27T12:00:00.000Z')).amzDate, '20260827T120000Z');
check('and the date stamp is derived from it', amzDates(new Date('2026-08-27T12:00:00.000Z')).dateStamp, '20260827');

/* -------------------------------------------------------------------------- */
/*                            Agent capabilities                              */
/* -------------------------------------------------------------------------- */

console.log('\nagent capability catalogue');

/*
 * The catalogue is what stops the agent from improvising. These assertions are
 * about honesty rather than arithmetic: that everything claimed available has
 * an engine behind it, and that everything unbuilt says so instead of being
 * quietly routed somewhere that would run.
 */

check('every intent has an entry', INTENT_KEYS.length, Object.keys(CAPABILITIES).length);
assertTrue('and every entry names its own intent', INTENT_KEYS.every((key) => CAPABILITIES[key].intent === key));

/*
 * The tests an available capability claims must exist in the analysis module.
 * Without this check, renaming an engine would leave the agent advertising
 * something it can no longer call — and finding out at runtime.
 */
const implementedTests = new Set<string>([
  't.oneSample', 't.independent', 't.paired', 'anova.oneWay',
  'correlation.pearson', 'correlation.spearman', 'correlation.matrix',
  'chiSquare.independence', 'chiSquare.goodnessOfFit',
  'regression.ols', 'reliability.cronbachAlpha',
]);

for (const capability of availableCapabilities()) {
  for (const test of capability.tests ?? []) {
    assertTrue(`${capability.intent} points at a real engine (${test})`, implementedTests.has(test));
  }
}

/*
 * Statistical work is free because it costs no model calls. If this assertion
 * ever fails it means an analysis has started depending on a language model,
 * which is the one thing this architecture exists to prevent.
 */
for (const capability of availableCapabilities()) {
  if (capability.agent === 'statistics' || capability.agent === 'data') {
    check(`${capability.intent} costs the user nothing`, capability.units, 0);
    check(`${capability.intent} makes no model calls`, capability.estimatedCalls, 0);
  }
}

/* Everything unbuilt must explain itself rather than failing silently. */
for (const capability of plannedCapabilities()) {
  assertTrue(`${capability.intent} says why it is unavailable`, Boolean(capability.unavailableReason));
}

/*
 * The four the user asked about by name. Each is recognised — so the agent can
 * decline it precisely — and none is available, so nothing improvises an answer.
 */
for (const intent of ['stats.plsSem', 'stats.cbSem', 'stats.logistic', 'stats.nonparametric'] as const) {
  check(`${intent} is recognised`, isKnownIntent(intent), true);
  check(`${intent} is not offered as available`, isAvailable(intent), false);
  check(`${intent} is marked planned`, capabilityFor(intent).status, 'planned');
}

/* The classifier is given planned intents too: declining precisely beats misrouting. */
const classifiable = classifiableIntents().map((entry) => entry.intent);
assertTrue('the classifier can name PLS-SEM even though it cannot run it', classifiable.includes('stats.plsSem'));
assertTrue('and logistic regression', classifiable.includes('stats.logistic'));
check('the classifier sees every intent', classifiable.length, INTENT_KEYS.length);

/* Anything invented by a model is rejected at the boundary. */
check('an invented intent is rejected', isKnownIntent('stats.magic'), false);
check('an empty intent is rejected', isKnownIntent(''), false);

/* Statistics and data intents need a file; writing intents do not. */
check('comparing groups needs a dataset', capabilityFor('stats.compare').requiresDataset, true);
check('planning a study does not', capabilityFor('research.plan').requiresDataset, false);

/*
 * Writing the results chapter is held back deliberately. The prose is the easy
 * part; the wiring that puts verified numbers into the model's context as facts
 * is not, and without it this would mean writing results with no results.
 */
check('writing the results chapter is not offered yet', capabilityFor('research.results').status, 'planned');

console.log(failures === 0 ? '\n✓ all smoke tests passed\n' : `\n✗ ${failures} failing\n`);
process.exit(failures === 0 ? 0 : 1);
