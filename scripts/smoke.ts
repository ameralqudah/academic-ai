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
import {
  canUseModel,
  MODE_KEYS,
  MODES,
  modelsFor,
  parseModelId,
  shouldOfferModelChoice,
} from '@/agents/modes';
import { isPublicHost, isPublicUrl } from '@/server/knowledge/fetch-content';
import { SerperProvider } from '@/server/knowledge/providers/serper';
import { deduplicate, normaliseUrl } from '@/server/research/dedupe';
import { containsMath } from '@/components/chat/markdown';
import {
  buildDraftFromStructure,
  parseProposedStructure,
  STRUCTURE_EXTRACTION_PROMPT,
} from '@/analysis/inference/pls/extract';
import {
  buildSurveyPrompt,
  parseGeneratedSurvey,
  scaleLabels,
} from '@/server/survey/generator';
import { formatSize } from '@/components/files/file-list';
import { validateDraft } from '@/components/agent/pls-builder';
import { resolveReason } from '@/server/http/reasons';
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
  /* The rank-based tests, built and verified against SciPy. */
  'nonparametric.mannWhitney', 'nonparametric.wilcoxon', 'nonparametric.kruskalWallis',
  /* Logistic regression, verified against statsmodels. */
  'regression.logistic',
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
/*
 * Non-parametric tests have left this list — they are built now. What remains
 * is what genuinely is not, and the point of the assertion is unchanged: each
 * is recognised so it can be declined by name rather than misrouted to
 * something that would run.
 */
/*
 * This list is now empty: PLS-SEM and CB-SEM are both built.
 *
 * What the assertion protected was never the specific names — it was the rule
 * that an unbuilt capability is recognised and declined by name rather than
 * misrouted to something that would produce numbers. That rule is checked below
 * against whatever remains planned, so it keeps working as the list changes
 * rather than needing an edit each time something ships.
 */
for (const capability of plannedCapabilities()) {
  check(`${capability.intent} is recognised`, isKnownIntent(capability.intent), true);
  check(`${capability.intent} is not offered as available`, isAvailable(capability.intent), false);
  assertTrue(
    `${capability.intent} can still be classified, so it is declined precisely`,
    classifiableIntents().some((entry) => entry.intent === capability.intent),
  );
}

check('CB-SEM is available', capabilityFor('stats.cbSem').status, 'available');
check(
  'and free, because it makes no model calls',
  capabilityFor('stats.cbSem').units,
  0,
);

/*
 * PLS-SEM has left that list: the engine, assessment, bootstrapping, report and
 * export all exist. It stayed marked `planned` while they did, so the agent
 * declined a capability the product had — the opposite of the failure the list
 * guards against, and just as misleading.
 */
check('PLS-SEM is available', capabilityFor('stats.plsSem').status, 'available');
check(
  'and free, like every other statistical capability, because it calls no model',
  capabilityFor('stats.plsSem').units,
  0,
);

/* The classifier is given planned intents too: declining precisely beats misrouting. */
const classifiable = classifiableIntents().map((entry) => entry.intent);
assertTrue('the classifier can name PLS-SEM even though it cannot run it', classifiable.includes('stats.plsSem'));
check('non-parametric tests are available now', capabilityFor('stats.nonparametric').status, 'available');
check('and logistic regression', capabilityFor('stats.logistic').status, 'available');
check('and cost nothing, like every other statistical capability', capabilityFor('stats.nonparametric').units, 0);
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





console.log('\nthe agent is wired to persistence');

/*
 * A guard for a gap that reached production: every layer of conversation
 * persistence was built and tested — migration, repository, service, routes,
 * twenty-six passing integration assertions — and the agent never called any of
 * it. Refreshing the page emptied the conversation.
 *
 * The integration tests could not catch it because they invoked `recordTurn`
 * themselves and proved it worked. What was missing was not the part but the
 * join between two parts, and a unit test on either side sees nothing wrong.
 *
 * So this reads the orchestrator and asserts the call exists. A crude check,
 * and crude is the point: it fails the moment someone removes the wiring, which
 * is the failure that actually happened.
 */
const orchestratorSource = await readFile('src/agents/orchestrator.ts', 'utf8');

assertTrue(
  'the agent creates a conversation when there is none',
  orchestratorSource.includes('startConversation('),
);
assertTrue(
  'and records each turn',
  orchestratorSource.includes('recordTurn('),
);
assertTrue(
  'and tells the client which conversation this is',
  orchestratorSource.includes("type: 'conversation'"),
);

/*
 * Saving must not be able to replace an answer with an error. A turn that was
 * delivered and then failed to store is a storage problem; showing the user a
 * failure would lose them an answer they had already read.
 */
assertTrue(
  'a failed save is logged rather than thrown',
  orchestratorSource.includes('agent.persistFailed'),
);

/* And the client has to send the id back, or every turn starts a new thread. */
const chatSource = await readFile('src/components/agent/agent-chat.tsx', 'utf8');
assertTrue(
  'the client sends the conversation id with each message',
  chatSource.includes('conversationId: conversationId ?? undefined'),
);
assertTrue(
  'and the page loads a saved thread when the URL names one',
  (await readFile('src/app/[locale]/(app)/chat/page.tsx', 'utf8')).includes('getThread('),
);


/*
 * Two defects that made a recent conversation unopenable, both invisible to a
 * type checker and to every test that did not click the link.
 *
 * The first: next-intl's Link treats a string href as one whole pathname and
 * percent-encodes any `?` inside it, so `/chat?c=abc` became `/chat%3Fc%3Dabc`
 * — a URL matching no route. Query parameters have to be passed as an object.
 *
 * The second: `useState(initialTurns)` reads its argument once. Moving from one
 * conversation to another changed the URL and the props while leaving the first
 * conversation on screen. A React key on the conversation id forces the remount
 * that makes it a different chat.
 */
const sidebarSource = await readFile('src/components/app/sidebar.tsx', 'utf8');

assertTrue(
  'sidebar links pass query parameters as an object, not inside the path',
  !/href={`[^`]*\?/.test(sidebarSource),
);
assertTrue(
  'and a recent conversation links to /chat with a c parameter',
  sidebarSource.includes("pathname: '/chat'") && sidebarSource.includes('query: { c:'),
);

const chatPageSource = await readFile('src/app/[locale]/(app)/chat/page.tsx', 'utf8');
assertTrue(
  'the chat is keyed by conversation so switching threads remounts it',
  chatPageSource.includes('key={thread?.conversation.id'),
);


console.log('\nmodes and model access');

/*
 * One configuration table for every mode, so adding one is an entry rather than
 * a branch in the orchestrator, a case in the route and a condition in the
 * composer. The requirement was explicit: do not duplicate the backend logic per
 * mode.
 */
check('every mode has an entry', MODE_KEYS.length, Object.keys(MODES).length);
assertTrue('and each entry names itself', MODE_KEYS.every((key) => MODES[key].key === key));

check('chat is available', MODES.chat.available, true);
check('academic is available', MODES.academic.available, true);
check('data analysis is available', MODES.dataAnalysis.available, true);

/*
 * Shown and disabled, like the sidebar. Hiding an unbuilt mode leaves a user
 * unable to tell a missing feature from one they failed to find; offering it as
 * working is a lie.
 */
check('web search is not available yet', MODES.webSearch.available, false);
check('deep research is not available yet', MODES.deepResearch.available, false);
assertTrue('and both say why', Boolean(MODES.webSearch.unavailableReason && MODES.deepResearch.unavailableReason));

check('data analysis needs a file', MODES.dataAnalysis.requiresDataset, true);
check('chat does not', MODES.chat.requiresDataset, false);

/* Every intent a mode points at must exist in the capability catalogue. */
for (const key of MODE_KEYS) {
  for (const intent of MODES[key].intents) {
    assertTrue(`mode ${key} points at a real intent (${intent})`, isKnownIntent(intent));
  }
}

/* Model ids carry their provider, so the same model name from two vendors is unambiguous. */
check('a model id parses into provider and model', parseModelId('google:gemini-2.5-pro')?.provider, 'google');
check('and keeps the model name intact', parseModelId('google:gemini-2.5-pro')?.model, 'gemini-2.5-pro');
check('a model name containing a colon survives', parseModelId('openai:gpt-4.1:preview')?.model, 'gpt-4.1:preview');
check('an unknown provider is rejected', parseModelId('mistral:large'), null);
check('a bare model name is rejected', parseModelId('gpt-4.1'), null);
check('an empty model is rejected', parseModelId('openai:'), null);

/*
 * The access rules. Free gets the default and nothing else — a free account
 * choosing the most expensive model available is a bill the product pays and the
 * user does not.
 */
const freeModels = modelsFor('free');
const paidModels = modelsFor('paid');
const adminModels = modelsFor('admin');

assertTrue('free is limited to one model', freeModels.length <= 1);
assertTrue('paid gets at least what free gets', paidModels.length >= freeModels.length);
check('admin and paid see the same set', adminModels.length, paidModels.length);

if (freeModels.length === 1) {
  const free = freeModels[0] as { id: string };
  check('a free user may use their own model', canUseModel('free', free.id), true);
}

/*
 * The check that matters. A model outside the caller's plan must be refused
 * whatever the interface offered, because the request is a POST body and a POST
 * body can say anything.
 */
check('an unconfigured model is refused for everyone', canUseModel('free', 'openai:gpt-5-turbo'), false);
check('and for paid users too', canUseModel('paid', 'openai:gpt-5-turbo'), false);
check('and for admins — the list is what is configured, not what is imagined', canUseModel('admin', 'openai:gpt-5-turbo'), false);
check('a malformed id is refused', canUseModel('paid', 'not-a-model'), false);

