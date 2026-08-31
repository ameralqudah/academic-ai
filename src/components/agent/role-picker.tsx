'use client';

import { Check, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * Choosing which variables play which part.
 *
 * The agent asks "which variable is the outcome, and which is the predictor" and
 * refuses to guess, because deciding what a study is about is not the
 * assistant's decision to make. That is right, and it left the user with
 * nowhere to answer: a real questionnaire export arrived with a hundred and
 * ninety-eight columns and the only way to reply was to type a name that had
 * never been shown.
 *
 * So this is the missing half of that refusal. Three things follow from the
 * column count rather than from taste:
 *
 * **Search is not optional.** A list of two hundred names is not something
 * anyone scrolls. It is the first control in the panel, focused on open.
 *
 * **Type and scale are shown beside each name.** Choosing an outcome means
 * choosing something the test can use, and a researcher scanning `Q47_recoded`
 * cannot tell whether it holds numbers or free text. Showing it prevents a
 * choice that the engines would only reject later.
 *
 * **Roles are assigned one at a time, with the current assignment visible.**
 * A multi-select with no memory of what was picked for what is unusable at this
 * size.
 */

export interface ColumnSummary {
  name: string;
  type: string;
  scale: string;
  missing: number;
  distinct: number;
}

export type VariableRole = 'dependent' | 'independent' | 'grouping' | 'covariate' | 'paired';

export interface RoleAssignment {
  column: string;
  role: VariableRole;
}

/** Roles offered, in the order a researcher usually assigns them. */
const ROLES: VariableRole[] = ['dependent', 'grouping', 'independent', 'paired', 'covariate'];

export function RolePicker({
  columns,
  value,
  onChange,
  onConfirm,
  onCancel,
}: {
  columns: ColumnSummary[];
  value: RoleAssignment[];
  onChange: (roles: RoleAssignment[]) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('roles');
  const ta = useTranslations('agent');

  const [query, setQuery] = useState('');
  const [role, setRole] = useState<VariableRole>('dependent');

  /*
   * Filtered on name, type and scale together, so "numeric" narrows to the
   * columns a comparison can actually use. At this size the useful search is
   * often by kind rather than by name — a researcher knows they want a Likert
   * item long before they remember which one.
   */
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return columns;

    return columns.filter(
      (column) =>
        column.name.toLowerCase().includes(needle) ||
        column.type.toLowerCase().includes(needle) ||
        column.scale.toLowerCase().includes(needle),
    );
  }, [columns, query]);

  const roleOf = (name: string) => value.find((entry) => entry.column === name)?.role;

  function toggle(name: string) {
    const current = roleOf(name);

    /* Tapping a column already in the selected role removes it. */
    if (current === role) {
      onChange(value.filter((entry) => entry.column !== name));
      return;
    }

    /*
     * Only one dependent variable and one grouping variable. A second of either
     * is almost always a misclick, and silently keeping both produces a request
     * the engines reject for reasons that look unrelated to what was clicked.
     */
    const exclusive = role === 'dependent' || role === 'grouping';
    const cleared = exclusive ? value.filter((entry) => entry.role !== role) : value;

    onChange([...cleared.filter((entry) => entry.column !== name), { column: name, role }]);
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium text-ink">{t('title')}</h3>
          <p className="text-xs text-muted">{t('subtitle', { count: columns.length })}</p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label={ta('cancel')}
          className="rounded p-1 text-muted hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Which role the next tap assigns. */}
      <div className="flex flex-wrap gap-1.5">
        {ROLES.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setRole(option)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs',
              option === role
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line text-muted hover:text-ink',
            )}
          >
            {t(`role.${option}`)}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute start-2.5 top-2.5 size-3.5 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(change) => setQuery(change.target.value)}
          placeholder={t('search')}
          autoFocus
          className="w-full rounded-lg border border-line bg-ground py-2 ps-8 pe-3 text-sm text-ink outline-none focus:border-accent"
        />
      </div>

      <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
        {filtered.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted">{t('noMatches')}</p>
        ) : (
          filtered.map((column) => {
            const assigned = roleOf(column.name);

            return (
              <button
                key={column.name}
                type="button"
                onClick={() => toggle(column.name)}
                className={cn(
                  'flex w-full items-center gap-2 border-b border-line/50 px-3 py-2 text-start last:border-0',
                  assigned ? 'bg-accent-soft/40' : 'hover:bg-subtle',
                )}
              >
                <Check
                  className={cn('size-3.5 shrink-0', assigned ? 'text-accent' : 'invisible')}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-xs text-ink">{column.name}</span>
                  <span className="text-[11px] text-muted">
                    {t(`type.${column.type}`)} · {t(`scale.${column.scale}`)}
                    {column.missing > 0 && ` · ${t('missing', { count: column.missing })}`}
                  </span>
                </span>
                {assigned && (
                  <span className="ms-auto shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">
                    {t(`role.${assigned}`)}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      {/* What has been chosen so far, so the panel can be scrolled without losing track. */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((entry) => (
            <span
              key={entry.column}
              className="flex items-center gap-1 rounded bg-subtle px-2 py-1 text-xs text-ink"
            >
              <span className="font-mono">{entry.column}</span>
              <span className="text-muted">{t(`role.${entry.role}`)}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((other) => other.column !== entry.column))}
                aria-label={ta('cancel')}
                className="text-muted hover:text-danger"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {ta('cancel')}
        </Button>
        <Button type="button" onClick={onConfirm} disabled={value.length === 0}>
          {t('confirm')}
        </Button>
      </div>
    </div>
  );
}
