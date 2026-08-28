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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AlignmentType, Document, Packer, Paragraph, TextRun } from 'docx';

import { classifyByKeyword, KEYWORD_RULE_ORDER } from '@/agents/keywords';
import { buildResultsContext, describeRun, hasVerifiedResults } from '@/ai/context/results';
import { generalPrompt } from '@/ai/prompts/general';
import { mergeSources } from '@/server/knowledge/merge';
import { CrossrefProvider } from '@/server/knowledge/providers/crossref';
import { OpenAlexProvider } from '@/server/knowledge/providers/openalex';
import { detectLanguage, normaliseDoi } from '@/server/knowledge/types';
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
 * Writing the results chapter is available now that verified analyses can reach
 * the prompt as facts. The condition it depends on is what these assertions
 * guard: it must need attached *analyses* rather than a file, since a
 * researcher who analysed their data last week should not have to re-upload
 * anything to write the chapter.
 */
check('writing the results chapter is available', capabilityFor('research.results').status, 'available');
check('and needs analyses rather than a live file', capabilityFor('research.results').requiresDataset, false);
assertTrue(
  'and it costs model calls, unlike the statistical work',
  capabilityFor('research.results').units > 0,
);

console.log('\nkeyword intent matching');

/*
 * These exist because of a production failure: the model classifier returned
 * nothing usable and every request, however plainly worded, came back as "I did
 * not understand". Requests that name their analysis outright should never have
 * depended on a model to begin with — "PLS-SEM" is a name, not a sentence — so
 * they are matched here, deterministically, and these assertions are the
 * regression guard.
 *
 * Every phrase below is one a researcher would actually type, in both languages.
 */
const keywordCases: [string, string][] = [
  // The exact phrasings that failed in production.
  ['أريد تحليل PLS-SEM', 'stats.plsSem'],
  ['أريد تحليل PLS-SEM لنموذج قياس فيه ثلاثة متغيرات كامنة', 'stats.plsSem'],
  ['I want to run a PLS-SEM analysis', 'stats.plsSem'],
  ['smartpls', 'stats.plsSem'],
  ['المربعات الجزئية', 'stats.plsSem'],

  ['أريد التحليل العاملي التوكيدي', 'stats.cbSem'],
  ['نمذجة المعادلات البنائية', 'stats.cbSem'],
  ['run a CFA', 'stats.cbSem'],
  ['AMOS', 'stats.cbSem'],

  ['الانحدار اللوجستي', 'stats.logistic'],
  ['logistic regression please', 'stats.logistic'],

  ['اختبار مان-ويتني', 'stats.nonparametric'],
  ['Mann-Whitney U test', 'stats.nonparametric'],
  ['أريد اختبارات لا معلمية', 'stats.nonparametric'],

  ['احسب ألفا كرونباخ', 'stats.reliability'],
  ['معامل الثبات للمقياس', 'stats.reliability'],
  ['check reliability of my scale', 'stats.reliability'],

  ['أريد تحليل الانحدار المتعدد', 'stats.predict'],
  ['multiple regression', 'stats.predict'],

  ['احسب معامل الارتباط', 'stats.relate'],
  ['ارتباط بيرسون بين المتغيرين', 'stats.relate'],
  ['spearman correlation', 'stats.relate'],

  ['قارن بين الذكور والإناث', 'stats.compare'],
  ['أريد تحليل التباين الأحادي', 'stats.compare'],
  ['الفروق بين المجموعتين', 'stats.compare'],
  ['run a t-test', 'stats.compare'],
  ['ANOVA', 'stats.compare'],

  ['مربع كاي للاستقلالية', 'stats.categorical'],
  ['chi-square test', 'stats.categorical'],

  ['نظف بياناتي', 'data.clean'],
  ['clean my data', 'data.clean'],
  ['الإحصاء الوصفي', 'data.describe'],

  ['ما هو التحليل الإحصائي المناسب', 'stats.recommend'],
  ['which test should I use', 'stats.recommend'],

  ['أنشئ استبانة لهذا البحث', 'research.survey'],
  ['اكتب فصل النتائج', 'research.results'],
  ['الفصل الرابع', 'research.results'],
  ['أريد خطة بحث كاملة', 'research.plan'],
];

