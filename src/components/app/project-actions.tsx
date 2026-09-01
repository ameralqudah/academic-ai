'use client';

import { AlertTriangle, Check, Pencil, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useRouter } from '@/i18n/navigation';

/**
 * Renaming and deleting a project.
 *
 * The routes have existed since the project layer was built; the card was a
 * link and nothing else, so a researcher could create projects and never remove
 * one. That is the third time this pattern has appeared — conversations,
 * datasets, and now projects: a complete server capability with no control
 * attached to it.
 *
 * Kept separate from the card, which is a server component that renders
 * formatted dates and translated badges. Making the whole card a client
 * component to add two buttons would send the formatting machinery to the
 * browser for no gain; this overlays the actions instead.
 */
export function ProjectActions({
  projectId,
  title,
  /** Shown in the confirmation, so the researcher knows what they are removing. */
  hasContent,
}: {
  projectId: string;
  title: string;
  hasContent: boolean;
}) {
  const t = useTranslations('projects');
  const router = useRouter();

  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(title);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rename() {
    const trimmed = draft.trim();

    if (!trimmed || trimmed === title) {
      setRenaming(false);
      setDraft(title);
      return;
    }

    setWorking(true);

    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });

      const json = await response.json().catch(() => null);

      if (!response.ok || !json?.ok) {
        /* Reverted, so the card never shows a title the server did not accept. */
        setDraft(title);
        setError(json?.error?.message ?? t('error.renameFailed'));
      }
    } catch {
      setDraft(title);
      setError(t('error.renameFailed'));
    } finally {
      setWorking(false);
      setRenaming(false);
      router.refresh();
    }
  }

  async function remove() {
    setWorking(true);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
      const json = await response.json().catch(() => null);

      if (!response.ok || !json?.ok) {
        setError(json?.error?.message ?? t('error.deleteFailed'));
        setWorking(false);
        setConfirming(false);
        return;
      }

      router.refresh();
    } catch {
      setError(t('error.deleteFailed'));
      setWorking(false);
      setConfirming(false);
    }
  }

  if (renaming) {
    return (
      <div className="flex flex-col gap-1">
        <input
          value={draft}
          onChange={(change) => setDraft(change.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void rename();
            if (event.key === 'Escape') {
              setDraft(title);
              setRenaming(false);
            }
          }}
          autoFocus
          maxLength={300}
          disabled={working}
          className="w-full rounded-lg border border-accent bg-ground px-2 py-1.5 text-sm text-ink outline-none disabled:opacity-60"
        />
        <span className="text-[11px] text-muted">{t('renameHint')}</span>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="flex flex-col gap-2">
        {/*
          The confirmation says what is lost. A project holding chapters and
          references is not the same as an empty one created by mistake, and the
          researcher should know which they are removing.
        */}
        <p className="text-xs text-danger">
          {hasContent ? t('deleteWarningWithContent') : t('deleteWarning')}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void remove()}
            disabled={working}
            className="flex items-center gap-1 rounded-lg border border-danger px-2 py-1 text-xs text-danger hover:bg-subtle disabled:opacity-50"
          >
            <Check className="size-3" />
            {t('confirmDelete')}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-muted hover:text-ink"
          >
            <X className="size-3" />
            {t('cancelDelete')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setRenaming(true)}
          aria-label={t('rename')}
          className="rounded p-1 text-muted hover:bg-subtle hover:text-ink"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={t('delete')}
          className="rounded p-1 text-muted hover:bg-subtle hover:text-danger"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {error && (
        <span className="flex items-center gap-1 text-[11px] text-danger">
          <AlertTriangle className="size-3 shrink-0" />
          {error}
        </span>
      )}
    </div>
  );
}