/*
 * A dropdown holding one option is furniture that implies a decision the user
 * does not have. The selector appears on its own the day a second provider key
 * is configured, with no code change.
 */
check(
  'the selector is offered only when there is a real choice',
  shouldOfferModelChoice('paid'),
  paidModels.length > 1,
);
assertTrue('and never to a free user, who has one model', !shouldOfferModelChoice('free') || freeModels.length > 1);

/* The route must ask the server, not trust the body. */
const agentRouteSource = await readFile('src/app/api/agent/route.ts', 'utf8');
assertTrue(
  'the agent route validates the requested model server-side',
  agentRouteSource.includes('resolveRequestedModel('),
);


/*
 * Composer behaviours that a type checker cannot see.
 *
 * Stop must be a real cancellation rather than a spinner that hides. Without an
 * AbortController the only escape from a long response is reloading the page,
 * which used to lose the conversation and still leaves the request running on
 * the server.
 */
const composerSource = await readFile('src/components/agent/composer.tsx', 'utf8');
const chatClientSource = await readFile('src/components/agent/agent-chat.tsx', 'utf8');

assertTrue(
  'the request can actually be aborted',
  chatClientSource.includes('AbortController') && chatClientSource.includes('signal: controller.signal'),
);
assertTrue(
  'and pressing stop is not reported as a network error',
  chatClientSource.includes('AbortError'),
);
assertTrue(
  'the mode travels with the request',
  chatClientSource.includes('mode,'),
);
assertTrue(
  'and so does the chosen model, for the server to check',
  chatClientSource.includes('modelId: modelId ?? undefined'),
);

/* Unavailable modes must not be focusable controls that imply they can be entered. */
assertTrue(
  'an unavailable mode is rendered as text, not a button',
  composerSource.includes('option.available ? (') && composerSource.includes('<span'),
);
assertTrue(
  'Enter sends and Shift+Enter breaks the line',
  composerSource.includes("event.key === 'Enter' && !event.shiftKey"),
);
assertTrue(
  'files can be dropped anywhere on the composer',
  composerSource.includes('onDrop') && composerSource.includes('dataTransfer.files'),
);
assertTrue(
  'and the drag highlight counts depth so it does not flicker over children',
  composerSource.includes('dragDepth'),
);


console.log('\nreason keys resolve to sentences');

/*
 * The check that would have caught what a user hit: uploading a file with the
 * wrong extension put the literal string `analysis.error.notAWorkbook` on
 * screen.
 *
 * An earlier test asserted the message *existed* in both files, and it did. What
 * was broken was the resolution — the browser looked the key up, got the key
 * back instead of an error, and displayed it. So this exercises the resolver
 * itself rather than the message files, and asserts the output is not the input.
 */
for (const key of reasonKeys) {
  const resolved = resolveReason(key);
  assertTrue(`"${key}" resolves to English text, not the key`, resolved.en !== key && resolved.en.length > 0);
  assertTrue(`"${key}" resolves to Arabic text, not the key`, resolved.ar !== key && resolved.ar.length > 0);
}

/* The specific message from the report, in both languages. */
const workbook = resolveReason('analysis.error.notAWorkbook');
assertTrue('the workbook message explains what to do', workbook.en.includes('.csv'));
assertTrue('and does so in Arabic too', workbook.ar.includes('CSV'));

/* Placeholders are filled from the params the engine raised. */
const withParams = resolveReason('analysis.ttest.error.tooFewValues', { n: 3, minimum: 5 });
assertTrue('numbers are substituted into the message', withParams.en.includes('3') && withParams.en.includes('5'));
assertTrue('in Arabic as well', withParams.ar.includes('3'));
assertTrue('and no placeholder is left behind', !withParams.en.includes('{n}'));

/* A missing value stays visible rather than leaving a gap in a sentence. */
assertTrue(
  'an unsupplied placeholder is left as written, so a mismatch is visible',
  resolveReason('analysis.ttest.error.tooFewValues', { n: 3 }).en.includes('{minimum}'),
);

/* An unknown key falls back to itself — greppable rather than blank. */
check('an unknown key returns itself', resolveReason('analysis.error.doesNotExist').en, 'analysis.error.doesNotExist');

/*
 * And both services must use the resolver rather than each keeping a table. One
 * had a hand-written map, the other had nothing and passed the key straight
 * through, which is how the two behaved differently for the same failure.
 */
for (const path of ['src/server/services/dataset.service.ts', 'src/server/services/analysis.service.ts']) {
  const source = await readFile(path, 'utf8');
  assertTrue(`${path} resolves reason keys on the server`, source.includes('resolveReason('));
}


console.log('\nvariable role selection');

/*
 * The half of a refusal that was missing.
 *
 * The agent asks which variable is the outcome and refuses to guess, which is
 * right — deciding that is deciding what the study is about. But a real
 * questionnaire export arrived with a hundred and ninety-eight columns and the
 * only way to answer was to type a name that had never been displayed. The
 * refusal was correct and the conversation was a dead end.
 */
const rolePickerSource = await readFile('src/components/agent/role-picker.tsx', 'utf8');
const chatSource2 = await readFile('src/components/agent/agent-chat.tsx', 'utf8');

assertTrue(
  'the picker searches, which is not optional at two hundred columns',
  rolePickerSource.includes("type=\"search\"") && rolePickerSource.includes('filtered'),
);
assertTrue(
  'and searches type and scale as well as name, since kind is often what is remembered',
  rolePickerSource.includes('column.type.toLowerCase()') &&
    rolePickerSource.includes('column.scale.toLowerCase()'),
);
assertTrue(
  'each column shows its type and scale, so an unusable choice is visible before it is made',
  rolePickerSource.includes('type.${column.type}') && rolePickerSource.includes('scale.${column.scale}'),
);
assertTrue(
  'a second outcome replaces the first rather than both being kept',
  rolePickerSource.includes("role === 'dependent' || role === 'grouping'"),
);

/* The columns must reach the client, or there is nothing to choose from. */
assertTrue(
  'the upload keeps the column list rather than only its count',
  chatSource2.includes('fields:') && chatSource2.includes('profile.columns'),
);
assertTrue(
  'a question about roles opens the picker',
  chatSource2.includes('needsRoles(question)'),
);
assertTrue(
  'and the chosen roles travel with the request',
  chatSource2.includes('roles: roles.length > 0 ? roles : undefined'),
);

/*
 * The phrases the agent actually uses, in both languages. These are fixed
 * strings in the orchestrator rather than model output, so matching on them is
 * sound — but if they change, this test is what says so.
 */
const orchestrator = await readFile('src/agents/orchestrator.ts', 'utf8');
assertTrue(
  'the English roles question is still the phrase the client matches',
  orchestrator.includes('Which variable is the outcome'),
);
assertTrue(
  'and the Arabic one',
  orchestrator.includes('أي متغيّر هو التابع'),
);


console.log('\nmessage actions');

/*
 * Copy is a convenience. Edit and regenerate are the interface to the branching
 * that has been in the database since conversations were first persisted — every
 * message has a parent and exactly one child of each parent is active, and until
 * now nothing had ever created a second child.
 *
 * The property that makes both safe: neither destroys anything. The original
 * and everything after it stay on an inactive branch, so a user who preferred
 * what they had can go back.
 */
const actionsSource = await readFile('src/components/agent/message-actions.tsx', 'utf8');
const conversationRoute = await readFile('src/app/api/conversations/[id]/route.ts', 'utf8');
const chatSource3 = await readFile('src/components/agent/agent-chat.tsx', 'utf8');

assertTrue(
  'only a user message offers edit',
  actionsSource.includes("role === 'user' && onEdit"),
);
assertTrue(
  'and only an assistant reply offers regenerate',
  actionsSource.includes("role === 'assistant' && onRegenerate"),
);
assertTrue(
  'branch navigation appears when a message has siblings',
  actionsSource.includes('branch.total > 1'),
);

assertTrue(
  'the route exposes regeneration',
  conversationRoute.includes("z.literal('regenerate')") && conversationRoute.includes('prepareRegeneration('),
);
assertTrue(
  'and it returns the prompt rather than a new answer, since a JSON route cannot stream',
  conversationRoute.includes('prompt: prepared.prompt'),
);

assertTrue(
  'editing goes through the branching endpoint rather than overwriting',
  chatSource3.includes("action: 'editMessage'"),
);
assertTrue(
  'and a regenerated answer is produced by the same agent as any other message',
  chatSource3.includes('void send(json.data.prompt as string'),
);
assertTrue(
  'attaching to the question already in the thread rather than writing it twice',
  chatSource3.includes('regeneratedParentId'),
);
assertTrue(
  'turns after the edited message are dropped before the new answer arrives',
  chatSource3.includes('current.slice(0, index)'),
);

/* Regenerating mid-stream would race the answer still arriving. */
assertTrue(
  'regenerate is offered only once the reply is complete',
  chatSource3.includes("!turn.stages?.some((stage) => stage.status === 'running')"),
);



console.log('\nPLS: one canonical model schema');

/*
 * The architectural rule, checked rather than trusted.
 *
 * The model was defined three times — in the engine, in the builder, and as a
 * zod schema in the API route — with conversion between them on submit. It
 * worked, and it meant a field added to one would leave the others silently
 * behind: the model would validate and then behave unexpectedly, which is the
 * worst shape a bug can take.
 *
 * These assertions read the source, because what must not come back is a second
 * declaration rather than a wrong value.
 */
const schemaSource = await readFile('src/analysis/inference/pls/schema.ts', 'utf8');
const algorithmSource = await readFile('src/analysis/inference/pls/algorithm.ts', 'utf8');
const builderSourceFile = await readFile('src/components/agent/pls-builder.tsx', 'utf8');
const plsRouteSource = await readFile('src/app/api/pls/route.ts', 'utf8');