for (const [message, expected] of keywordCases) {
  const match = classifyByKeyword(message);
  check(`"${message.slice(0, 42)}" → ${expected}`, match?.intent, expected);
}

/*
 * Ordering is part of the logic. A PLS-SEM request contains words that would
 * otherwise match the looser structural-equation rule, so the specific method
 * must be tested before the general family.
 */
check(
  'PLS-SEM is checked before CB-SEM',
  KEYWORD_RULE_ORDER.indexOf('stats.plsSem') < KEYWORD_RULE_ORDER.indexOf('stats.cbSem'),
  true,
);
check(
  'unbuilt methods are checked before built ones',
  KEYWORD_RULE_ORDER.indexOf('stats.nonparametric') < KEYWORD_RULE_ORDER.indexOf('stats.compare'),
  true,
);

/*
 * A weak match must return null so the caller falls through to the model.
 * Matching loosely to save an API call would trade a slow correct answer for a
 * fast wrong one.
 */
check('a vague request is left to the model', classifyByKeyword('ساعدني'), null);
check('an empty message matches nothing', classifyByKeyword(''), null);
check('small talk matches nothing', classifyByKeyword('مرحبا كيف حالك'), null);
check('a bare question matches nothing', classifyByKeyword('what can you do?'), null);

/* Every intent a keyword rule can produce must exist in the catalogue. */
for (const intent of KEYWORD_RULE_ORDER) {
  assertTrue(`the keyword rule for ${intent} names a real intent`, isKnownIntent(intent));
}

console.log('\ntranslation key resolution');

/*
 * A guard against a bug that reached production: message keys containing dots.
 *
 * next-intl reads a dot as nesting, so a key literally named "stats.reliability"
 * can never be found — the lookup goes hunting for a `stats` object, finds
 * nothing, and renders the raw key. A user asking for PLS-SEM got a correct,
 * well-reasoned refusal followed by "agent.intent.stats.reliability" where the
 * Arabic name of the alternative should have been.
 *
 * The codes themselves are dotted by design and should stay that way — they are
 * identifiers, not display strings. What has to hold is that every one of them
 * has a message under a key the resolver can actually reach, in both languages.
 */
const arMessages = JSON.parse(await readFile('messages/ar.json', 'utf8')) as Record<string, never>;
const enMessages = JSON.parse(await readFile('messages/en.json', 'utf8')) as Record<string, never>;

function lookup(messages: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    messages,
  );
}

const flatten = (code: string) => code.replace(/\./g, '_');

for (const [language, messages] of [['ar', arMessages], ['en', enMessages]] as const) {
  const agent = (messages as Record<string, unknown>).agent as Record<string, unknown>;

  /* Every intent needs a display name — this is the one that broke. */
  for (const intent of INTENT_KEYS) {
    assertTrue(
      `${language}: the intent ${intent} has a resolvable name`,
      typeof lookup(agent, `intent.${flatten(intent)}`) === 'string',
    );
  }

  /* Every test the recommender can name, built or not. */
  for (const test of [
    't.oneSample', 't.independent', 't.paired', 'anova.oneWay',
    'correlation.pearson', 'correlation.spearman', 'correlation.matrix',
    'chiSquare.independence', 'chiSquare.goodnessOfFit', 'regression.ols',
    'reliability.cronbachAlpha', 'nonparametric.mannWhitney',
    'nonparametric.wilcoxon', 'nonparametric.kruskalWallis',
  ]) {
    assertTrue(
      `${language}: the test ${test} has a resolvable name`,
      typeof lookup(agent, `test.${flatten(test)}`) === 'string',
    );
  }

  /* Every reason a capability gives for being unavailable. */
  for (const capability of plannedCapabilities()) {
    const stripped = (capability.unavailableReason ?? '').replace('agent.', '');
    assertTrue(
      `${language}: ${capability.intent} has a resolvable unavailable message`,
      typeof lookup(agent, stripped) === 'string',
    );
  }

  /*
   * And nothing anywhere under `agent` may contain a dot in its own key, since
   * such a key is unreachable however it is looked up.
   */
  function assertNoDottedKeys(node: unknown, path: string): void {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      assertTrue(`${language}: the key "${path}${key}" has no dot in it`, !key.includes('.'));
      assertNoDottedKeys(value, `${path}${key}.`);
    }
  }
  assertNoDottedKeys(agent, '');
}

