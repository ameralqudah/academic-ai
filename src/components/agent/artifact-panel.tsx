'use client';

import { AlertTriangle, BadgeCheck, Download, FileText, Loader2, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { Markdown } from '@/components/chat/markdown';
import { cn } from '@/lib/cn';

/**
 * The side panel a generated document opens in.
 *
 * A document the assistant wrote was a download link: to read what had been
 * produced, a researcher saved a file and opened another program, then came
 * back to ask for a change. Here it opens beside the conversation, so the text
 * and the discussion of it are on screen together, and the file remains one
 * click away for when it is wanted.
 *
 * The opener is a context rather than a prop because the link lives several
 * components down — inside a task's progress card, inside a result, inside a
 * turn — and threading a callback through each would couple all of them to a
 * feature only the innermost one uses. Outside a provider `useArtifactPanel`
 * returns null, and callers fall back to the plain download they had.
 */

interface PreviewData {
  id: string;
  filename: string;
  kind: string;
  version: number;
  byteSize: number;
  createdAt: string;
  validationStatus: string;
  qualityStatus: string | null;
  markdown: string | null;
  truncated: boolean;
  versions: { id: string; version: number; createdAt: string }[];
}

const PanelContext = createContext<{ open: (artifactId: string) => void } | null>(null);

export function useArtifactPanel() {
  return useContext(PanelContext);
}

export function ArtifactPanelProvider({
  children,
}: {
  /** Receives the panel element so the owner decides where it sits in its layout. */
  children: (panel: ReactNode) => ReactNode;
}) {
  const [artifactId, setArtifactId] = useState<string | null>(null);

  const open = useCallback((id: string) => setArtifactId(id), []);
  const value = useMemo(() => ({ open }), [open]);

  return (
    <PanelContext.Provider value={value}>
      {children(
        artifactId ? (
          <ArtifactPanel
            /* Keyed, so moving between versions starts from a clean loading state. */
            key={artifactId}
            artifactId={artifactId}
            onSelect={setArtifactId}
            onClose={() => setArtifactId(null)}
          />
        ) : null,
      )}
    </PanelContext.Provider>
  );
}

function ArtifactPanel({
  artifactId,
  onSelect,
  onClose,
}: {
  artifactId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations('artifactPanel');
  const locale = useLocale();

  const [data, setData] = useState<PreviewData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    fetch(`/api/artifacts/${artifactId}/preview`, { signal: controller.signal })
      .then(async (response) => {
        const json = (await response.json()) as { ok: boolean; data?: PreviewData };
        if (!response.ok || !json.ok || !json.data) throw new Error('preview failed');
        setData(json.data);
      })
      .catch((error: unknown) => {
        if ((error as { name?: string })?.name !== 'AbortError') setFailed(true);
      });

    return () => controller.abort();
  }, [artifactId]);

  /* Escape closes it — the one way anyone expects to dismiss a panel. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const title = data ? data.filename.replace(/\.[^.]+$/, '') : t('loading');
  const checked = data?.qualityStatus ?? data?.validationStatus ?? null;

  return (
    <aside
      aria-label={t('label')}
      className={cn(
        /* A full-screen sheet on a phone; a column beside the chat from `lg`. */
        'fixed inset-0 z-50 flex flex-col bg-ground p-0',
        'lg:static lg:z-auto lg:w-[46%] lg:max-w-[720px] lg:shrink-0 lg:bg-transparent lg:py-3 lg:pe-3',
      )}
    >
      <div className="shadow-float flex min-h-0 flex-1 flex-col overflow-hidden border-line bg-surface lg:rounded-2xl lg:border">
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <FileText className="size-4 shrink-0 text-primary" aria-hidden />
          <h2 className="min-w-0 truncate font-sans text-sm font-medium text-ink">{title}</h2>

          {data && data.versions.length > 1 ? (
            <select
              value={data.id}
              onChange={(event) => onSelect(event.target.value)}
              aria-label={t('version')}
              className="shrink-0 rounded-lg border border-line bg-transparent px-2 py-1 text-xs text-muted outline-none hover:bg-subtle"
            >
              {data.versions.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {t('versionN', { n: entry.version })}
                </option>
              ))}
            </select>
          ) : (
            data && (
              <span className="shrink-0 text-xs text-muted">{t('versionN', { n: data.version })}</span>
            )
          )}

          <span className="ms-auto flex shrink-0 items-center gap-1.5">
            {data && (
              <a
                href={`/api/artifacts/${data.id}`}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:bg-primary-hover"
              >
                <Download className="size-3.5" aria-hidden />
                <span className="uppercase" dir="ltr">
                  {data.kind}
                </span>
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={t('close')}
              className="rounded-lg p-1.5 text-muted hover:bg-subtle hover:text-ink"
            >
              <X className="size-4" aria-hidden />
            </button>
          </span>
        </header>

        {data && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2 text-xs text-muted">
            {/*
              The verdict of the quality check, where the document is read. A
              file that failed its check should say so here, not only in a list
              somewhere else.
            */}
            {/*
              "Passed the quality check", not "references verified": the check at
              storage time runs without the network, so it has not confirmed
              that each reference exists. The label claims what was done.
            */}
            {checked === 'pass' && (
              <span className="flex items-center gap-1 text-success">
                <BadgeCheck className="size-3.5" aria-hidden />
                {t('checked')}
              </span>
            )}
            {(checked === 'fail' || checked === 'attention') && (
              <span
                className={cn(
                  'flex items-center gap-1',
                  checked === 'fail' ? 'text-danger' : 'text-warning',
                )}
              >
                <AlertTriangle className="size-3.5" aria-hidden />
                {t(checked === 'fail' ? 'checkFailed' : 'checkWarned')}
              </span>
            )}
            <span>
              {/*
                The browser's own formatter, so the time is the reader's. The
                app-wide formatter is pinned to one zone for server rendering;
                this panel only ever renders in the browser, where the real
                zone is known.
              */}
              {new Intl.DateTimeFormat(locale === 'ar' ? 'ar-JO-u-nu-latn' : 'en-GB', {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(data.createdAt))}
            </span>
          </div>
        )}

        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
          {failed ? (
            <p className="text-sm text-danger">{t('failed')}</p>
          ) : !data ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t('loading')}
            </p>
          ) : data.markdown ? (
            <>
              {/* Set as a document rather than a chat reply: a centred title, headings that lead. */}
              <div className="[&_h1]:!mb-4 [&_h1]:!text-center [&_h1]:!text-2xl [&_h1]:!leading-relaxed [&_h2]:!text-xl [&_h3]:!mt-6 [&_h3]:!text-lg [&_h3]:!text-primary [&_h4]:!text-base">
                <Markdown content={data.markdown} reading />
              </div>
              {data.truncated && (
                <p className="mt-6 border-t border-line pt-3 text-xs text-muted">{t('truncated')}</p>
              )}
            </>
          ) : (
            /*
             * A spreadsheet, or a document stored before previews were kept.
             * Said plainly, with the file offered — not an error, and not a
             * blank panel that looks like one.
             */
            <div className="flex flex-col items-start gap-3 text-sm text-ink-soft">
              <p>{t('noPreview')}</p>
              <a
                href={`/api/artifacts/${data.id}`}
                className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:bg-subtle"
              >
                <Download className="size-4" aria-hidden />
                {t('download')}
              </a>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
