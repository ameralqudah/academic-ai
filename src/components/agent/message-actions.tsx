'use client';

import { Check, ChevronLeft, ChevronRight, Copy, Pencil, RefreshCw, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * What you can do with a message after it has been sent.
 *
 * The three actions look like conveniences and only one of them is. Copy is a
 * convenience. Edit and regenerate are the interface to the branching that has
 * been in the database since conversations were first persisted, and without
 * them that structure is invisible — every message has a parent, exactly one
 * child of each parent is active, and nothing has ever created a second child.
 *
 * The property worth stating: **neither action destroys anything.** Rewriting a
 * question adds a sibling and moves the active flag; the original and
 * everything that followed it stay on an inactive branch. Regenerating does the
 * same to an answer. A user who preferred what they had can go back, which is
 * the difference between editing a message and losing the conversation that
 * came after it.
 */

export interface MessageActionsProps {
  /** Rendered under an assistant reply or a user message — the actions differ. */
  role: 'user' | 'assistant';
  content: string;
  onEdit?: () => void;
  onRegenerate?: () => void;
  /** Present when this message has siblings: which one is shown, and how many. */
  branch?: {
    index: number;
    total: number;
    onPrevious: () => void;
    onNext: () => void;
  };
}

export function MessageActions({
  role,
  content,
  onEdit,
  onRegenerate,
  branch,
}: MessageActionsProps) {
  const t = useTranslations('chat');
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A denied clipboard permission is not worth interrupting anyone over.
    }
  }

  return (
    /*
     * Hidden until the message is hovered or something inside is focused.
     * A row of buttons under every message turns a conversation into a control
     * panel; keeping them out of the way until wanted keeps the text the thing
     * on screen. `focus-within` is what keeps them reachable by keyboard.
     */
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {branch && branch.total > 1 && (
        <span className="flex items-center gap-0.5 text-xs text-muted">
          <button
            type="button"
            onClick={branch.onPrevious}
            disabled={branch.index === 0}
            aria-label={t('previousVersion')}
            className="rounded p-1 hover:text-ink disabled:opacity-30"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="tabular-nums">
            {branch.index + 1}/{branch.total}
          </span>
          <button
            type="button"
            onClick={branch.onNext}
            disabled={branch.index >= branch.total - 1}
            aria-label={t('nextVersion')}
            className="rounded p-1 hover:text-ink disabled:opacity-30"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </span>
      )}

      <button
        type="button"
        onClick={() => void copy()}
        aria-label={t('copy')}
        className="rounded p-1.5 text-muted hover:bg-subtle hover:text-ink"
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>

      {/*
        Only a user's own message can be rewritten. Editing what the assistant
        said would let the conversation record an answer that was never given —
        and that record is what a results chapter or a citation may later be
        built from.
      */}
      {role === 'user' && onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={t('edit')}
          className="rounded p-1.5 text-muted hover:bg-subtle hover:text-ink"
        >
          <Pencil className="size-3.5" />
        </button>
      )}

      {role === 'assistant' && onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          aria-label={t('regenerate')}
          className="rounded p-1.5 text-muted hover:bg-subtle hover:text-ink"
        >
          <RefreshCw className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * Rewriting a message in place.
 *
 * Editing opens the text where it sits rather than putting it back in the
 * composer, so the surrounding conversation stays visible — the reason to
 * rewrite a question is usually something further up the thread.
 */
export function MessageEditor({
  initialValue,
  onCancel,
  onSubmit,
}: {
  initialValue: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const t = useTranslations('chat');
  const ta = useTranslations('agent');
  const [value, setValue] = useState(initialValue);

  return (
    <div className="flex w-full flex-col gap-2">
      <textarea
        value={value}
        onChange={(change) => setValue(change.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (value.trim()) onSubmit(value);
          }
        }}
        autoFocus
        rows={3}
        className={cn(
          'w-full resize-none rounded-lg border border-accent bg-surface px-3 py-2',
          'text-sm text-ink outline-none',
        )}
      />
      <div className="flex items-center justify-end gap-2">
        <span className="me-auto text-xs text-muted">{t('editHint')}</span>
        <Button type="button" variant="ghost" onClick={onCancel}>
          <X className="size-3.5" />
          {ta('cancel')}
        </Button>
        <Button
          type="button"
          onClick={() => onSubmit(value)}
          disabled={value.trim().length === 0 || value === initialValue}
        >
          {t('saveAndResend')}
        </Button>
      </div>
    </div>
  );
}
