/**
 * Live check of the academic knowledge layer.
 *
 *   npm run test:knowledge
 *
 * Unlike every other suite in this project, this one needs the network. It
 * calls Crossref and OpenAlex for real and prints what came back, because the
 * only way to know a provider works is to use it. The response shapes here were
 * read from live calls rather than from documentation — which is how we learned
 * that Crossref returns titles as arrays and OpenAlex stores abstracts as an
 * inverted index, neither of which was obvious from the docs.
 *
 * It is not part of `npm test`: a suite that fails when a third party is having
 * a bad afternoon teaches developers to ignore failures.
 */

import 'dotenv/config';

import { search, lookupByDoi } from '@/server/knowledge';
import type { SourceLanguage } from '@/server/knowledge/types';

function heading(text: string) {
  console.log(`\n${'─'.repeat(70)}\n${text}\n${'─'.repeat(70)}`);
}

function show(sources: Awaited<ReturnType<typeof search>>['sources'], limit = 4) {
  for (const source of sources.slice(0, limit)) {
    const flag = source.language === 'ar' ? '[ar]' : source.language === 'en' ? '[en]' : '[??]';
    console.log(`  ${flag} ${source.title.slice(0, 78)}`);
    console.log(
      `       ${source.year ?? '????'} · ${source.container?.slice(0, 40) ?? 'no venue'} · ` +
        `${source.citationCount ?? 0} citations · ${source.provider}` +
        `${source.openAccess ? ' · open access' : ''}`,
    );
    if (source.doi) console.log(`       doi: ${source.doi}`);
  }
}

function summarise(report: Awaited<ReturnType<typeof search>>) {
  console.log(`\n  providers:`);
  for (const provider of report.providers) {
    const total = provider.totalAvailable === null ? '—' : provider.totalAvailable.toLocaleString('en');
    console.log(
      `    ${provider.name.padEnd(10)} returned ${String(provider.returned).padStart(3)} ` +
        `of ${total.padStart(12)} in ${provider.tookMs}ms` +
        `${provider.error ? `  ⚠ ${provider.error}` : ''}`,
    );
  }
  console.log(
    `  after merge: ${report.coverage.total} sources ` +
      `(${report.coverage.duplicatesRemoved} duplicates removed)`,
  );
  console.log(
    `  languages:   ${report.coverage.byLanguage.ar} Arabic · ` +
      `${report.coverage.byLanguage.en} English · ${report.coverage.byLanguage.other} other`,
  );
  if (report.coverage.arabicCoverageNoticeKey) {
    console.log(`  ⚠ coverage notice: ${report.coverage.arabicCoverageNoticeKey}`);
  }
  console.log(`  total time:  ${report.tookMs}ms`);
}

async function run(
  label: string,
  queries: { text: string; language: SourceLanguage }[],
  preferredLanguage: SourceLanguage,
) {
  heading(label);
  console.log(`  queries: ${queries.map((query) => `"${query.text}" (${query.language})`).join(' + ')}`);

  const report = await search({ queries, preferredLanguage, kind: 'academic', limit: 10 });

  console.log('');
  show(report.sources);
  summarise(report);
}

async function main() {
  console.log('\nAcademic knowledge layer — live check');
  console.log(`OpenAlex key: ${process.env.OPENALEX_API_KEY ? 'configured' : 'not set (smaller free budget)'}`);

  /* 1. Arabic query, Arabic researcher. The hard case. */
  await run(
    '1. أبحاث عن الذكاء الاصطناعي والتعليم  (Arabic query)',
    [{ text: 'الذكاء الاصطناعي في التعليم', language: 'ar' }],
    'ar',
  );

  /* 2. The same question in English, for comparison. */
  await run(
    '2. Impact of AI on education  (English query)',
    [{ text: 'impact of artificial intelligence on education', language: 'en' }],
    'en',
  );

  /* 3. Both languages at once — what the bilingual layer will do. */
  await run(
    '3. Bilingual: both queries, merged',
    [
      { text: 'الذكاء الاصطناعي في التعليم', language: 'ar' },
      { text: 'artificial intelligence in education', language: 'en' },
    ],
    'ar',
  );

  /* 4. An Arabic topic with no obvious English equivalent literature. */
  await run(
    '4. موضوع عربي: التحصيل الدراسي والتعلم التعاوني',
    [{ text: 'التعلم التعاوني والتحصيل الدراسي', language: 'ar' }],
    'ar',
  );

  /* 5. DOI lookup — verifying a reference rather than discovering one. */
  heading('5. DOI lookup (free on both providers)');
  const known = '10.1109/4235.585892';
  console.log(`  looking up ${known}`);
  const found = await lookupByDoi(known);
  if (found) {
    console.log(`\n  ✓ ${found.title}`);
    console.log(`    ${found.year} · ${found.container} · ${found.citationCount ?? 0} citations`);
    console.log(`    ${found.url}`);
  } else {
    console.log('  ✗ not found — check the network or the DOI');
  }

  const missing = await lookupByDoi('10.9999/does-not-exist-12345');
  console.log(`\n  a non-existent DOI returns: ${missing === null ? 'null (correct)' : 'something (wrong)'}`);

  /* 6. Deduplication, demonstrated rather than asserted. */
  heading('6. Deduplication across providers');
  const overlap = await search({
    queries: [{ text: 'cooperative learning academic achievement', language: 'en' }],
    preferredLanguage: 'en',
    kind: 'academic',
    limit: 10,
  });
  console.log(
    `  ${overlap.providers.reduce((sum, provider) => sum + provider.returned, 0)} raw results → ` +
      `${overlap.coverage.total} unique (${overlap.coverage.duplicatesRemoved} were the same paper)`,
  );
  console.log(`  by provider: ${JSON.stringify(overlap.coverage.byProvider)}`);

  console.log('\nDone.\n');
}

main().catch((error) => {
  console.error('\nLive check failed:', error);
  process.exit(1);
});