console.log('\nverified results in the prompt');

/*
 * The feature this product was built toward, and the one with the most room to
 * go quietly wrong.
 *
 * Asked to write a results chapter with no data, a language model writes a
 * convincing one anyway — means, p-values, a table that looks exactly right —
 * because that is what results chapters look like. A committee then reads
 * numbers describing a study nobody conducted.
 *
 * The defence is not a sterner instruction. It is that every figure arrives
 * already computed and already formatted, so there is nothing left to invent.
 * These assertions check that the arrival is exact.
 */

const sampleRun = {
  id: 'run-1',
  testKey: 't.independent',
  spec: { columns: { dependent: 'score', grouping: 'gender' } },
  result: {
    test: 't.independent',
    variables: ['male', 'female'],
    statistic: { name: 't (Welch)', value: -2.220943084706801 },
    df: 23.195677474150397,
    pValue: 0.036394189951284385,
    effect: { name: 'cohensD', value: -0.5187530798249348, band: 'medium' },
    estimates: [
      { label: 'male', n: 8, mean: 10.0375, sd: 0.2825 },
      { label: 'female', n: 24, mean: 13.25, sd: 7.0711 },
    ],
    assumptions: [
      { key: 'normality', status: 'met', pValue: 0.978 },
      { key: 'homogeneity-of-variance', status: 'violated', pValue: 0.0000739 },
    ],
    warnings: [
      { code: 'welch-student-disagree', severity: 'warning', columns: ['male', 'female'] },
      { code: 'small-group', severity: 'warning', columns: ['male'] },
    ],
    n: 32,
    rowsDropped: 3,
    secondary: {
      label: 'student',
      statistic: { name: 't (Student)', value: -1.270680348068361 },
      df: 30,
      pValue: 0.213608180614561,
    },
  },
} as unknown as Parameters<typeof describeRun>[0];

const described = describeRun(sampleRun, 0);

/* The statistic, its degrees of freedom and its p-value, formatted to APA. */
assertTrue('the test statistic reaches the prompt', described.includes('-2.221'));
assertTrue('with its non-integer degrees of freedom', described.includes('23.20'));
assertTrue('and its p-value at three decimals', described.includes('p = 0.036'));
assertTrue('the effect size travels too', described.includes('-0.519'));
assertTrue('and is labelled', described.includes('medium'));

/* Group statistics, which are the substance of the table. */
assertTrue('group means are included', described.includes('M = 10.04'));
assertTrue('and standard deviations', described.includes('SD = 0.282'));
assertTrue('and group sizes', described.includes('n = 8'));

/*
 * The secondary form. A chapter reporting Welch's t without mentioning that
 * Student's was also computed — and disagreed — hides the most interesting
 * thing about the comparison.
 */
assertTrue('the secondary form is included', described.includes('t (Student)'));
assertTrue('with its own p-value', described.includes('p = 0.214'));

/*
 * Assumptions and warnings are not optional context. A finding whose
 * assumptions failed must carry that where the finding is stated.
 */
assertTrue('violated assumptions are flagged', described.includes('homogeneity-of-variance'));
assertTrue('and warnings are listed', described.includes('welch-student-disagree'));
assertTrue('including which columns they concern', described.includes('male'));
assertTrue('excluded cases are reported', described.includes('Cases excluded for missing data: 3'));

/* Rounding happens here so the model never makes that decision. */
const tinyP = describeRun(
  { ...sampleRun, result: { ...(sampleRun as { result: object }).result, pValue: 0.0000001 } } as typeof sampleRun,
  0,
);
assertTrue('a very small p is written as "< .001", not as zeros', tinyP.includes('p < .001'));

