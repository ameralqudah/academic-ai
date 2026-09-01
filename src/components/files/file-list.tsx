'use client';

import { AlertTriangle, Check, Download, FileSpreadsheet, Search, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Link, useRouter } from '@/i18n/navigation';

/**
 * The files a researcher has uploaded.
 *
 * There was no such page. Datasets were stored, listed by an API nobody called,
 * and reachable only by uploading the same file again into a chat — so someone
 * who uploaded ten files over a month could see none of them. The sidebar's
 * "Library" pointed at the analysis tool, which is a different thing: that page
 * inspects one file, and this one is the answer to "what do I have".
 *
 * **The row is the unit of work, not the file.** A researcher looking at a
 * dataset wants to analyse it, download the cleaned version, or remove it —
 * so each row carries those, rather than opening a detail page that would add
 * a click to every path.
 */

export interface DatasetSummary {
  id: string;
  originalName: string;
  rowCount: number;
  columnCount: number;
  sizeBytes: number;
  createdAt: string;
  projectId: string | null;
  projectTitle?: string | null;
  /** ORIGINAL or CLEANED — a cleaned copy goes when its original does. */
  kind?: 'ORIGINAL' | 'CLEANED';
}

export function FileList({ datasets }: { datasets: DatasetSummary[] }) {
  const t = useTranslations('files');
  const [query, setQuery] = useState('');
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  /*
   * Searched on name and project together. A researcher with forty files
   * remembers "the one from the pilot study" more often than its filename, and
   * the project is what carries that.
   */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return datasets.filter((dataset) => {
      if (removed.has(dataset.id)) return false;
      if (!needle) return true;

      return (
        dataset.originalName.toLowerCase().includes(needle) ||
        (dataset.projectTitle ?? '').toLowerCase().includes(needle)
      );
    });
  }, [datasets, query, removed]);

  if (datasets.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line p-8 text-center">
        <FileSpreadsheet className="mx-auto mb-3 size-8 text-muted" aria-hidden />
        <p className="text-sm text-ink">{t('empty.title')}</p>
        <p className="mt-1 text-xs text-muted">{t('empty.hint')}</p>
        <Link
          href="/chat"
          className="mt-4 inline-block rounded-lg border border-line px-3 py-1.5 text-sm text-accent hover:border-accent"
        >
          {t('empty.action')}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {datasets.length > 5 && (
        <div className="relative">
          <Search className="pointer-events-none absolute start-2.5 top-2.5 size-3.5 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(change) => setQuery(change.target.value)}
            placeholder={t('search')}
            className="w-full rounded-lg border border-line bg-ground py-2 ps-8 pe-3 text-sm text-ink outline-none focus:border-accent"
          />
        </div>
      )}

      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t('noMatches')}</p>
      ) : (
        visible.map((dataset) => (
          <FileRow
            key={dataset.id}
            dataset={dataset}
            onRemoved={() => setRemoved((current) => new Set(current).add(dataset.id))}
          />
        ))
      )}
    </div>
  );
}

function FileRow({
  dataset,
  onRemoved,
}: {
  dataset: DatasetSummary;
  onRemoved: () => void;
}) {
  const t = useTranslations('files');
  const router = useRouter();

  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setWorking(true);
    setError(null);

    try {
      const response = await fetch(`/api/datasets/${dataset.id}`, { method: 'DELETE' });
      const json = await response.json().catch(() => null);

      if (!response.ok || !json?.ok) {
        setError(json?.error?.message ?? t('error.deleteFailed'));
        setWorking(false);
        setConfirming(false);
        return;
      }

      /*
       * Hidden immediately, then the server list refreshes. Waiting for the
       * refresh leaves the row on screen after the click, which reads as the
       * button not working.
       */
      onRemoved();
      router.refresh();
    } catch {
      setError(t('error.deleteFailed'));
      setWorking(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-start gap-3">
        <FileSpreadsheet className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />

        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-ink">{dataset.originalName}</span>
          <span className="text-xs text-muted">
            {t('summary', {
              rows: dataset.rowCount,
              columns: dataset.columnCount,
              size: formatSize(dataset.sizeBytes),
            })}
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            {dataset.projectTitle && (
              <span className="truncate text-[11px] text-muted">{dataset.projectTitle}</span>
            )}
            {dataset.kind === 'CLEANED' && (
              <span className="rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
                {t('cleaned')}
              </span>
            )}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/*
            Analysing is the common action, so it is a labelled link rather than
            an icon: the icons beside it are secondary and can afford to be
            discovered.
          */}
          <Link
            href={{ pathname: '/chat', query: { dataset: dataset.id } }}
            className="rounded-lg px-2 py-1 text-xs text-accent hover:bg-subtle"
          >
            {t('analyse')}
          </Link>

          <a
            href={`/api/datasets/${dataset.id}/download`}
            className="rounded p-1.5 text-muted hover:bg-subtle hover:text-ink"
            aria-label={t('download')}
          >
            <Download className="size-3.5" />
          </a>

          {confirming ? (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void remove()}
                disabled={working}
                aria-label={t('confirmDelete')}
                className="rounded p-1.5 text-danger hover:bg-subtle disabled:opacity-50"
              >
                <Check className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                aria-label={t('cancelDelete')}
                className="rounded p-1.5 text-muted hover:bg-subtle hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={t('delete')}
              className="rounded p-1.5 text-muted hover:bg-subtle hover:text-danger"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/*
        Confirmation says what deleting costs. A dataset with saved analyses is
        not the same as an unused upload, and a researcher should know which one
        they are about to remove.
      */}
      {confirming && (
        <p className="text-xs text-muted">{t('deleteWarning')}</p>
      )}

      {error && (
        <Alert tone="danger">
          <span className="flex items-center gap-2 text-sm">
            <AlertTriangle className="size-3.5 shrink-0" />
            {error}
          </span>
        </Alert>
      )}
    </div>
  );
}

/**
 * A file size a person can read.
 *
 * Binary units, because that is what an operating system reports and a
 * mismatch between "2.1 MB here" and "2.2 MB in Finder" reads as a bug.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { formatSize };