assertTrue('the canonical schema declares the model', schemaSource.includes('export const plsModelSchema'));

assertTrue(
  'the engine imports the model types rather than declaring them',
  !algorithmSource.includes("export type MeasurementMode = 'reflective'") &&
    algorithmSource.includes("from './schema'"),
);
assertTrue(
  'the builder imports them too',
  !builderSourceFile.includes("export type MeasurementMode = 'reflective'") &&
    builderSourceFile.includes('@/analysis/inference/pls/schema'),
);
assertTrue(
  'and the API route parses with the shared zod schema',
  plsRouteSource.includes('plsModelSchema') && !plsRouteSource.includes('const constructSchema'),
);

/* One implementation of the structural rules, not one per consumer. */
assertTrue(
  'structural validation lives in the schema',
  schemaSource.includes('export function validateModelStructure'),
);
assertTrue(
  'and the engine uses the shared cycle check rather than its own',
  algorithmSource.includes('findModelCycle'),
);

/* The draft-to-model conversion is the only boundary where looseness ends. */
assertTrue('a draft converts to a model', schemaSource.includes('export function draftToModel'));
assertTrue(
  'and a model converts back, for editing a proposal',
  schemaSource.includes('export function modelToDraft'),
);




console.log('\nconversation deletion');

/*
 * A user reported being unable to delete old chats. Everything behind the
 * button existed — the service, the route, the soft delete, twenty-six passing
 * integration assertions — and there was no button. What the sidebar had
 * instead was a `MoreHorizontal` icon that appeared on hover and did nothing,
 * which is worse than no affordance: it promises a menu that was never built.
 *
 * These read the source, because what must not come back is a missing control
 * rather than a wrong value.
 */
const sidebarSource2 = await readFile('src/components/app/sidebar.tsx', 'utf8');

assertTrue(
  'a conversation row offers deletion',
  sidebarSource2.includes('deleteConversation') && sidebarSource2.includes('Trash2'),
);
assertTrue(
  'and calls the endpoint that performs it',
  sidebarSource2.includes("method: 'DELETE'") && sidebarSource2.includes('/api/conversations/'),
);
/*
 * Checked as an import rather than as any mention: the comment above the fix
 * names the icon, which is the point of the comment. A guard that cannot tell
 * an import from an explanation would force the explanation out.
 */
assertTrue(
  'the decorative icon that promised a menu is no longer imported',
  !/^\s*MoreHorizontal,/m.test(sidebarSource2),
);

/*
 * Confirmation before deleting. Not a modal — a reversible action does not earn
 * one — but not a single click either, since the row is small and sits next to
 * the link that opens it.
 */
assertTrue('deletion is confirmed first', sidebarSource2.includes('confirming'));
assertTrue(
  'and the row disappears immediately rather than after a refresh',
  sidebarSource2.includes('setHidden(true)'),
);

/*
 * Reachable by keyboard, not only on hover.
 *
 * Checked as either form: `focus-visible` on the button or `focus-within` on
 * the group that holds it. The first version named one class, and moving the
 * controls into a shared container — which is what made room for renaming —
 * failed a guard that was checking the spelling rather than the property.
 */
assertTrue(
  'the row controls are reachable by keyboard, not hover-only',
  sidebarSource2.includes('focus-visible:opacity-100') ||
    sidebarSource2.includes('focus-within:opacity-100'),
);

/* Every label the control needs must exist in both languages. */
{
  const arSide = JSON.parse(await readFile('messages/ar.json', 'utf8')) as Record<string, unknown>;
  const enSide = JSON.parse(await readFile('messages/en.json', 'utf8')) as Record<string, unknown>;

  const label = (messages: Record<string, unknown>, key: string) =>
    (messages.sidebar as Record<string, unknown> | undefined)?.[key];

  for (const key of ['deleteConversation', 'confirmDelete', 'cancelDelete']) {
    assertTrue(`sidebar.${key} has an Arabic label`, typeof label(arSide, key) === 'string');
    assertTrue(`sidebar.${key} has an English label`, typeof label(enSide, key) === 'string');
  }
}

/*
 * The route archives by default and destroys only when asked. A researcher who
 * deletes a thread and then realises the answer mattered should be able to get
 * it back.
 */
const deleteRouteSource = await readFile('src/app/api/conversations/[id]/route.ts', 'utf8');
assertTrue(
  'the default delete is reversible',
  deleteRouteSource.includes("permanent: z.enum(['true', 'false']).default('false')"),
);




console.log('\nmodel selection reaches the completion');

/*
 * The selection was validated and then thrown away.
 *
 * The route read `await resolveRequestedModel(...)` with no assignment: the
 * model was checked against the user's plan, the check passed, and nothing
 * carried it any further. A paid user could select a model, be told they were
 * entitled to it, and be answered by whichever one the admin setting named.
 *
 * Validation without use is theatre, and it is invisible: the request
 * succeeds, the answer arrives, and only the bill or the output quality would
 * eventually show that a different model produced it.
 */
const agentRouteModel = await readFile('src/app/api/agent/route.ts', 'utf8');
const orchestratorModel = await readFile('src/agents/orchestrator.ts', 'utf8');
const aiServiceModel = await readFile('src/server/services/ai.service.ts', 'utf8');
const registryModel = await readFile('src/ai/registry.ts', 'utf8');

assertTrue(
  'the route keeps the validated model rather than discarding it',
  agentRouteModel.includes('const chosenModel = await resolveRequestedModel'),
);
assertTrue('and passes it to the agent', agentRouteModel.includes('chosenModel,'));
assertTrue('the agent carries it', orchestratorModel.includes('chosenModel?:'));
assertTrue('and hands it to the answer', orchestratorModel.includes('chosenModel: request.chosenModel'));
assertTrue(
  'which passes it to the provider resolver',
  aiServiceModel.includes('resolveProvider(input.chosenModel'),
);
assertTrue(
  'and the resolver builds that provider',
  registryModel.includes('build(chosen.provider, chosen.model)'),
);

/*
 * The plan check happens once, at the boundary. Re-checking inside the agent
 * would create a second place for the rule to drift from the first.
 */
assertTrue(
  'the agent does not re-validate what the route already checked',
  !orchestratorModel.includes('canUseModel'),
);

/*
 * A chosen provider without a key falls through rather than failing. The list
 * is built from configured keys, so this should not occur — but a key removed
 * between the list being served and the request arriving would otherwise turn
 * a working request into an error.
 */
assertTrue(
  'an unconfigured choice degrades instead of failing',
  registryModel.includes('ai.provider.chosenUnavailable'),
);

/* Enforcement, which is the part a client cannot be trusted with. */
check('a free tier gets at most one model', modelsFor('free').length <= 1, true);
check('an unconfigured model is refused to a free user', canUseModel('free', 'openai:gpt-5'), false);
check('and to a paid one', canUseModel('paid', 'openai:gpt-5'), false);
check('and to an admin — the list is what is configured', canUseModel('admin', 'openai:gpt-5'), false);
check('a malformed id is refused', canUseModel('paid', 'garbage'), false);
check('an empty id is refused', canUseModel('paid', ''), false);

/*
 * The selector appears only where there is a real choice. A dropdown holding
 * one option implies a decision the user does not have.
 */
check(
  'no selector without a second provider',
  shouldOfferModelChoice('paid'),
  modelsFor('paid').length > 1,
);

/*
 * The refusal is logged. A request naming a model outside the caller's plan did
 * not come from the interface, which offers only what is permitted — so either
 * something is out of step or someone is probing, and both are worth seeing.
 */
const accessService = await readFile('src/server/services/model-access.service.ts', 'utf8');
assertTrue('a denied model is logged', accessService.includes('model.accessDenied'));
assertTrue(
  'and refused rather than quietly downgraded',
  accessService.includes('not included in your plan'),
);
assertTrue(
  'the tier comes from the plan on record, not from the request',
  accessService.includes('resolvePlanForUser'),
);


console.log('\nsecurity hardening');

/*
 * The DNS gap, closed.
 *
 * The textual check stops `http://10.0.0.1/`. It cannot stop
 * `internal.example.com` resolving to the same place — and a hostname is
 * precisely what someone who gets a page indexed controls. Without resolution,
 * a search result can point the server at an internal service.
 */
check('a name resolving to loopback is refused', await isPublicHost('localhost'), false);
check('and an explicit loopback address', await isPublicHost('127.0.0.1'), false);
check('a private range is refused', await isPublicHost('10.0.0.5'), false);
check('IPv6 loopback is refused', await isPublicHost('::1'), false);
check('a public name is allowed', await isPublicHost('example.com'), true);

/*
 * A name that does not resolve is refused rather than allowed. Treating a
 * resolution failure as permission would let a temporary DNS outage open the
 * check entirely.
 */
check(
  'an unresolvable name is refused, not permitted by default',
  await isPublicHost('this-name-does-not-exist-anywhere-12345.invalid'),
  false,
);

/*
 * Security headers. CSP is the one that turns an injected script from a
 * compromise into a blocked request, and HSTS closes the window where a first
 * plain-HTTP request can be intercepted.
 */
const nextConfig = await readFile('next.config.ts', 'utf8');

assertTrue('a content security policy is set', nextConfig.includes('Content-Security-Policy'));
assertTrue('HSTS is set', nextConfig.includes('Strict-Transport-Security'));
assertTrue('with a long max-age', nextConfig.includes('max-age=63072000'));

assertTrue("plugins are blocked", nextConfig.includes("object-src 'none'"));
assertTrue('the base tag cannot be rewritten', nextConfig.includes("base-uri 'self'"));
assertTrue('forms cannot post elsewhere', nextConfig.includes("form-action 'self'"));
assertTrue('framing is restricted', nextConfig.includes("frame-ancestors 'self'"));
assertTrue(
  'and the browser may only call this origin',
  nextConfig.includes("connect-src 'self'"),
);