/* The block that carries the rules the model must follow. */
const block = buildResultsContext([sampleRun]);
assertTrue('the block exists when there are results', block !== null);
assertTrue('and states the figures are facts', (block ?? '').includes('They are facts.'));
assertTrue('and forbids recomputing them', (block ?? '').toLowerCase().includes('do not recompute'));
assertTrue(
  'and forbids adding statistics that are not present',
  (block ?? '').includes('Do not add any statistic that does not appear below'),
);
assertTrue(
  'and requires violated assumptions to be reported in the text',
  (block ?? '').includes('violated assumption'),
);

/*
 * The empty case matters as much as the full one. With nothing attached the
 * block is null, which is what keeps the original behaviour intact: the section
 * still produces table shells and says the numbers must come from the
 * researcher's own analysis. The change is strictly additive.
 */
check('no attached analyses means no block', buildResultsContext([]), null);
check('and the section knows it has nothing to write from', hasVerifiedResults([]), false);
check('while one analysis is enough', hasVerifiedResults([sampleRun]), true);

/* A reliability result has a different shape and must survive it. */
const alphaRun = {
  id: 'run-2',
  testKey: 'reliability.cronbachAlpha',
  spec: { columns: { items: ['q1', 'q2', 'q3'] } },
  result: {
    alpha: 0.7477422833265936,
    band: 'acceptable',
    itemCount: 5,
    sampleSize: 20,
    warnings: [{ code: 'reverse-coded-item', severity: 'error', columns: ['q5'] }],
  },
} as unknown as typeof sampleRun;

const alphaDescribed = describeRun(alphaRun, 1);
assertTrue('alpha reaches the prompt', alphaDescribed.includes('0.748'));
assertTrue('with its interpretation', alphaDescribed.includes('acceptable'));
assertTrue('and its item count', alphaDescribed.includes('5 items'));
assertTrue(
  'and a reverse-coded item is reported, not buried',
  alphaDescribed.includes('reverse-coded-item'),
);

/*
 * Every reason key the analysis layer can raise must have a message in both
 * languages.
 *
 * This exists because of a failure a user hit in production: uploading a file
 * with the wrong extension produced the literal string
 * "analysis.error.notAWorkbook" on screen. The refusal was correct and the
 * message was a code — useless to a researcher, and worse than useless because
 * it looks like a crash.
 *
 * Checking it turned out to matter more than the one case suggested: 54 of the
 * 66 reason keys had no translation at all. Any of them would have surfaced the
 * same way.
 *
 * The check reads the source rather than a list, so a reason key added tomorrow
 * without a message fails here rather than in front of someone.
 */
const analysisSources = await Promise.all(
  [
    'src/analysis/parse.ts',
    'src/analysis/parse-xlsx.ts',
    'src/analysis/index.ts',
    'src/analysis/reliability.ts',
    'src/analysis/linear-algebra.ts',
    'src/analysis/inference/t-test.ts',
    'src/analysis/inference/anova.ts',
    'src/analysis/inference/correlation.ts',
    'src/analysis/inference/chi-square.ts',
    'src/analysis/inference/regression.ts',
    'src/server/services/dataset.service.ts',
  ].map((path) => readFile(path, 'utf8')),
);

const reasonKeys = [
  ...new Set(
    analysisSources
      .join('\n')
      .match(/'analysis\.[a-zA-Z.]+'/g)
      ?.map((match) => match.slice(1, -1)) ?? [],
  ),
].sort();

assertTrue('reason keys were found in the source', reasonKeys.length > 30);

for (const [language, messages] of [['ar', arMessages], ['en', enMessages]] as const) {
  for (const key of reasonKeys) {
    const message = lookup(messages as Record<string, unknown>, key);
    assertTrue(`${language}: "${key}" has a message`, typeof message === 'string' && message.length > 0);
  }
}


console.log('\ngeneral questions reach the model');

/*
 * These exist because of a bug a user hit: every general question — however
 * plainly worded — produced nothing at all. The agent classified it, announced
 * a plan, and then silently did no work, because `executeStep` had no case for
 * the `respond` step that `planFor` returned.
 *
 * The routing half of the fix is checked here. The distinguishing signal is the
 * verb rather than the noun: "اشرح الانحدار" asks to be taught and "شغّل
 * الانحدار" asks for computation, and both contain the same statistical term.
 */
