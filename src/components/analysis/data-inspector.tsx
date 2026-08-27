'use client';

import { AlertTriangle, FileSpreadsheet, Info, Loader2, ShieldCheck, Upload, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { CleaningAction, DataIssue, DatasetProfile } from '@/analysis/types';

interface Inspection {
  profile: DatasetProfile;
  proposals: CleaningAction[];
  preview: { columns: string[]; rows: (string | number | boolean | null)[][] };
  notices: { key: string; params?: Record<string, string | number> }[];
}

interface CleanOutcome {
  csv: string;
  reportText: string;
  filename: string;
  report: { rowsRemoved: number; columnsRemoved: number; cellsChanged: number };
}

/**
 * Upload, inspect, choose, clean.
 *
 * The file never leaves the browser except to be read: it is posted for
 * profiling, posted again for cleaning, and stored nowhere in between. That
 * costs one extra upload and buys a guarantee worth more than the milliseconds
 * — there is no server-side copy of a researcher's data to leak or to drift.
 */
export function DataInspector() {
  const t = useTranslations('analysis');

  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outcome, setOutcome] = useState<CleanOutcome | null>(null);
  const [busy, setBusy] = useState<'inspect' | 'clean' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function inspect(chosen: File) {
    setBusy('inspect');
    setError(null);
    setInspection(null);
    setOutcome(null);

    try {
      const form = new FormData();
      form.append('file', chosen);
      const response = await fetch('/api/analysis/profile', { method: 'POST', body: form });
      const payload = await response.json();

      if (!payload.ok) {
        setError(payload.error?.messageAr ?? payload.error?.message ?? t('error.generic'));
        return;
      }

      const data = payload.data as Inspection;
      setInspection(data);
      setFile(chosen);
      setSelected(
        new Set(data.proposals.filter((action) => action.recommended).map((action) => action.kind)),
      );
    } catch {
      setError(t('error.network'));
    } finally {
      setBusy(null);
    }
  }

  async function clean() {
    if (!file || !inspection) return;
    setBusy('clean');
    setError(null);

    try {
      const form = new FormData();
      form.append('file', file);
      form.append(
        'actions',
        JSON.stringify(inspection.proposals.filter((action) => selected.has(action.kind))),
      );
      const response = await fetch('/api/analysis/clean', { method: 'POST', body: form });
      const payload = await response.json();

      if (!payload.ok) {
        setError(payload.error?.messageAr ?? payload.error?.message ?? t('error.generic'));
        return;
      }

      setOutcome(payload.data as CleanOutcome);
    } catch {
      setError(t('error.network'));
    } finally {
      setBusy(null);
    }
  }

  function download(content: string, filename: string, type = 'text/csv;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ------------------------------- upload ------------------------------ */}
      <Card className="flex flex-col gap-4">
        <CardHeader title={t('upload.title')} description={t('upload.description')} />

        <input
          ref={inputRef}
          type="file"
          accept=".csv,.tsv,.txt,.xlsx,.xlsm"
          className="hidden"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            if (chosen) void inspect(chosen);
          }}
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => inputRef.current?.click()} disabled={busy !== null}>
            {busy === 'inspect' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {t('upload.button')}
          </Button>
          {file ? (
            <span className="flex items-center gap-2 text-sm text-muted" dir="ltr">
              <FileSpreadsheet className="size-4" />
              {file.name}
            </span>
          ) : null}
        </div>

        <p className="text-xs text-muted">{t('upload.privacy')}</p>
      </Card>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {inspection ? (
        <>
          {inspection.notices.map((notice) => (
            <Alert key={notice.key} tone="warning">
              {t(notice.key.replace('analysis.', ''), notice.params ?? {})}
            </Alert>
          ))}

          <Summary profile={inspection.profile} />
          <Columns profile={inspection.profile} />
          <Issues issues={inspection.profile.issues} />

          {/* ----------------------------- cleaning ---------------------------- */}
          <Card className="flex flex-col gap-4">
            <CardHeader title={t('clean.title')} description={t('clean.description')} />

            {inspection.proposals.length === 0 ? (
              <p className="text-sm text-muted">{t('clean.nothingToDo')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {inspection.proposals.map((action) => (
                  <li key={action.kind}>
                    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 hover:bg-surface-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selected.has(action.kind)}
                        onChange={(event) => {
                          const next = new Set(selected);
                          if (event.target.checked) next.add(action.kind);
                          else next.delete(action.kind);
                          setSelected(next);
                        }}
                      />
                      <span className="flex flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-2 text-sm text-ink">
                          {t(`clean.action.${action.kind}`)}
                          {action.destructive ? (
                            <Badge tone="warning">{t('clean.destructive')}</Badge>
                          ) : null}
                          {action.recommended ? (
                            <Badge tone="success">{t('clean.recommended')}</Badge>
                          ) : null}
                        </span>
                        <span className="text-xs text-muted">
                          {t(action.reasonKey.replace('analysis.', ''), action.reasonParams ?? {})}
                        </span>
                        {action.columns.length > 0 ? (
                          <span className="text-xs text-muted" dir="ltr">
                            {action.columns.slice(0, 6).join(' · ')}
                            {action.columns.length > 6 ? ` +${action.columns.length - 6}` : ''}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void clean()} disabled={busy !== null}>
                {busy === 'clean' ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                {t('clean.run')}
              </Button>
              <span className="text-xs text-muted">{t('clean.originalSafe')}</span>
            </div>
          </Card>

          {outcome ? (
            <Card className="flex flex-col gap-4">
              <CardHeader title={t('result.title')} description={t('result.description')} />
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label={t('result.rowsRemoved')} value={outcome.report.rowsRemoved} />
                <Stat label={t('result.columnsRemoved')} value={outcome.report.columnsRemoved} />
                <Stat label={t('result.cellsChanged')} value={outcome.report.cellsChanged} />
              </div>
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => download(outcome.csv, outcome.filename)}>
                  {t('result.downloadData')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    download(
                      outcome.reportText,
                      outcome.filename.replace(/\.csv$/, '-report.md'),
                      'text/markdown;charset=utf-8',
                    )
                  }
                >
                  {t('result.downloadReport')}
                </Button>
              </div>
              <pre className="max-h-72 overflow-auto rounded-lg bg-surface-2 p-4 text-xs whitespace-pre-wrap text-ink-soft">
                {outcome.reportText}
              </pre>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="tabular text-xl font-semibold text-ink">{value}</p>
    </div>
  );
}

function Summary({ profile }: { profile: DatasetProfile }) {
  const t = useTranslations('analysis');
  return (
    <Card className="flex flex-col gap-4">
      <CardHeader title={t('summary.title')} />
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label={t('summary.rows')} value={profile.rowCount} />
        <Stat label={t('summary.columns')} value={profile.columnCount} />
        <Stat label={t('summary.missing')} value={profile.missingCells} />
        <Stat
          label={t('summary.completeness')}
          value={Number((profile.completeness * 100).toFixed(1))}
        />
      </div>
    </Card>
  );
}

function Columns({ profile }: { profile: DatasetProfile }) {
  const t = useTranslations('analysis');
  return (
    <Card className="flex flex-col gap-4">
      <CardHeader title={t('columns.title')} description={t('columns.description')} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              <th className="py-2 text-start font-medium">{t('columns.name')}</th>
              <th className="py-2 text-start font-medium">{t('columns.type')}</th>
              <th className="py-2 text-start font-medium">{t('columns.scale')}</th>
              <th className="py-2 text-end font-medium">{t('columns.present')}</th>
              <th className="py-2 text-end font-medium">{t('columns.missing')}</th>
              <th className="py-2 text-end font-medium">{t('columns.distinct')}</th>
              <th className="py-2 text-end font-medium">{t('columns.mean')}</th>
              <th className="py-2 text-end font-medium">{t('columns.sd')}</th>
            </tr>
          </thead>
          <tbody>
            {profile.columns.map((column) => (
              <tr key={column.name} className="border-b border-line last:border-b-0">
                <td className="py-2.5 text-ink" dir="ltr">
                  {column.name}
                </td>
                <td className="py-2.5">
                  <Badge tone="neutral">{t(`type.${column.type}`)}</Badge>
                </td>
                <td className="py-2.5 text-xs text-muted">{t(`scale.${column.scale}`)}</td>
                <td className="tabular py-2.5 text-end text-ink-soft">{column.present}</td>
                <td className="tabular py-2.5 text-end text-ink-soft">
                  {column.missing > 0 ? `${column.missing} (${column.missingPercent.toFixed(1)}%)` : '—'}
                </td>
                <td className="tabular py-2.5 text-end text-ink-soft">{column.distinct}</td>
                <td className="tabular py-2.5 text-end text-ink-soft">
                  {column.numeric ? column.numeric.mean.toFixed(2) : '—'}
                </td>
                <td className="tabular py-2.5 text-end text-ink-soft">
                  {column.numeric ? column.numeric.sd.toFixed(2) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const ISSUE_ICON = {
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
} as const;

function Issues({ issues }: { issues: DataIssue[] }) {
  const t = useTranslations('analysis');

  if (issues.length === 0) {
    return (
      <Alert tone="success" title={t('issues.noneTitle')}>
        {t('issues.none')}
      </Alert>
    );
  }

  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader title={t('issues.title')} description={t('issues.description')} />
      <ul className="flex flex-col gap-2">
        {sorted.map((issue, index) => {
          const Icon = ISSUE_ICON[issue.severity];
          return (
            <li
              key={`${issue.kind}-${issue.column ?? 'table'}-${index}`}
              className="flex items-start gap-3 rounded-lg border border-line p-3"
            >
              <Icon
                className={
                  issue.severity === 'error'
                    ? 'mt-0.5 size-4 shrink-0 text-danger'
                    : issue.severity === 'warning'
                      ? 'mt-0.5 size-4 shrink-0 text-warning'
                      : 'mt-0.5 size-4 shrink-0 text-muted'
                }
              />
              <div className="flex flex-col gap-0.5">
                <p className="text-sm text-ink">
                  {t(`issue.${issue.kind}`, { count: issue.count })}
                  {issue.column ? (
                    <span className="text-muted" dir="ltr">
                      {' '}
                      · {issue.column}
                    </span>
                  ) : null}
                </p>
                {issue.sampleRows.length > 0 ? (
                  <p className="text-xs text-muted">
                    {t('issue.sampleRows', {
                      rows: issue.sampleRows.map((row) => row + 2).join(', '),
                    })}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