/*
 * The one weakening, stated rather than hidden: Next inlines a hydration script
 * without a nonce in this configuration, so `unsafe-inline` is required. The
 * comment says so; a policy that quietly permits it without explanation is how
 * a temporary compromise becomes permanent.
 */
assertTrue(
  'the unsafe-inline requirement is explained rather than silently present',
  nextConfig.includes('hydration'),
);

/* Internal errors must not reach the client. */
const apiWrapper = await readFile('src/server/http/api.ts', 'utf8');
assertTrue(
  'an unexpected error becomes a generic message',
  apiWrapper.includes('Something went wrong on our side'),
);
assertTrue(
  'and is logged with the path rather than the payload',
  apiWrapper.includes("logger.error('api.error'"),
);

console.log('\nfiles page');

/*
 * There was no files page. Datasets were stored, listed by an API nobody
 * called, and reachable only by uploading the same file again — so a researcher
 * who uploaded ten files over a month could see none of them. The sidebar's
 * "Library" pointed at the analysis tool, which inspects one file: a different
 * question from "what do I have".
 */
const filesPage = await readFile('src/app/[locale]/(app)/files/page.tsx', 'utf8');
const fileList = await readFile('src/components/files/file-list.tsx', 'utf8');
const sidebarFiles = await readFile('src/components/app/sidebar.tsx', 'utf8');

assertTrue('the files page lists the user\'s datasets', filesPage.includes('listByUser'));
assertTrue(
  'loaded on the server, so the page does not flash empty',
  !filesPage.includes("'use client'"),
);
assertTrue(
  'project titles are resolved in one pass, not one query per file',
  filesPage.includes('projectIds.map'),
);

assertTrue('the sidebar Library points at the files page', sidebarFiles.includes("href: '/files'"));

/* Each row carries the actions, rather than opening a detail page first. */
assertTrue('a file can be analysed from its row', fileList.includes("pathname: '/chat', query: { dataset:"));
assertTrue('downloaded', fileList.includes('/download'));
assertTrue('and deleted', fileList.includes("method: 'DELETE'"));

/*
 * Deletion is confirmed and says what it costs. A dataset with saved analyses
 * is not the same as an unused upload.
 */
assertTrue('deletion is confirmed', fileList.includes('confirming'));
assertTrue('and states what goes with it', fileList.includes('deleteWarning'));

/* A failed delete is reported rather than leaving the row apparently stuck. */
assertTrue('a delete failure is shown', fileList.includes('error.deleteFailed'));

/* Cleaned copies are marked: deleting an original takes them with it. */
assertTrue('cleaned copies are distinguishable', fileList.includes("dataset.kind === 'CLEANED'"));

/* The empty state points somewhere rather than just being empty. */
assertTrue('an empty library offers a way forward', fileList.includes('empty.action'));

/*
 * "Analyse" must reach the chat with the file attached. Reaching the chat and
 * making the researcher upload it again would defeat the point of the button.
 */
const chatPageFiles = await readFile('src/app/[locale]/(app)/chat/page.tsx', 'utf8');
assertTrue('the chat accepts a dataset id', chatPageFiles.includes('dataset?: string'));
assertTrue('and attaches it on arrival', chatPageFiles.includes('initialFile='));
assertTrue(
  'checking ownership through the repository rather than trusting the id',
  chatPageFiles.includes('findOwnedDataset(dataset, user.id)'),
);
assertTrue(
  'and only the column list travels, not the whole profile',
  chatPageFiles.includes('function columnsOf'),
);

/* Sizes read the way an operating system reports them. */
check('bytes stay bytes', formatSize(512), '512 B');
check('kilobytes round', formatSize(2048), '2 KB');
check('megabytes carry one decimal', formatSize(3 * 1024 * 1024), '3.0 MB');
check('and the boundary is binary, not decimal', formatSize(1024), '1 KB');

/* Every label the page needs must exist in both languages. */
{
  const arFiles = (JSON.parse(await readFile('messages/ar.json', 'utf8')) as Record<string, unknown>).files;
  const enFiles = (JSON.parse(await readFile('messages/en.json', 'utf8')) as Record<string, unknown>).files;

  const flatten = (value: unknown, prefix = ''): string[] =>
    value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
          typeof child === 'string' ? [`${prefix}${key}`] : flatten(child, `${prefix}${key}.`),
        )
      : [];

  const arKeys = flatten(arFiles).sort();
  const enKeys = flatten(enFiles).sort();

  assertTrue('the files namespace has keys', arKeys.length > 10);
  check('and both languages match', arKeys.join(), enKeys.join());
}

console.log('\nsurvey generator');

/*
 * The model writes the items; everything checkable without it is checked here —
 * the parsing, the codes, the scales, and the refusals that stop a malformed
 * reply becoming an instrument for a study the researcher is not running.
 */
const surveyRequest = {
  topic: 'Employee engagement in remote teams',
  constructs: [
    { name: 'Job Satisfaction', definition: 'How content an employee is with their role' },
    { name: 'Team Trust' },
  ],
  itemsPerConstruct: 3,
  scaleType: 'likert-agreement' as const,
  points: 5 as const,
  locale: 'en' as const,
  includeReversed: true,
  includeDemographics: true,
};

/* The prompt must carry the rules that prevent the failures, not describe them. */
const surveyPrompt = buildSurveyPrompt(surveyRequest);

assertTrue('the prompt forbids double-barrelled items', surveyPrompt.includes('One idea per item'));
assertTrue('and leading wording', surveyPrompt.includes('No leading wording'));
assertTrue('and mixing scales within a construct', surveyPrompt.includes('do not mix agreement with frequency'));
assertTrue(
  'and requires reverse items to be marked, since an unmarked one wrecks reliability',
  surveyPrompt.includes('nobody recodes it'),
);
assertTrue('the item count is stated exactly', surveyPrompt.includes('Exactly 3 items per subscale'));
assertTrue('and both constructs are named', surveyPrompt.includes('Job Satisfaction') && surveyPrompt.includes('Team Trust'));

/* Arabic instructions are Arabic, not a translation wrapper around English. */
const arabicPrompt = buildSurveyPrompt({ ...surveyRequest, locale: 'ar' });
assertTrue('the Arabic prompt is written in Arabic', arabicPrompt.includes('كل بند يقيس فكرة واحدة'));
assertTrue('and carries the same reverse-coding warning', arabicPrompt.includes('يُفسد حساب الثبات'));

/* A well-formed reply becomes an instrument. */
const goodReply = JSON.stringify({
  title: 'Remote Team Engagement Survey',
  introduction: 'This survey asks about your experience working remotely. Responses are anonymous and take about five minutes.',
  constructs: [
    {
      name: 'Job Satisfaction',
      items: [
        { text: 'I find my current role fulfilling.', reversed: false },
        { text: 'I would recommend this role to a friend.', reversed: false },
        { text: 'I often think about leaving this position.', reversed: true },
      ],
    },
    {
      name: 'Team Trust',
      items: [
        { text: 'I can rely on my teammates to meet deadlines.', reversed: false },
        { text: 'My teammates keep me informed about their work.', reversed: false },
        { text: 'I hesitate to depend on my colleagues.', reversed: true },
      ],
    },
  ],
});

const survey = parseGeneratedSurvey(goodReply, surveyRequest);

assertTrue('a well-formed reply parses', survey !== null);
check('both subscales are present', survey?.constructs.length, 2);
check('with the requested item count', survey?.constructs[0]?.items.length, 3);

/*
 * Item codes follow the SAT1 convention the PLS builder already recognises, so
 * a researcher who generates an instrument here gets automatic construct
 * matching when they analyse the responses.
 */
check('items are coded by construct', survey?.constructs[0]?.items[0]?.code, 'JS1');
check('and numbered within it', survey?.constructs[0]?.items[2]?.code, 'JS3');
check('the second construct gets its own prefix', survey?.constructs[1]?.items[0]?.code, 'TT1');

/* Reverse items are collected, so the analysis stage can recode them. */
check('reverse-coded items are gathered', survey?.reversedCodes.length, 2);
assertTrue('naming them by code', survey?.reversedCodes.includes('JS3') ?? false);

/* The definition the researcher gave survives onto the subscale. */
check(
  'the construct definition is carried through',
  survey?.constructs[0]?.definition,
  'How content an employee is with their role',
);

/* Scale labels are fixed, not generated, so they read conventionally. */
check('the scale has five points', survey?.scale.labels.length, 5);
check('with conventional wording', survey?.scale.labels[0], 'Strongly disagree');

const arabicLabels = scaleLabels('likert-agreement', 5, 'ar');
check('and the Arabic scale uses the established form', arabicLabels[0], 'لا أوافق بشدة');
assertTrue(
  'frequency and agreement scales differ, since one cannot substitute for the other',
  scaleLabels('likert-frequency', 5, 'en')[0] !== scaleLabels('likert-agreement', 5, 'en')[0],
);

/* Every scale type and length must have labels in both languages. */
for (const type of ['likert-agreement', 'likert-frequency', 'likert-extent', 'likert-quality'] as const) {
  for (const points of [5, 7] as const) {
    for (const language of ['ar', 'en'] as const) {
      const labels = scaleLabels(type, points, language);
      check(`${type} ${points}-point ${language} has the right number of labels`, labels.length, points);
      assertTrue(`and none is empty`, labels.every((label) => label.trim().length > 0));
    }
  }
}

/* Demographics are fixed rather than generated, so results stay comparable. */
assertTrue('demographics are included when asked', (survey?.demographics.length ?? 0) >= 4);
assertTrue(
  'and gender offers a prefer-not-to-say option',
  survey?.demographics
    .find((item) => item.code === 'D1')
    ?.options?.some((option) => option.includes('Prefer not')) ?? false,
);