const generalCases: [string, string][] = [
  ['ما هي عاصمة الأردن؟', 'general.question'],
  ['اشرح لي الانحدار الخطي', 'general.question'],
  ['ما الفرق بين Pearson و Spearman؟', 'general.question'],
  ['متى أستخدم اختبار t؟', 'general.question'],
  ['كيف أفسّر قيمة p؟', 'general.question'],
  ['لماذا نستخدم ألفا كرونباخ؟', 'general.question'],
  ['ما معنى حجم الأثر؟', 'general.question'],
  ['explain linear regression', 'general.question'],
  ['what is the difference between Pearson and Spearman?', 'general.question'],
  ['when should I use a t-test?', 'general.question'],
  ['how do I interpret R squared?', 'general.question'],
];

for (const [message, expected] of generalCases) {
  check(`"${message.slice(0, 40)}" → ${expected}`, classifyByKeyword(message)?.intent, expected);
}

/*
 * The other side of the same boundary: a request to *run* an analysis must not
 * be captured by the explanation rule just because it names the same test.
 */
const computeCases: [string, string][] = [
  ['شغّل تحليل الانحدار المتعدد', 'stats.predict'],
  ['احسب ألفا كرونباخ', 'stats.reliability'],
  ['قارن بين المجموعتين', 'stats.compare'],
  ['اختبار ت للعينات المستقلة', 'stats.compare'],
  ['أريد تنبؤًا بالدرجات', 'stats.predict'],
  ['أريد تحليل PLS-SEM', 'stats.plsSem'],
];

for (const [message, expected] of computeCases) {
  check(`"${message.slice(0, 40)}" stays a computation`, classifyByKeyword(message)?.intent, expected);
}

/*
 * A guard for the specific defect that broke Arabic matching.
 *
 * JavaScript's \b is defined against [A-Za-z0-9_], so every Arabic letter reads
 * as a non-word character and the boundary matches in the wrong places while
 * failing in the right ones. "اشرح لي الانحدار الخطي" was routed to a
 * regression analysis for exactly this reason. No Arabic pattern may use it.
 */
const keywordSource = await readFile('src/agents/keywords.ts', 'utf8');
const arabicWithBoundary = keywordSource
  .split('\n')
  .filter((line) => line.includes('\\b') && /[\u0600-\u06FF]/.test(line));

check('no Arabic pattern relies on a word boundary', arabicWithBoundary.length, 0);

/* Ambiguity is still left to the model rather than guessed at. */
check('a bare name is left to the model', classifyByKeyword('من هو د. عامر زيد القضاة؟'), null);
check('an upload request is left to the model', classifyByKeyword('حلل هذا الملف'), null);

/*
 * The general prompt must keep every integrity rule while dropping the single
 * instruction that made general questions impossible — the academic block opens
 * by telling the model to decline anything unrelated to the user's research.
 */
const general = generalPrompt({ locale: 'ar' });
assertTrue('the general prompt forbids inventing citations', general.includes('Never invent a reference'));
assertTrue('and inventing statistics', general.includes('Never invent research findings'));
assertTrue('and claiming to have run anything', general.includes('Never claim to have conducted'));
assertTrue('and inventing facts about a person', general.includes('Never invent facts about a specific person'));
assertTrue('it instructs the model to state its knowledge limits', general.includes('KNOWLEDGE LIMITS'));
assertTrue('and to ask when a name is ambiguous', general.includes('ask which one'));
assertTrue(
  'but it does not refuse non-academic questions',
  !general.includes('You are not a general-purpose chatbot'),
);
assertTrue('and it names what the product cannot do', general.includes('It cannot yet'));
assertTrue('including PLS-SEM', general.includes('PLS-SEM'));

check('the prompt follows the user into Arabic', generalPrompt({ locale: 'ar' }).includes('Answer in Arabic'), true);
check('and into English', generalPrompt({ locale: 'en' }).includes('Answer in English'), true);
assertTrue(
  'a selected project is mentioned without taking over the question',
  generalPrompt({ locale: 'ar', projectTitle: 'أثر التعلم التعاوني' }).includes('أثر التعلم التعاوني'),
);


