'use client';

import { AlertTriangle, ArrowRight, Check, Plus, Search, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import type { ColumnSummary } from '@/components/agent/role-picker';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * Building a PLS model.
 *
 * The engine has been complete for a while and unreachable: it takes a model as
 * JSON, and there was no way for a researcher to produce one. This is the
 * missing half.
 *
 * **Lists rather than a drawing canvas**, and the choice is about the data
 * rather than about taste. A real questionnaire export arrives with two hundred
 * columns; assigning them by dragging is worse than searching a list, not
 * better. A canvas is the right answer for ten constructs on a whiteboard and
 * the wrong one for finding `Q147_recoded` among two hundred siblings.
 *
 * A diagram is still drawn — from the model rather than for editing it — because
 * seeing the arrows is how anyone checks they built what they meant.
 *
 * **Validation runs as you type, not on submit.** Every rule the engine
 * enforces is checked here too: a cycle, an indicator in two constructs, a
 * construct with no items. Learning about a cycle after a minute of bootstrap
 * resampling is a minute spent to be told something knowable immediately.
 */

export type MeasurementMode = 'reflective' | 'formative';

export interface BuilderConstruct {
  id: string;
  name: string;
  indicators: string[];
  mode: MeasurementMode;
}

export interface BuilderPath {
  from: string;
  to: string;
}

export interface PlsModelDraft {
  constructs: BuilderConstruct[];
  paths: BuilderPath[];
}

interface ValidationIssue {
  key: string;
  params?: Record<string, string | number>;
}

/**
 * Every rule the engine will apply, applied here first.
 *
 * Deliberately duplicated rather than shared: the server must validate
 * independently — a client check is a convenience and never a guarantee — and
 * this version can be more forgiving, reporting all the problems at once rather
 * than throwing on the first.
 */
function validate(draft: PlsModelDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (draft.constructs.length < 2) {
    issues.push({ key: 'tooFewConstructs', params: { count: draft.constructs.length } });
  }

  const names = new Set<string>();
  const owners = new Map<string, string>();

  for (const construct of draft.constructs) {
    const name = construct.name.trim();

    if (!name) {
      issues.push({ key: 'unnamedConstruct' });
    } else if (names.has(name)) {
      issues.push({ key: 'duplicateName', params: { name } });
    } else {
      names.add(name);
    }

    if (construct.indicators.length === 0) {
      issues.push({ key: 'noIndicators', params: { name: name || '—' } });
    }

    for (const indicator of construct.indicators) {
      const owner = owners.get(indicator);
      /*
       * An indicator in two constructs makes their scores partly the same
       * variable, which guarantees they will correlate and destroys
       * discriminant validity by construction rather than by finding.
       */
      if (owner && owner !== name) {
        issues.push({ key: 'sharedIndicator', params: { indicator, first: owner, second: name } });
      }
      owners.set(indicator, name);
    }
  }

  if (draft.constructs.length >= 2 && draft.paths.length === 0) {
    issues.push({ key: 'noPaths' });
  }

  const cycle = findCycle(draft);
  if (cycle) issues.push({ key: 'cycle', params: { cycle: cycle.join(' → ') } });

  return issues;
}

/**
 * A cycle in the path model.
 *
 * PLS requires a recursive model. A cycle does not stop the algorithm — it
 * iterates, converges, and returns coefficients for something that cannot be
 * interpreted causally — so catching it here is the only place a user learns
 * before spending a minute on it.
 */
function findCycle(draft: PlsModelDraft): string[] | null {
  const successors = new Map<string, string[]>();
  for (const path of draft.paths) {
    const list = successors.get(path.from);
    if (list) list.push(path.to);
    else successors.set(path.from, [path.to]);
  }

  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  function walk(node: string): string[] | null {
    if (visiting.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    if (done.has(node)) return null;

    visiting.add(node);
    stack.push(node);

    for (const next of successors.get(node) ?? []) {
      const found = walk(next);
      if (found) return found;
    }

    visiting.delete(node);
    done.add(node);
    stack.pop();
    return null;
  }

  for (const construct of draft.constructs) {
    const found = walk(construct.name.trim());
    if (found) return found;
  }

  return null;
}

/* -------------------------------------------------------------------------- */

export function PlsModelBuilder({
  columns,
  value,
  onChange,
  onEstimate,
  onBootstrap,
  busy,
}: {
  columns: ColumnSummary[];
  value: PlsModelDraft;
  onChange: (draft: PlsModelDraft) => void;
  onEstimate: () => void;
  onBootstrap: () => void;
  busy: boolean;
}) {
  const t = useTranslations('pls');
  const [editing, setEditing] = useState<string | null>(null);

  const issues = useMemo(() => validate(value), [value]);
  const valid = issues.length === 0;

  const named = value.constructs
    .map((construct) => construct.name.trim())
    .filter((name) => name.length > 0);

  function addConstruct() {
    const id = crypto.randomUUID();
    onChange({
      ...value,
      constructs: [
        ...value.constructs,
        { id, name: '', indicators: [], mode: 'reflective' },
      ],
    });
    setEditing(id);
  }

  function updateConstruct(id: string, patch: Partial<BuilderConstruct>) {
    onChange({
      ...value,
      constructs: value.constructs.map((construct) =>
        construct.id === id ? { ...construct, ...patch } : construct,
      ),
    });
  }

  function removeConstruct(id: string) {
    const construct = value.constructs.find((entry) => entry.id === id);
    const name = construct?.name.trim();

    onChange({
      constructs: value.constructs.filter((entry) => entry.id !== id),
      /*
       * Paths touching the removed construct go with it. Leaving them would
       * produce a model referring to something that no longer exists, which the
       * engine would refuse in language about an unknown construct rather than
       * about the deletion that caused it.
       */
      paths: name ? value.paths.filter((path) => path.from !== name && path.to !== name) : value.paths,
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Constructs */}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-ink">{t('constructs')}</h3>

        {value.constructs.map((construct) => (
          <ConstructRow
            key={construct.id}
            construct={construct}
            columns={columns}
            takenIndicators={value.constructs
              .filter((other) => other.id !== construct.id)
              .flatMap((other) => other.indicators)}
            editing={editing === construct.id}
            onEdit={() => setEditing(editing === construct.id ? null : construct.id)}
            onChange={(patch) => updateConstruct(construct.id, patch)}
            onRemove={() => removeConstruct(construct.id)}
          />
        ))}

        <button
          type="button"
          onClick={addConstruct}
          className="flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted hover:border-accent hover:text-accent"
        >
          <Plus className="size-4" />
          {t('addConstruct')}
        </button>
      </section>

      {/* Paths */}
      {named.length >= 2 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-ink">{t('paths')}</h3>

          {value.paths.map((path, index) => (
            <div
              key={`${path.from}-${path.to}-${index}`}
              className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm"
            >
              <span className="text-ink">{path.from}</span>
              <ArrowRight className="size-3.5 shrink-0 text-muted rtl:rotate-180" />
              <span className="text-ink">{path.to}</span>
              <button
                type="button"
                onClick={() =>
                  onChange({ ...value, paths: value.paths.filter((_, i) => i !== index) })
                }
                aria-label={t('removePath')}
                className="ms-auto rounded p-1 text-muted hover:text-danger"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}

          <PathAdder
            constructs={named}
            existing={value.paths}
            onAdd={(path) => onChange({ ...value, paths: [...value.paths, path] })}
          />
        </section>
      )}

      {/*
        The diagram, drawn from the model rather than used to edit it. Seeing
        the arrows is how anyone checks they built what they meant — a list of
        paths reads correctly and still hides a structure nobody intended.
      */}
      {value.paths.length > 0 && <ModelDiagram draft={value} />}

      {/* Problems, all of them, as they appear */}
      {issues.length > 0 && (
        <Alert tone="warning">
          <ul className="flex flex-col gap-1">
            {issues.map((issue, index) => (
              <li key={index} className="flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {t(`issue.${issue.key}`, issue.params)}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onEstimate} disabled={!valid || busy}>
          {t('estimate')}
        </Button>
        <Button type="button" variant="outline" onClick={onBootstrap} disabled={!valid || busy}>
          {t('estimateWithBootstrap')}
        </Button>
        {/*
          The time is stated on the button rather than discovered afterwards. A
          minute of waiting is fine when expected and feels like a hang when not.
        */}
        <span className="self-center text-xs text-muted">{t('bootstrapNote')}</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ConstructRow({
  construct,
  columns,
  takenIndicators,
  editing,
  onEdit,
  onChange,
  onRemove,
}: {
  construct: BuilderConstruct;
  columns: ColumnSummary[];
  takenIndicators: string[];
  editing: boolean;
  onEdit: () => void;
  onChange: (patch: Partial<BuilderConstruct>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('pls');
  const [query, setQuery] = useState('');

  const taken = new Set(takenIndicators);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return columns.filter((column) => {
      if (!needle) return true;
      return (
        column.name.toLowerCase().includes(needle) ||
        column.type.toLowerCase().includes(needle) ||
        column.scale.toLowerCase().includes(needle)
      );
    });
  }, [columns, query]);

  function toggle(name: string) {
    const has = construct.indicators.includes(name);
    onChange({
      indicators: has
        ? construct.indicators.filter((entry) => entry !== name)
        : [...construct.indicators, name],
    });
  }

  return (
    <div className="rounded-lg border border-line">
      <div className="flex items-center gap-2 p-3">
        <input
          value={construct.name}
          onChange={(change) => onChange({ name: change.target.value })}
          placeholder={t('constructName')}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
        />

        {/*
          The mode is a dropdown rather than a default, because getting it wrong
          is among the most common serious errors in published PLS work:
          reflective criteria applied to a formative construct condemn it for
          the property that defines it.
        */}
        <select
          value={construct.mode}
          onChange={(change) => onChange({ mode: change.target.value as MeasurementMode })}
          className="rounded border border-line bg-transparent px-2 py-1 text-xs text-muted"
        >
          <option value="reflective">{t('mode.reflective')}</option>
          <option value="formative">{t('mode.formative')}</option>
        </select>

        <button
          type="button"
          onClick={onEdit}
          className="rounded px-2 py-1 text-xs text-accent hover:bg-subtle"
        >
          {construct.indicators.length > 0
            ? t('indicatorCount', { count: construct.indicators.length })
            : t('chooseIndicators')}
        </button>

        <button
          type="button"
          onClick={onRemove}
          aria-label={t('removeConstruct')}
          className="rounded p-1 text-muted hover:text-danger"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {construct.indicators.length > 0 && !editing && (
        <div className="flex flex-wrap gap-1 px-3 pb-3">
          {construct.indicators.map((indicator) => (
            <span key={indicator} className="rounded bg-subtle px-2 py-0.5 font-mono text-xs text-muted">
              {indicator}
            </span>
          ))}
        </div>
      )}

      {editing && (
        <div className="border-t border-line p-3">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute start-2.5 top-2.5 size-3.5 text-muted" />
            <input
              type="search"
              value={query}
              onChange={(change) => setQuery(change.target.value)}
              placeholder={t('searchIndicators')}
              autoFocus
              className="w-full rounded-lg border border-line bg-ground py-2 ps-8 pe-3 text-sm text-ink outline-none focus:border-accent"
            />
          </div>

          <div className="max-h-56 overflow-y-auto rounded-lg border border-line">
            {filtered.map((column) => {
              const selected = construct.indicators.includes(column.name);
              const elsewhere = taken.has(column.name);

              return (
                <button
                  key={column.name}
                  type="button"
                  onClick={() => toggle(column.name)}
                  /*
                   * An indicator already used by another construct is shown and
                   * disabled rather than hidden. Hiding it leaves the user
                   * searching for a column that seems to have vanished.
                   */
                  disabled={elsewhere && !selected}
                  className={cn(
                    'flex w-full items-center gap-2 border-b border-line/50 px-3 py-2 text-start last:border-0',
                    selected && 'bg-accent-soft/40',
                    elsewhere && !selected && 'cursor-not-allowed opacity-40',
                    !elsewhere && !selected && 'hover:bg-subtle',
                  )}
                >
                  <Check className={cn('size-3.5 shrink-0', selected ? 'text-accent' : 'invisible')} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-mono text-xs text-ink">{column.name}</span>
                    <span className="text-[11px] text-muted">
                      {column.type} · {column.scale}
                      {elsewhere && !selected && ` · ${t('usedElsewhere')}`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PathAdder({
  constructs,
  existing,
  onAdd,
}: {
  constructs: string[];
  existing: BuilderPath[];
  onAdd: (path: BuilderPath) => void;
}) {
  const t = useTranslations('pls');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const duplicate = existing.some((path) => path.from === from && path.to === to);
  const valid = from && to && from !== to && !duplicate;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={from}
        onChange={(change) => setFrom(change.target.value)}
        className="rounded-lg border border-line bg-transparent px-2 py-1.5 text-sm text-ink"
      >
        <option value="">{t('from')}</option>
        {constructs.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>

      <ArrowRight className="size-3.5 text-muted rtl:rotate-180" />

      <select
        value={to}
        onChange={(change) => setTo(change.target.value)}
        className="rounded-lg border border-line bg-transparent px-2 py-1.5 text-sm text-ink"
      >
        <option value="">{t('to')}</option>
        {constructs.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>

      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          onAdd({ from, to });
          setFrom('');
          setTo('');
        }}
        disabled={!valid}
      >
        <Plus className="size-3.5" />
        {t('addPath')}
      </Button>

      {duplicate && <span className="text-xs text-muted">{t('pathExists')}</span>}
    </div>
  );
}

/**
 * The model as a picture.
 *
 * Laid out by depth — constructs with no incoming arrows on the left, then
 * whatever they feed, and so on — because that is how a path model is drawn in
 * every paper, and a layout that matches the convention is read without effort.
 *
 * Plain elements rather than SVG: at this size a column layout with arrows
 * between is enough, and it inherits the page's direction so an Arabic model
 * flows right to left without a second implementation.
 */
function ModelDiagram({ draft }: { draft: PlsModelDraft }) {
  const t = useTranslations('pls');

  const layers = useMemo(() => {
    const names = draft.constructs.map((construct) => construct.name.trim()).filter(Boolean);
    const depth = new Map<string, number>();

    /*
     * Depth by relaxation rather than recursion: repeat until nothing moves,
     * bounded by the number of constructs. A cycle would make a recursive walk
     * loop forever, and the builder can hold an invalid model while it is being
     * edited.
     */
    for (const name of names) depth.set(name, 0);

    for (let pass = 0; pass < names.length; pass += 1) {
      let moved = false;
      for (const path of draft.paths) {
        const source = depth.get(path.from) ?? 0;
        const target = depth.get(path.to) ?? 0;
        if (target <= source) {
          depth.set(path.to, source + 1);
          moved = true;
        }
      }
      if (!moved) break;
    }

    const grouped = new Map<number, string[]>();
    for (const [name, level] of depth) {
      const list = grouped.get(level);
      if (list) list.push(name);
      else grouped.set(level, [name]);
    }

    return [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group);
  }, [draft]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-subtle/40 p-4">
      <span className="text-xs text-muted">{t('diagram')}</span>

      <div className="flex flex-wrap items-center gap-3 overflow-x-auto">
        {layers.map((layer, index) => (
          <div key={index} className="flex items-center gap-3">
            <div className="flex flex-col gap-2">
              {layer.map((name) => (
                <span
                  key={name}
                  className="whitespace-nowrap rounded-lg border border-accent/40 bg-surface px-3 py-1.5 text-sm text-ink"
                >
                  {name}
                </span>
              ))}
            </div>
            {index < layers.length - 1 && (
              <ArrowRight className="size-4 shrink-0 text-muted rtl:rotate-180" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export { validate as validateDraft };