const withoutDemographics = parseGeneratedSurvey(goodReply, {
  ...surveyRequest,
  includeDemographics: false,
});
check('and omitted when not', withoutDemographics?.demographics.length, 0);

/*
 * The steps before use are specific actions rather than a disclaimer, because
 * "this is a draft" gets read as boilerplate and skipped.
 */
assertTrue('the instrument states what must happen before use', (survey?.beforeUse.length ?? 0) >= 5);
assertTrue(
  'starting with the fact that it is not validated',
  survey?.beforeUse[0]?.includes('not a validated instrument') ?? false,
);
assertTrue(
  'and naming the reverse-coding step',
  survey?.beforeUse.some((step) => step.includes('Recode the reverse-worded')) ?? false,
);

const arabicSurvey = parseGeneratedSurvey(goodReply, { ...surveyRequest, locale: 'ar' });
assertTrue(
  'the Arabic version says the same about validation',
  arabicSurvey?.beforeUse[0]?.includes('ليست أداة مُقنَّنة') ?? false,
);

/* Malformed and mismatched replies are refused rather than half-accepted. */
check('a fenced reply still parses', parseGeneratedSurvey('```json\n' + goodReply + '\n```', surveyRequest) !== null, true);
check('malformed JSON is refused', parseGeneratedSurvey('not json', surveyRequest), null);
check('an empty reply is refused', parseGeneratedSurvey('', surveyRequest), null);

/*
 * A construct the researcher did not ask for means the reply was not followed.
 * Accepting it would hand back an instrument for a different study.
 */
const wrongConstructs = JSON.stringify({
  title: 'x',
  introduction: 'A short introduction for respondents.',
  constructs: [{ name: 'Something Else', items: [{ text: 'An item here.', reversed: false }] }],
});
check('a reply naming the wrong construct is refused', parseGeneratedSurvey(wrongConstructs, surveyRequest), null);

/* A subscale short of the requested count is not usable as specified. */
const tooFewItems = JSON.stringify({
  title: 'x',
  introduction: 'A short introduction for respondents.',
  constructs: [
    { name: 'Job Satisfaction', items: [{ text: 'Only one item here.', reversed: false }] },
    { name: 'Team Trust', items: [{ text: 'Only one item here.', reversed: false }] },
  ],
});
check('a short subscale is refused', parseGeneratedSurvey(tooFewItems, surveyRequest), null);

/* Extra items are trimmed rather than refused: unequal subscales complicate every comparison. */
const tooManyItems = JSON.parse(goodReply) as { constructs: { name: string; items: unknown[] }[] };
(tooManyItems.constructs[0] as { items: unknown[] }).items.push({ text: 'A fourth item.', reversed: false });
const trimmed = parseGeneratedSurvey(JSON.stringify(tooManyItems), surveyRequest);
check('an over-long subscale is trimmed to the requested count', trimmed?.constructs[0]?.items.length, 3);

console.log('\nweb search');

/*
 * The provider follows the same contract as Crossref and OpenAlex, so the
 * merging and failure isolation that already exist apply to web results
 * without a second implementation.
 */
const serper = new SerperProvider();

check('the provider declares itself', serper.name, 'serper');
assertTrue('and handles web sources', serper.kinds.includes('web'));

/*
 * Unconfigured is a normal outcome, not a crash. `getEnv()` throws when the
 * database URL is missing, and reading it eagerly is what broke the knowledge
 * providers and the production build before it was caught there — this is the
 * fourth place that coupling would have bitten.
 */
check('an unconfigured provider reports so rather than throwing', serper.isConfigured(), false);

const unconfigured = await serper.search({ text: 'anything', language: 'en' });
check('and its search returns an outcome', unconfigured.sources.length, 0);
check('with a reason', unconfigured.error?.reasonKey, 'knowledge.error.notConfigured');
check('and no thrown error', typeof unconfigured.provider, 'string');

/*
 * URL filtering. Search results are attacker-influenced — a page can be indexed
 * on purpose — so a server that fetches whatever it is handed can be aimed at
 * internal services.
 */
check('a public URL is allowed', isPublicUrl('https://example.com/article'), true);
check('localhost is refused', isPublicUrl('http://localhost:3000/admin'), false);
check('the loopback address is refused', isPublicUrl('http://127.0.0.1/'), false);
check('private 10.x is refused', isPublicUrl('http://10.0.0.5/internal'), false);
check('private 192.168.x is refused', isPublicUrl('http://192.168.1.1/'), false);
check('private 172.16-31.x is refused', isPublicUrl('http://172.20.0.1/'), false);
check('but 172.32.x is public', isPublicUrl('http://172.32.0.1/'), true);
check('cloud metadata is refused', isPublicUrl('http://169.254.169.254/latest/meta-data/'), false);
check('Google metadata by name is refused', isPublicUrl('http://metadata.google.internal/'), false);
check('a file URL is refused', isPublicUrl('file:///etc/passwd'), false);
check('a malformed URL is refused', isPublicUrl('not a url'), false);

/*
 * The mode is available when a key is configured and not before. Hard-coding
 * either way is wrong: `true` offers a mode that fails on first use, `false`
 * hides it after someone configured it.
 */
check('web search is unavailable without a key', MODES.webSearch.available, false);
check('and says why', MODES.webSearch.unavailableReason, 'mode.unavailable.webSearchKey');
check('deep research follows the same key', MODES.deepResearch.available, false);

/* Both modes point at real intents now, rather than at nothing. */
assertTrue('web search has an intent', MODES.webSearch.intents.includes('research.web'));
assertTrue('deep research has one', MODES.deepResearch.intents.includes('research.deep'));
check('and both are in the catalogue', capabilityFor('research.web').status, 'available');
check('including deep research', capabilityFor('research.deep').status, 'available');

/*
 * Deep research is priced above a single search because it runs many. A figure
 * equal to one search would let a workflow costing eight model calls be metered
 * as one.
 */
assertTrue(
  'deep research costs more than a single search',
  capabilityFor('research.deep').units > capabilityFor('research.web').units,
);

/* The sidebar must not still say "Soon" for a feature that ships. */
const sidebarAfter = await readFile('src/components/app/sidebar.tsx', 'utf8');
assertTrue(
  'the sidebar no longer marks web search as coming soon',
  !/key: 'webSearch'[^}]*soon: true/.test(sidebarAfter),
);
assertTrue(
  'nor deep research',
  !/key: 'deepResearch'[^}]*soon: true/.test(sidebarAfter),
);

/* The key must never reach the client bundle. */
const webRoute = await readFile('src/app/api/web-search/route.ts', 'utf8');
assertTrue('the route is server-side', !webRoute.includes("'use client'"));
assertTrue(
  'and the provider reads the key from the server environment only',
  (await readFile('src/server/knowledge/providers/serper.ts', 'utf8')).includes('getEnv().SERPER_API_KEY'),
);
assertTrue(
  'the search service is never imported by a client component',
  !(await readFile('src/components/agent/agent-chat.tsx', 'utf8')).includes('web-search.service'),
);

/*
 * Provider failures map to distinct reasons, because the three cases need
 * different responses: rate-limited means wait, unauthorised means the key is
 * wrong, a timeout means retry.
 */
const serperSource = await readFile('src/server/knowledge/providers/serper.ts', 'utf8');
assertTrue('a rate limit is distinguished', serperSource.includes('knowledge.error.rateLimited'));
assertTrue('an auth failure is distinguished', serperSource.includes('knowledge.error.unauthorised'));
assertTrue('a timeout is distinguished', serperSource.includes('knowledge.error.timeout'));
assertTrue(
  'and the response body is logged, not just the status',
  serperSource.includes('body: body.slice'),
);

/*
 * Google's answer box is deliberately not returned: it is Google's own summary
 * rather than a source anyone can cite, and including it would put an
 * unattributable claim into a set presented as evidence.
 */
assertTrue(
  'the answer box is excluded from sources',
  serperSource.includes('answer box and knowledge graph are deliberately ignored') ||
    !serperSource.includes('payload.answerBox?.snippet'),
);

/* The answer must be grounded and must say what these sources are. */
const aiSource = await readFile('src/server/services/ai.service.ts', 'utf8');
assertTrue(
  'the answering prompt demands citations',
  aiSource.includes('Cite the source number after each claim'),
);
assertTrue(
  'forbids adding anything outside the sources',
  aiSource.includes('Never state anything that is not in the sources'),
);
assertTrue(
  'and says web sources are not peer-reviewed references',
  aiSource.includes('rather than peer-reviewed references'),
);



/*
 * The mode list must carry availability, and this is checked because it was
 * once missing.
 *
 * The route sent only the available modes and omitted the `available` field
 * entirely. The composer reads that field to decide what to disable; finding it
 * undefined on every entry, it marked all of them unavailable — including the
 * three that worked. The symptom reported was "everything says Soon", and no
 * type error and no test caught it, because the shape was valid and the
 * meaning was not.
 */
const agentRouteModes = await readFile('src/app/api/agent/route.ts', 'utf8');

assertTrue(
  'the agent route sends every mode, not only the available ones',
  agentRouteModes.includes('MODE_KEYS.map((key) => MODES[key]).map'),
);
assertTrue(
  'and each carries its availability',
  agentRouteModes.includes('available: mode.available'),
);
assertTrue(
  'and the reason when it is unavailable',
  agentRouteModes.includes('unavailableReason: mode.unavailableReason'),
);

/*
 * The badge must say something actionable. "Soon" is false once a feature is
 * built and waiting on configuration, and it tells the person nothing they can
 * do about it.
 */
const composerModes = await readFile('src/components/agent/composer.tsx', 'utf8');