console.log('\nknowledge layer: merging and coverage');

/*
 * The parts that can be checked without a network. Live provider behaviour is
 * exercised separately by `npm run test:knowledge`, which needs the internet;
 * everything here is pure logic and runs on every commit.
 */

/* DOI normalisation is what makes cross-provider deduplication work at all. */
check('a bare DOI passes through', normaliseDoi('10.1109/4235.585892'), '10.1109/4235.585892');
check('a DOI URL is unwrapped', normaliseDoi('https://doi.org/10.1109/4235.585892'), '10.1109/4235.585892');
check('the dx.doi.org form too', normaliseDoi('http://dx.doi.org/10.1109/4235.585892'), '10.1109/4235.585892');
check('a doi: prefix is stripped', normaliseDoi('doi:10.1109/4235.585892'), '10.1109/4235.585892');
check('case is normalised — the DOI standard is case-insensitive', normaliseDoi('10.1109/ABC.123'), '10.1109/abc.123');
check('a non-DOI is rejected', normaliseDoi('not-a-doi'), undefined);
check('an empty value is rejected', normaliseDoi(''), undefined);

/*
 * Language from the script, not from provider metadata. A published assessment
 * found OpenAlex over-reports English, which would make Arabic sources
 * invisible in exactly the place a bilingual product cares about.
 */
check('an Arabic title is detected', detectLanguage('التعلم التعاوني وأثره على التحصيل'), 'ar');
check('an English title is detected', detectLanguage('Cooperative learning and achievement'), 'en');
check('a mostly-Arabic title with Latin terms stays Arabic', detectLanguage('أثر الذكاء الاصطناعي AI على التعليم'), 'ar');
check('an empty title is unknown', detectLanguage(''), 'unknown');
check('digits alone are unknown', detectLanguage('12345'), 'unknown');

/*
 * The deduplication that justifies the layer. The same paper arrives from two
 * providers described differently, with one identifier in common — and without
 * this, a researcher asking for sources gets duplicates that look like
 * independent corroboration.
 */
const now = new Date().toISOString();
const fromCrossref = {
  kind: 'academic' as const,
  title: 'Cooperative Learning and Academic Achievement',
  url: 'https://doi.org/10.1016/j.example.2020.01',
  doi: '10.1016/j.example.2020.01',
  language: 'en' as const,
  provider: 'crossref',
  year: 2020,
  citationCount: 120,
  retrievedAt: now,
};
const fromOpenAlex = {
  kind: 'academic' as const,
  // Same paper: different casing, different URL, and it carries the abstract.
  title: 'Cooperative learning and academic achievement',
  url: 'https://europepmc.org/article/example',
  doi: 'https://doi.org/10.1016/J.EXAMPLE.2020.01',
  snippet: 'This study examined the effect of cooperative learning…',
  language: 'en' as const,
  provider: 'openalex',
  year: 2020,
  openAccess: true,
  retrievedAt: now,
};

const deduped = mergeSources({
  sources: [fromCrossref, { ...fromOpenAlex, doi: normaliseDoi(fromOpenAlex.doi) }],
  preferredLanguage: 'en',
});

check('the same paper from two providers becomes one', deduped.sources.length, 1);
check('and the duplicate is counted', deduped.coverage.duplicatesRemoved, 1);
assertTrue(
  'the surviving record gains the abstract the other provider had',
  Boolean(deduped.sources[0]?.snippet),
);
assertTrue(
  'and switches to the open-access link, which the researcher can actually read',
  Boolean(deduped.sources[0]?.url.includes("europepmc")),
);

/*
 * Ranking must not use provider relevance scores: Crossref returned 18.5 and
 * OpenAlex 6254.3 for comparable results in the responses we sampled, so mixing
 * them would let OpenAlex win every time regardless of quality.
 */
