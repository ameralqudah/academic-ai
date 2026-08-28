'use client';

import { Check, ChevronDown, FolderOpen, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';

/**
 * Choosing which project the conversation is working on — or none.
 *
 * **None is the default, and that is the important decision.** Most of what the
 * assistant does needs no project at all: analysing a file, computing a
 * reliability coefficient, asking which test fits a design. Requiring a project
 * first would make every user create an empty container before they could ask
 * anything, which is a tax on the common case for the sake of the rare one.
 *
 * A project matters for exactly the things that are *about* a project — writing
 * a chapter, attaching a result to a section, drawing on what has already been
 * written. For those the assistant asks, and this is how the answer is given.
 *
 * **The selection is also readable from the URL**, and that is deliberate
 * groundwork rather than an incidental feature. It means a link from inside a
 * project — `/ar/chat?project=abc` — opens the assistant already pointed at it,
 * so the shortcut planned for the project page is a link and not a rebuild.
 */

export interface ProjectOption {
  id: string;
  title: string;
}

interface Props {
  projects: ProjectOption[];
  value: string | null;
  onChange: (projectId: string | null) => void;
  locale: string;
  disabled?: boolean;
}

export function ProjectPicker({ projects, value, onChange, locale, disabled }: Props) {
  const t = useTranslations('agent');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  /* Close on an outside click or Escape — the two ways anyone dismisses a menu. */
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const selected = projects.find((project) => project.id === value) ?? null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5',
          'text-sm text-ink hover:border-accent disabled:opacity-60',
        )}
      >
        <FolderOpen className="size-3.5 shrink-0 text-muted" />
        <span className="truncate">{selected ? selected.title : t('noProject')}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted" />
      </button>

      {open && (
        <div
          role="listbox"
          className={cn(
            'absolute top-full z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-lg',
            'border border-line bg-surface p-1 shadow-lg',
            'start-0',
          )}
        >
          <Option
            label={t('noProject')}
            hint={t('noProjectHint')}
            selected={value === null}
            onSelect={() => {
              onChange(null);
              setOpen(false);
            }}
          />

          {projects.length > 0 && <div className="my-1 border-t border-line" />}

          {projects.map((project) => (
            <Option
              key={project.id}
              label={project.title}
              selected={project.id === value}
              onSelect={() => {
                onChange(project.id);
                setOpen(false);
              }}
            />
          ))}

          <div className="my-1 border-t border-line" />

          <Link
            href={`/${locale}/projects/new`}
            className="flex items-center gap-2 rounded px-2.5 py-2 text-sm text-accent hover:bg-subtle"
          >
            <Plus className="size-3.5 shrink-0" />
            {t('newProject')}
          </Link>
        </div>
      )}
    </div>
  );
}

function Option({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className="flex w-full items-start gap-2 rounded px-2.5 py-2 text-start text-sm hover:bg-subtle"
    >
      <Check className={cn('mt-0.5 size-3.5 shrink-0', selected ? 'text-accent' : 'invisible')} />
      <span className="flex flex-col gap-0.5">
        <span className="text-ink">{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </span>
    </button>
  );
}