assertTrue(
  'an unavailable mode explains itself with the server\'s reason',
  composerModes.includes('option.unavailableReason'),
);
assertTrue(
  'and the badge no longer claims the feature is merely coming',
  !composerModes.includes("{t('soon')}"),
);

/* Every mode's reason key must resolve, or the tooltip shows a raw identifier. */
{
  const arAll = JSON.parse(await readFile('messages/ar.json', 'utf8')) as Record<string, unknown>;
  const enAll = JSON.parse(await readFile('messages/en.json', 'utf8')) as Record<string, unknown>;

  const resolve = (messages: Record<string, unknown>, path: string) =>
    path.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      messages,
    );

  for (const key of MODE_KEYS) {
    const reason = MODES[key].unavailableReason;
    if (!reason) continue;

    assertTrue(`${key}: the unavailable reason resolves in Arabic`, typeof resolve(arAll, reason) === 'string');
    assertTrue(`${key}: and in English`, typeof resolve(enAll, reason) === 'string');
  }
}


/*
 * Both search modes must record what they produced.
 *
 * They bypass the agent deliberately — so a phrasing the classifier reads as a
 * general question cannot answer from memory instead of sources — and in going
 * around it they went around persistence too. A refresh emptied a three-minute
 * research run from the thread: the same defect the agent had before it was
 * wired up, reappearing in the paths built to avoid the agent.
 */
const webService = await readFile('src/server/services/web-search.service.ts', 'utf8');
const researchService2 = await readFile('src/server/services/deep-research.service.ts', 'utf8');

assertTrue('web search records the turn', webService.includes('recordTurn('));
assertTrue(
  'with the sources, so a reopened thread redraws them',
  webService.includes("kind: 'webSources'"),
);
assertTrue('deep research records its report', researchService2.includes('recordTurn('));
assertTrue(
  'with the full report payload',
  researchService2.includes("kind: 'research'"),
);

/*
 * A failure to save must not lose an answer that was delivered. The user read
 * it; a storage problem afterwards is not a reason to replace it with an error.
 */
assertTrue(
  'a failed save is logged rather than thrown, in web search',
  webService.includes('webSearch.persistFailed'),
);
assertTrue(
  'and in deep research',
  researchService2.includes('deepResearch.persistFailed'),
);

/*
 * Both are metered. The catalogue prices them at one and five units, and
 * nothing was deducting either — a free account could run unlimited deep
 * research, each costing fifteen searches.
 */
assertTrue('web search is metered', webService.includes("recordSimple(input.userId, 'TOOL_RUN'"));
assertTrue('deep research is metered', researchService2.includes("recordSimple(job.userId, 'TOOL_RUN'"));
assertTrue(
  'and quota is checked before the credit is spent, not after',
  webService.includes('await assertCanUseAI'),
);

/*
 * An existing metric is reused rather than a new one introduced: adding a
 * metric would change what plans limit, which is a pricing decision and not
 * one to make silently.
 */
assertTrue(
  'no new usage metric was invented',
  !webService.includes("'WEB_SEARCH'") && !researchService2.includes("'DEEP_RESEARCH'"),
);

/*
 * The first search in a new chat must have somewhere to be recorded. Without
 * this the first one vanishes on refresh and the second one onward persists,
 * which is worse than neither working.
 */
const chatClient2 = await readFile('src/components/agent/agent-chat.tsx', 'utf8');
assertTrue(
  'a conversation is created when the mode runs in a new chat',
  chatClient2.includes('ensureConversation'),
);
assertTrue(
  'and the URL follows it, so a refresh mid-search returns to the thread',
  chatClient2.includes("url.searchParams.set('c', id)"),
);
assertTrue(
  'both modes send the conversation id',
  chatClient2.includes('conversationId: thread ?? undefined'),
);

console.log('\ndeep research');

/*
 * The workflow, tested where it can be tested without a network: deduplication,
 * URL normalisation, and the structural guarantees that make the report
 * trustworthy.
 *
 * The model calls are not exercised here — they need a provider key — but what
 * they are *told* is, because the instructions are what stand between a cited
 * report and a fluent invention.
 */

/*
 * Five sub-questions on one topic return heavily overlapping results. Without
 * deduplication the report cites the same paper as [3], [11] and [17], which
 * reads as three studies agreeing.
 */
{
  const now = new Date().toISOString();
  const source = (url: string, doi?: string, extra: Record<string, unknown> = {}) => ({
    kind: 'academic' as const,
    title: 'A study',
    url,
    doi,
    language: 'en' as const,
    provider: 'test',
    retrievedAt: now,
    ...extra,
  });

  const { unique, removed } = deduplicate([
    source('https://a.com/1', '10.1/abc'),
    source('https://b.com/mirror', '10.1/ABC'),
    source('https://c.com/other', '10.2/xyz'),
  ]);

  check('the same DOI in different places is one source', unique.length, 2);
  check('and the duplicate is counted', removed, 1);

  const byUrl = deduplicate([
    source('https://example.com/page'),
    source('https://www.example.com/page/'),
    source('https://example.com/page?utm_source=twitter'),
    source('https://example.com/different'),
  ]);

  check('www, trailing slash and campaign parameters are one page', byUrl.unique.length, 2);
}

check('URLs normalise past www', normaliseUrl('https://www.example.com/x'), 'example.com/x');
check('and a trailing slash', normaliseUrl('https://example.com/x/'), 'example.com/x');
check('and campaign parameters', normaliseUrl('https://example.com/x?utm_source=a'), 'example.com/x');
assertTrue(
  'but a real query parameter is kept, since it changes the page',
  normaliseUrl('https://example.com/search?q=term').includes('q=term'),
);

/*
 * The instructions are the guardrail. A model asked to research and write in one
 * pass blends what it read with what it knows, invisibly — which is the failure
 * this whole workflow is built to avoid.
 */
const aiForResearch = await readFile('src/server/services/ai.service.ts', 'utf8');

assertTrue('planning asks for searchable sub-questions', aiForResearch.includes('searchable on its own'));
assertTrue(
  'extraction requires a source number on every sentence',
  aiForResearch.includes('Every sentence ends with its source number'),
);
assertTrue(
  'and forbids adding anything',
  aiForResearch.includes('Add nothing that is not in the sources'),
);
assertTrue(
  'disagreements are surfaced rather than smoothed over',
  aiForResearch.includes('Where sources disagree'),
);
assertTrue(
  'gap detection is told not to invent gaps to fill a list',
  aiForResearch.includes('Do not invent a gap'),
);
assertTrue(
  'and to write nothing when the evidence is sufficient',
  aiForResearch.includes('If the evidence is sufficient, write nothing'),
);

/*
 * The limitations section is required verbatim. A report that omits its own
 * gaps is the thing that makes an unreliable review look like a reliable one.
 */
assertTrue(
  'the report must state its gaps verbatim',
  aiForResearch.includes('verbatim') && aiForResearch.includes('do not omit or soften'),
);
assertTrue(
  'and must distinguish academic from web sources',
  aiForResearch.includes('Distinguish academic sources from web sources'),
);

/* The pipeline is a workflow, not one prompt. */
const pipelineSource = await readFile('src/server/research/pipeline.ts', 'utf8');

for (const stage of [
  'planResearch',
  'searchAcademic',
  'deduplicate',
  'fetchSources',
  'extractEvidence',
  'identifyGaps',
  'synthesiseReport',
]) {
  assertTrue(`the pipeline runs ${stage}`, pipelineSource.includes(stage));
}

assertTrue(
  'it searches both academic and web sources',
  pipelineSource.includes('searchAcademic') && pipelineSource.includes('web.search'),
);
assertTrue('progress is reported through the run', pipelineSource.includes('onProgress'));
assertTrue('and it can be cancelled between stages', pipelineSource.includes('shouldStop'));

/*
 * Bounded at one extra round. The questions a first pass could not answer are
 * usually questions the sources do not contain, and searching again finds the
 * same sources — so what remains is reported as a gap.
 */
assertTrue('gap searching is bounded', pipelineSource.includes('GAP_ROUNDS'));

/* Long-running work must not sit in a request. */
const researchService = await readFile('src/server/services/deep-research.service.ts', 'utf8');
assertTrue('research runs as a background job', researchService.includes('jobsRepo.create'));
assertTrue('reusing the existing jobs table', researchService.includes("kind: 'research.deep'"));
assertTrue(
  'and refuses to run without a web provider rather than degrading silently',
  researchService.includes('isWebSearchConfigured()'),
);
assertTrue(
  'a floating promise carries a rejection handler',
  researchService.includes('.catch((error: unknown)'),
);

/* The route returns a job, never a report — the work outlives the request. */
const researchRoute = await readFile('src/app/api/deep-research/route.ts', 'utf8');
assertTrue('the route returns a job id', researchRoute.includes('job: { id: job.id'));
assertTrue('with 202, since the work is not done', researchRoute.includes('status: 202'));
assertTrue(
  'and is rate limited, because one run costs fifteen searches',
  researchRoute.includes('rateLimit'),
);


/*
 * The two modes reach their own endpoints rather than the agent.
 *
 * The agent classifies an intent and runs a capability; these are a capability
 * the user already chose by selecting the mode. Routing them through
 * classification would let a phrasing the classifier reads as a general
 * question answer from the model's memory instead of from sources — which is
 * exactly what selecting the mode was meant to prevent.
 */
const chatClient = await readFile('src/components/agent/agent-chat.tsx', 'utf8');

