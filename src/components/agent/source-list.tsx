'use client';

import { BookOpen, ExternalLink, Quote, Unlock } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Alert } from '@/components/ui/alert';
import { cn } from '@/lib/cn';

/**
 * The sources behind an answer.
 *
 * This component is the reason the whole knowledge layer is worth building. An
 * assistant that says "several studies show..." has told the researcher
 * nothing they can use, and asked them to trust a claim they cannot check. A
 * numbered list with resolving DOIs turns the same sentence into something they
 * can verify in one click and cite in a bibliography.
 *
 * Three details that look cosmetic and are not:
 *
 * **The number.** It matches the [3] in the prose above. Without the link
 * between them the reader cannot tell which source supports which claim, and a
 * list of references at the bottom becomes decoration.
 *
 * **The language badge.** An Arabic thesis can quote an Arabic source directly;
 * an English one has to be translated, and the translation is the researcher's
 * responsibility. Knowing which is which before opening the paper saves real
 * time.
 *
 * **The DOI, selectable.** It is what goes into the bibliography, and copying
 * it should not require opening the paper first.
 */

export interface RetrievedSource {
  title: string;
  url: string;
  doi?: string;
  authors?: string[];
  container?: string;
  year?: number;
  language: 'ar' | 'en' | 'other' | 'unknown';
  citationCount?: number;
  openAccess?: boolean;
  provider: string;
}

export interface SourceCoverage {
  total: number;
  byLanguage: { ar: number; en: number; other: number };
  byProvider: Record<string, number>;
  arabicCoverageNoticeKey: string | null;
}

export function SourceList({
  sources,
  coverage,
}: {
  sources: RetrievedSource[];
  coverage?: SourceCoverage;
}) {
  const t = useTranslations('knowledge');

  if (sources.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {/*
        The coverage notice comes first, before the sources rather than after.
        A researcher who reads ten English references and only then learns the
        Arabic literature was not searched has already formed an impression.
      */}
      {coverage?.arabicCoverageNoticeKey && (
        <Alert tone="info">{t(coverage.arabicCoverageNoticeKey.replace('knowledge.', ''))}</Alert>
      )}

      <div className="flex items-center gap-2 text-xs text-muted">
        <BookOpen className="size-3.5" />
        <span>{t('sourcesFound', { count: sources.length })}</span>
        {coverage && (
          <span>
            · {t('languageBreakdown', {
              arabic: coverage.byLanguage.ar,
              english: coverage.byLanguage.en,
            })}
          </span>
        )}
      </div>

      <ol className="flex flex-col gap-2">
        {sources.map((source, index) => (
          <li
            key={source.doi ?? source.url ?? index}
            className="flex gap-3 rounded-lg border border-line bg-surface p-3"
          >
            <span className="shrink-0 font-mono text-xs text-muted">[{index + 1}]</span>

            <div className="flex min-w-0 flex-col gap-1">
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-1.5 text-sm text-ink hover:text-accent"
              >
                <span className="min-w-0">{source.title}</span>
                <ExternalLink className="mt-0.5 size-3 shrink-0 opacity-50" />
              </a>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 font-medium',
                    source.language === 'ar' ? 'bg-accent/10 text-accent' : 'bg-subtle',
                  )}
                >
                  {source.language === 'ar' ? t('arabic') : t('english')}
                </span>

                {source.authors && source.authors.length > 0 && (
                  <span className="truncate">
                    {source.authors.slice(0, 3).join('، ')}
                    {source.authors.length > 3 && ' …'}
                  </span>
                )}

                {source.year && <span>{source.year}</span>}
                {source.container && <span className="truncate">{source.container}</span>}

                {typeof source.citationCount === 'number' && source.citationCount > 0 && (
                  <span className="flex items-center gap-1">
                    <Quote className="size-3" />
                    {source.citationCount}
                  </span>
                )}

                {source.openAccess && (
                  <span className="flex items-center gap-1 text-success">
                    <Unlock className="size-3" />
                    {t('openAccess')}
                  </span>
                )}
              </div>

              {/*
                Selectable, and monospaced so a transcription error is visible.
                This is the string that goes into the bibliography.
              */}
              {source.doi && (
                <code className="select-all font-mono text-xs text-muted">{source.doi}</code>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