const arabicSource = { ...fromCrossref, doi: '10.1/ar', url: 'https://x/ar', title: 'دراسة عربية', language: 'ar' as const, score: 1 };
const englishSource = { ...fromCrossref, doi: '10.1/en', url: 'https://x/en', title: 'An English study', language: 'en' as const, score: 99999 };

const arabicFirst = mergeSources({ sources: [englishSource, arabicSource], preferredLanguage: 'ar' });
check('for an Arabic researcher, the Arabic source ranks first', arabicFirst.sources[0]?.language, 'ar');

const englishFirst = mergeSources({ sources: [arabicSource, englishSource], preferredLanguage: 'en' });
check('and for an English one, the English source does', englishFirst.sources[0]?.language, 'en');

/*
 * The coverage notice — a requirement rather than a nicety. Arabic scholarship
 * is structurally under-indexed because most Arabic journals issue no DOIs, so
 * an all-English result set says more about the index than about the
 * literature. The condition is computed here and the wording is fixed, so it
 * cannot be omitted when true or invented when false.
 */
const englishOnly = mergeSources({
  sources: [englishSource, { ...englishSource, doi: '10.1/en2', url: 'https://x/en2' }],
  preferredLanguage: 'ar',
});
check(
  'an Arabic researcher getting only English results is told so',
  englishOnly.coverage.arabicCoverageNoticeKey,
  'knowledge.coverage.noArabicSources',
);

const thin = mergeSources({
  sources: [arabicSource, englishSource, { ...englishSource, doi: '10.1/en3', url: 'https://x/en3' }],
  preferredLanguage: 'ar',
});
check('and thin Arabic coverage is flagged too', thin.coverage.arabicCoverageNoticeKey, 'knowledge.coverage.fewArabicSources');

check(
  'an English researcher is not given an Arabic-coverage notice',
  mergeSources({ sources: [englishSource], preferredLanguage: 'en' }).coverage.arabicCoverageNoticeKey,
  null,
);

const plenty = mergeSources({
  sources: [arabicSource, { ...arabicSource, doi: '10.1/ar2', url: 'https://x/ar2' }, englishSource],
  preferredLanguage: 'ar',
});
check('and neither is a researcher who got Arabic sources', plenty.coverage.arabicCoverageNoticeKey, null);

/* Both notice keys must exist in both languages — the guard that caught the raw-code bug. */
for (const [language, messages] of [['ar', arMessages], ['en', enMessages]] as const) {
  for (const key of ['knowledge.coverage.noArabicSources', 'knowledge.coverage.fewArabicSources']) {
    assertTrue(
      `${language}: "${key}" has a message`,
      typeof lookup(messages as Record<string, unknown>, key) === 'string',
    );
  }
}

/* Providers report which is usable without a key — the guarantee that a vendor cannot break the product. */

/*
 * A guard against the parameters that broke every Crossref search.
 *
 * `select` and `sort` were added as optimisations and made the provider fail
 * completely: Crossref rejects a request whose `select` names a field it does
 * not consider selectable, and `score` is one. The DOI lookup, which sends
 * neither, kept working — which is how the cause was found.
 *
 * Reading the source rather than mocking a fetch, because what must not come
 * back is the parameter itself.
 */
const crossrefSource = await readFile('src/server/knowledge/providers/crossref.ts', 'utf8');
const searchBlock = crossrefSource.slice(
  crossrefSource.indexOf('async search('),
  crossrefSource.indexOf('private toSource('),
);

assertTrue(
  'the Crossref search does not send `select` — it made every request fail',
  !searchBlock.includes("searchParams.set('select'"),
);
assertTrue(
  'nor `sort` — the default for a query search is already relevance',
  !searchBlock.includes("searchParams.set('sort'"),
);
assertTrue(
  'and a failed response is logged with its body, not just its status',
  crossrefSource.includes('response.text()'),
);

check('Crossref works with nothing configured', new CrossrefProvider().isConfigured(), true);
check('OpenAlex is used with or without a key', new OpenAlexProvider().isConfigured(), true);

console.log(failures === 0 ? '\n✓ all smoke tests passed\n' : `\n✗ ${failures} failing\n`);
process.exit(failures === 0 ? 0 : 1);