assertTrue(
  'web search mode calls the web search endpoint',
  chatClient.includes("mode === 'webSearch'") && chatClient.includes("fetch('/api/web-search'"),
);
assertTrue(
  'deep research mode starts a job',
  chatClient.includes("mode === 'deepResearch'") && chatClient.includes("fetch('/api/deep-research'"),
);
assertTrue(
  'and polls it, since it runs for minutes',
  chatClient.includes('pollResearch'),
);
assertTrue(
  'showing the stage rather than only a percentage',
  chatClient.includes('stage.${researchJob.stage'),
);
assertTrue('and offering cancellation', chatClient.includes("method: 'DELETE'"));

/*
 * Sources are shown with their numbers so a reader can follow a citation, and
 * with whether the page was read in full — an answer resting on two lines is
 * weaker than one resting on the page.
 */
assertTrue('web sources are rendered', chatClient.includes('function WebSources'));
assertTrue('with their citation numbers', chatClient.includes('[{source.index}]'));
assertTrue('and whether each was read in full', chatClient.includes('readInFull'));
assertTrue('the research report is rendered', chatClient.includes('function ResearchReport'));
assertTrue(
  'with each source labelled academic or web',
  chatClient.includes('kind.${source.kind}'),
);

/* An empty result is an outcome, not an error. */
assertTrue('no results is stated rather than raised as an error', chatClient.includes("tw('noResults')"));

/* Every message key the two features raise must exist in both languages. */
{
  const arWeb = (JSON.parse(await readFile('messages/ar.json', 'utf8')) as Record<string, unknown>).web;
  const enWeb = (JSON.parse(await readFile('messages/en.json', 'utf8')) as Record<string, unknown>).web;

  const flatten = (value: unknown, prefix = ''): string[] =>
    value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
          typeof child === 'string' ? [`${prefix}${key}`] : flatten(child, `${prefix}${key}.`),
        )
      : [];

  const arKeys = flatten(arWeb).sort();
  const enKeys = flatten(enWeb).sort();

  assertTrue('the web namespace has keys', arKeys.length > 15);
  check('and both languages have the same set', arKeys.join(), enKeys.join());
}

/*
 * Every pipeline stage must have a label, or a user watching a three-minute run
 * sees a raw identifier where a description should be.
 */
{
  const stages = [
    'planning', 'searching', 'collecting', 'reading',
    'extracting', 'checking-gaps', 'searching-gaps', 'synthesising', 'done',
  ];

  const arMessages = JSON.parse(await readFile('messages/ar.json', 'utf8')) as Record<string, unknown>;
  const enMessages = JSON.parse(await readFile('messages/en.json', 'utf8')) as Record<string, unknown>;

  const stageLabel = (messages: Record<string, unknown>, stage: string) =>
    ((messages.web as Record<string, unknown> | undefined)?.stage as Record<string, unknown> | undefined)?.[stage];

  for (const stage of stages) {
    assertTrue(`the "${stage}" stage has an Arabic label`, typeof stageLabel(arMessages, stage) === 'string');
    assertTrue(`and an English one`, typeof stageLabel(enMessages, stage) === 'string');
  }
}

console.log('\nPLS conversational extraction');

/*
 * Reading a model out of a sentence. The language model proposes; the
 * researcher confirms. What is tested here is everything after the model
 * replies — the parsing and the column matching — because that is where a wrong
 * answer becomes a model someone might run without noticing.
 */
check(
  'a well-formed reply parses',
  parseProposedStructure('{"constructs":["Satisfaction","Loyalty"],"paths":[{"from":"Satisfaction","to":"Loyalty"}]}')
    ?.constructs.length,
  2,
);

/* Models wrap JSON in a fence despite being told not to. */
check(
  'a fenced reply parses',
  parseProposedStructure('```json\n{"constructs":["A","B"],"paths":[{"from":"A","to":"B"}]}\n```')?.paths.length,
  1,
);

check(
  'and one with surrounding prose',
  parseProposedStructure('Here is the model:\n{"constructs":["A","B"],"paths":[{"from":"A","to":"B"}]}\nHope that helps.')
    ?.constructs[0],
  'A',
);

/*
 * A path naming a construct that was not listed means the model misread the
 * sentence. The path is dropped rather than the construct being invented —
 * silently adding it would put something in the researcher's model that they
 * never mentioned.
 */
check(
  'a path to an unlisted construct is dropped',
  parseProposedStructure(
    '{"constructs":["A","B"],"paths":[{"from":"A","to":"B"},{"from":"B","to":"C"}]}',
  )?.paths.length,
  1,
);

check('a reply with one construct is rejected', parseProposedStructure('{"constructs":["A"],"paths":[]}'), null);
check('a reply with no usable path is rejected', parseProposedStructure('{"constructs":["A","B"],"paths":[]}'), null);
check('a self-path is dropped, leaving nothing', parseProposedStructure('{"constructs":["A","B"],"paths":[{"from":"A","to":"A"}]}'), null);
check('malformed JSON is rejected', parseProposedStructure('not json at all'), null);
check('an empty reply is rejected', parseProposedStructure(''), null);

/* Column matching, which is the guess rather than the reading. */
{
  const columns = [
    'satisfaction_1', 'satisfaction_2', 'satisfaction_3',
    'loyalty_1', 'loyalty_2',
    'age', 'gender',
  ];

  const extracted = buildDraftFromStructure(
    { constructs: ['Satisfaction', 'Loyalty'], paths: [{ from: 'Satisfaction', to: 'Loyalty' }] },
    columns,
  );

  check('indicators are matched by name', extracted.matchedIndicators.Satisfaction?.length, 3);
  check('for both constructs', extracted.matchedIndicators.Loyalty?.length, 2);
  check('and unrelated columns are left alone', extracted.unmatchedConstructs.length, 0);
  assertTrue(
    'demographic columns are not swept in',
    !(extracted.matchedIndicators.Satisfaction ?? []).includes('age'),
  );
}

/* Abbreviated item series — the common export convention. */
{
  const extracted = buildDraftFromStructure(
    { constructs: ['Satisfaction', 'Performance'], paths: [{ from: 'Satisfaction', to: 'Performance' }] },
    ['SAT1', 'SAT2', 'SAT3', 'PERF1', 'PERF2', 'SATURATION_LEVEL'],
  );

  check('a SAT1/SAT2 series is matched', extracted.matchedIndicators.Satisfaction?.length, 3);
  /*
   * The prefix rule requires digits after the abbreviation, which is what keeps
   * "SATURATION_LEVEL" out of "Satisfaction" — a column that starts with the
   * same four letters and measures something else entirely.
   */
  assertTrue(
    'a similarly-spelled unrelated column is not',
    !(extracted.matchedIndicators.Satisfaction ?? []).includes('SATURATION_LEVEL'),
  );
}

/*
 * When nothing matches — the ordinary case on real data, where items are called
 * Q17_3 — the construct is kept and reported as unmatched. Dropping it would
 * leave the researcher working out what went missing.
 */
{
  const extracted = buildDraftFromStructure(
    { constructs: ['Job Satisfaction', 'Turnover Intention'], paths: [{ from: 'Job Satisfaction', to: 'Turnover Intention' }] },
    ['Q1', 'Q2', 'Q3', 'Q4', 'V17', 'V18'],
  );

  check('both constructs are reported unmatched', extracted.unmatchedConstructs.length, 2);
  check('but both still appear in the draft', extracted.draft.constructs.length, 2);
  check('with no indicators guessed', extracted.draft.constructs[0]?.indicators.length, 0);
  check('and the paths preserved', extracted.draft.paths.length, 1);
}

/* A column already claimed by one construct is not given to another. */
{
  const extracted = buildDraftFromStructure(
    { constructs: ['Trust', 'Trustworthiness'], paths: [{ from: 'Trust', to: 'Trustworthiness' }] },
    ['trust_1', 'trust_2', 'trustworthiness_1'],
  );

  const all = Object.values(extracted.matchedIndicators).flat();
  check('no column is assigned twice', all.length, new Set(all).size);
}

/* Arabic construct names match Arabic column names. */
{
  const extracted = buildDraftFromStructure(
    { constructs: ['الرضا', 'الولاء'], paths: [{ from: 'الرضا', to: 'الولاء' }] },
    ['الرضا_1', 'الرضا_2', 'الولاء_1', 'العمر'],
  );

  check('Arabic indicators are matched', extracted.matchedIndicators['الرضا']?.length, 2);
  assertTrue('and unrelated Arabic columns are not', !(extracted.matchedIndicators['الرضا'] ?? []).includes('العمر'));
}

/*
 * The proposal must reach the researcher as a proposal. This asserts the route
 * says so rather than returning something the client might run directly.
 */
const extractRoute = await readFile('src/app/api/pls/extract/route.ts', 'utf8');
assertTrue('the route marks its output as requiring confirmation', extractRoute.includes('requiresConfirmation: true'));
assertTrue('and does not estimate anything itself', !extractRoute.includes('estimatePls') && !extractRoute.includes('runPls'));

/* The prompt must state the direction rules, which are what a model gets wrong. */
assertTrue(
  'the extraction prompt covers reversed phrasing',
  STRUCTURE_EXTRACTION_PROMPT.includes('depends on') && STRUCTURE_EXTRACTION_PROMPT.includes('reverses'),
);
assertTrue(
  'and mediation, so A→B→C does not become A→C',
  STRUCTURE_EXTRACTION_PROMPT.includes('mediator'),
);

console.log('\nPLS model builder');

/*
 * The builder validates the same rules the engine does, and that duplication is
 * deliberate. The server must check independently — a client check is a
 * convenience, never a guarantee — but catching a cycle before a minute of
 * bootstrap resampling is the difference between an instant correction and a
 * minute spent learning something knowable immediately.
 *
 * This version can also be more forgiving: it reports every problem at once,
 * where the engine throws on the first.
 */
const draft = (constructs: { name: string; indicators: string[] }[], paths: { from: string; to: string }[]) => ({
  constructs: constructs.map((construct, index) => ({
    id: `c${index}`,
    name: construct.name,
    indicators: construct.indicators,
    mode: 'reflective' as const,
  })),
  paths,
});

const issueKeys = (model: Parameters<typeof validateDraft>[0]) =>
  validateDraft(model).map((issue) => issue.key);

check(
  'a sound model has no issues',
  issueKeys(
    draft(
      [
        { name: 'A', indicators: ['a1', 'a2'] },
        { name: 'B', indicators: ['b1', 'b2'] },
      ],
      [{ from: 'A', to: 'B' }],
    ),
  ).length,
  0,
);

assertTrue(
  'a single construct is refused',
  issueKeys(draft([{ name: 'A', indicators: ['a1'] }], [])).includes('tooFewConstructs'),
);

assertTrue(
  'a construct with no indicators is caught',
  issueKeys(
    draft(
      [
        { name: 'A', indicators: [] },
        { name: 'B', indicators: ['b1'] },
      ],
      [{ from: 'A', to: 'B' }],
    ),
  ).includes('noIndicators'),
);

assertTrue(
  'an unnamed construct is caught',
  issueKeys(
    draft(
      [
        { name: '', indicators: ['a1'] },
        { name: 'B', indicators: ['b1'] },
      ],
      [],
    ),
  ).includes('unnamedConstruct'),
);

assertTrue(
  'a duplicate name is caught',
  issueKeys(
    draft(
      [
        { name: 'A', indicators: ['a1'] },
        { name: 'A', indicators: ['b1'] },
      ],
      [],
    ),
  ).includes('duplicateName'),
);

/*
 * An indicator in two constructs makes their scores partly the same variable,
 * which guarantees they correlate and destroys discriminant validity by
 * construction rather than by finding.
 */
assertTrue(
  'an indicator in two constructs is caught',
  issueKeys(
    draft(
      [
        { name: 'A', indicators: ['x1', 'x2'] },
        { name: 'B', indicators: ['x2', 'b1'] },
      ],
      [{ from: 'A', to: 'B' }],
    ),
  ).includes('sharedIndicator'),
);

assertTrue(
  'a model with no paths is caught',
  issueKeys(
    draft(
      [
        { name: 'A', indicators: ['a1'] },
        { name: 'B', indicators: ['b1'] },
      ],
      [],
    ),
  ).includes('noPaths'),
);

/*
 * The cycle check matters most: PLS iterates on a cyclic model, converges, and
 * returns coefficients that cannot be interpreted causally. Nothing downstream
 * would notice.
 */
assertTrue(
  'a two-step cycle is caught',
  issueKeys(
    draft(
      [
        { name: 'A', indicators: ['a1'] },
        { name: 'B', indicators: ['b1'] },
      ],
      [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' },
      ],
    ),
  ).includes('cycle'),
);

assertTrue(
  'and a longer one',
  issueKeys(
    draft(
      [
        { name: 'A', indicators: ['a1'] },
        { name: 'B', indicators: ['b1'] },
        { name: 'C', indicators: ['c1'] },
      ],
      [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'C', to: 'A' },
      ],
    ),
  ).includes('cycle'),
);

/* A branching model is not a cycle, and must not be reported as one. */
check(
  'a model where two paths converge is fine',
  issueKeys(
    draft(
      [
        { name: 'A', indicators: ['a1'] },
        { name: 'B', indicators: ['b1'] },
        { name: 'C', indicators: ['c1'] },
      ],
      [
        { from: 'A', to: 'C' },
        { from: 'B', to: 'C' },
      ],
    ),
  ).length,
  0,
);

/* Every issue the builder can raise must have a message in both languages. */
/*
 * Read from the schema, which is where the validation moved.
 *
 * This check previously scanned the builder, and when the logic moved it found
 * nothing and asserted nothing — passing while checking zero keys. The count
 * assertion below is what turns that silent hole into a failure.
 */
const issueSource = await readFile('src/analysis/inference/pls/schema.ts', 'utf8');
const raisedKeys = [...new Set(issueSource.match(/key: '[a-zA-Z]+'/g) ?? [])].map((match) =>
  match.slice(6, -1),
);

assertTrue('the issue keys were actually found in the source', raisedKeys.length >= 7);

for (const [language, messages] of [['ar', arMessages], ['en', enMessages]] as const) {
  for (const key of raisedKeys) {
    assertTrue(
      `${language}: the builder issue "${key}" has a message`,
      typeof lookup(messages as Record<string, unknown>, `pls.issue.${key}`) === 'string',
    );
  }
}

console.log('\nmaths detection');

/*
 * This predicate decides whether a quarter of a megabyte of KaTeX is
 * downloaded, so both kinds of mistake cost something real: a miss renders an
 * equation as literal dollar signs, and a false positive loads the engine for a
 * sentence about money.
 *
 * The money case is the one a naive check gets wrong. "$50" and "between $5 and
 * $10" are prices, and treating the dollars as delimiters would both load
 * KaTeX and render the text between two prices as an equation.
 */
const mathCases: [string, boolean][] = [
  ['The value is $x$ in the model.', true],
  ['We use $\\alpha = 0.05$ as the threshold.', true],
  ['$$\\sum_{i=1}^{n} x_i$$', true],
  ['Inline $E = mc^2$ and text after.', true],
  ['بالعربية أيضًا $\\beta$ تعمل.', true],

  ['The licence costs $50 per month.', false],
  ['Prices range between $5 and $10.', false],
  ['No maths here at all.', false],
  ['A code block with `const price = $5;` inside.', false],
  ['', false],
  ['Just a lone $ sign.', false],
];

for (const [content, expected] of mathCases) {
  check(
    `${expected ? 'maths' : 'no maths'}: "${content.slice(0, 40)}"`,
    containsMath(content),
    expected,
  );
}

/*
 * The two renderers must stay interchangeable. If the maths chunk ever styled
 * tables or code differently from the plain one, a message would change
 * appearance purely because it happened to contain an equation.
 */
const markdownSource = await readFile('src/components/chat/markdown-math.tsx', 'utf8');
assertTrue(
  'the maths renderer shares the plain one\'s components rather than duplicating them',
  markdownSource.includes('markdownComponents') && markdownSource.includes('proseClass'),
);
assertTrue(
  'and KaTeX styles are imported inside the lazy chunk, not globally',
  markdownSource.includes("import 'katex/dist/katex.min.css'"),
);

const globalStyles = await readFile('src/app/globals.css', 'utf8');
assertTrue(
  'the global stylesheet does not pull in KaTeX for everyone',
  !globalStyles.includes('katex'),
);

console.log('\nliterature search routing');

/*
 * The intent that must never be answered from memory.
 *
 * A model asked for studies on a topic produces titles that read correctly,
 * authors who work in the field, and years that fit — and a student cites them.
 * Routing these requests to a real database instead is the point of the whole
 * knowledge layer, so the routing itself is guarded here.
 *
 * Getting it wrong in the other direction is the dangerous one: a request for
 * literature sent to the writing agent produces invented citations.
 */
const literatureCases: [string, string][] = [
  ['أريد دراسات سابقة عن التعلم التعاوني', 'research.literature'],
  ['ابحث عن دراسات حول الذكاء الاصطناعي في التعليم', 'research.literature'],
  ['مراجعة الأدبيات عن التحصيل الدراسي', 'research.literature'],
  ['أريد مراجع عربية عن التعليم', 'research.literature'],
  ['find studies on cooperative learning', 'research.literature'],
  ['literature review on AI in education', 'research.literature'],
  ['recent research on machine learning', 'research.literature'],

  /*
   * Phrasings a user actually typed, which the first version of these patterns
   * missed entirely.
   *
   * "أريد الاطلاع على الدراسات والأبحاث السابقة المتعلقة بالتعلم التعاوني"
   * failed on two counts — the definite article, and the three words between
   * the noun and its qualifier — fell through to the model, and came back
   * classified as a request to build a questionnaire. Arabic places modifiers
   * between a noun and what qualifies it far more often than the tidy phrasings
   * a test author invents, and the patterns have to allow for it.
   */
  ['تريد الاطلاع على الدراسات والأبحاث السابقة المتعلقة بالتعلم التعاوني', 'research.literature'],
  ['أريد الاطلاع على الدراسات والأبحاث السابقة المتعلقة بالتعلم التعاوني', 'research.literature'],
  ['الدراسات والأبحاث السابقة عن التعلم التعاوني', 'research.literature'],
  ['ما هي الدراسات السابقة حول التحصيل الدراسي', 'research.literature'],
  ['الأدبيات النظرية عن التعلم النشط', 'research.literature'],
  ['أريد الاطلاع على أدبيات الموضوع', 'research.literature'],
  ['ابحث لي عن أبحاث في الذكاء الاصطناعي', 'research.literature'],
];

for (const [message, expected] of literatureCases) {
  check(`"${message.slice(0, 44)}" → ${expected}`, classifyByKeyword(message)?.intent, expected);
}

/* Writing a plan is not searching for studies, though both mention research. */
check('a request to write a plan stays with the research agent', classifyByKeyword('اكتب لي خطة بحث عن الذكاء الاصطناعي')?.intent, 'research.plan');
check('and so does the English form', classifyByKeyword('write a research plan about AI')?.intent, 'research.plan');

/* Nor is building a questionnaire — the intent the misrouted request landed on. */
check('building a questionnaire is its own request', classifyByKeyword('أنشئ استبانة لهذا البحث')?.intent, 'research.survey');

/* The capability is real, costs a model call, and needs no file. */
check('literature search is available', capabilityFor('research.literature').status, 'available');
check('it needs no dataset', capabilityFor('research.literature').requiresDataset, false);
assertTrue('and it costs something, since composing the answer takes a model', capabilityFor('research.literature').units > 0);

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
