'use client';

import { BadgeCheck, FileUp, Loader2, Play, ScrollText, Quote } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Select, TextArea, TextInput } from '@/components/ui/field';

/* The API's shapes, as far as this screen reads them. */
interface Version {
  id: string;
  versionNo: number;
  rowCount?: number;
  rows?: number;
  contentHash: string;
  columns?: { name: string; type: string }[];
}
interface DatasetEntry {
  id: string;
  name: string;
  versions: Version[];
}
interface Issue {
  code: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'BLOCKING';
  columns: string[];
  message: string;
  messageAr: string;
}
interface Estimate {
  id: string;
  key: string;
  label: string;
  estimate: number;
  se: number | null;
  statistic: number | null;
  statisticName: string | null;
  df: number | null;
  df2: number | null;
  p: number | null;
  ciLow: number | null;
  ciHigh: number | null;
}
interface TableContent {
  title: string;
  columns: string[];
  rows: { text: string }[][];
  note: string;
}
interface RunDetail {
  run: { id: string; status: string; method: string | null; nUsed: number | null; engine: string; engineVersion: string; seed: number | null; issues: Issue[]; resultHash: string | null };
  estimates: Estimate[];
  tables: { id: string; content: TableContent }[];
  figures: { id: string; title: string }[];
  verified: boolean;
}

const TYPES = ['descriptives', 'reliability', 'correlation', 'regression', 'anova', 'efa', 'mediation', 'moderation', 'cfa', 'pls'] as const;
type AnalysisType = (typeof TYPES)[number];

/** The fields each analysis asks for; lists are comma-separated column names. */
const FIELDS: Record<AnalysisType, { name: string; list?: boolean }[]> = {
  descriptives: [{ name: 'variables', list: true }],
  reliability: [{ name: 'items', list: true }],
  correlation: [{ name: 'variables', list: true }],
  regression: [{ name: 'outcome' }, { name: 'predictors', list: true }],
  anova: [{ name: 'outcome' }, { name: 'group' }],
  efa: [{ name: 'items', list: true }],
  mediation: [{ name: 'x' }, { name: 'm' }, { name: 'y' }],
  moderation: [{ name: 'x' }, { name: 'w' }, { name: 'y' }],
  cfa: [],
  pls: [],
};

const fmt = (value: number | null | undefined, digits = 3) => (value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits));
const fmtP = (p: number | null) => (p === null ? '—' : p < 0.001 ? '< .001' : p.toFixed(3));

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string; messageAr: string; details?: unknown } }> {
  const response = await fetch(url, { ...init, headers: init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined });
  return response.json();
}

export function StatsWorkbench({ projectId, locale, initialDatasets }: { projectId: string; locale: 'en' | 'ar'; initialDatasets: DatasetEntry[] }) {
  const t = useTranslations('stats');
  const base = `/api/v1/projects/${projectId}`;
  const [datasets, setDatasets] = useState<DatasetEntry[]>(initialDatasets);
  const [datasetId, setDatasetId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [versionInfo, setVersionInfo] = useState<{ version: Version; issues: Issue[] } | null>(null);
  const [type, setType] = useState<AnalysisType>('regression');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState('');
  const [validation, setValidation] = useState<{ specification: Issue[]; dataset: Issue[]; runnable: boolean } | null>(null);
  const [specId, setSpecId] = useState('');
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [provenance, setProvenance] = useState<Record<string, unknown> | null>(null);
  const [claim, setClaim] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const message = useCallback((issue: { message: string; messageAr: string }) => (locale === 'ar' ? issue.messageAr : issue.message), [locale]);
  const fail = useCallback((result: { ok: false; error: { message: string; messageAr: string } }) => setError(message(result.error)), [message]);

  const loadDatasets = useCallback(async () => {
    const result = await api<{ datasets: DatasetEntry[] }>(`${base}/datasets`);
    if (result.ok) setDatasets(result.data.datasets);
  }, [base]);

  async function upload(file: File) {
    setBusy('upload');
    setError(null);
    const form = new FormData();
    form.set('file', file);
    form.set('projectId', projectId);
    const result = await api<{ dataset: { id: string } }>('/api/datasets', { method: 'POST', body: form });
    setBusy(null);
    if (!result.ok) return fail(result);
    await selectDataset(result.data.dataset.id);
    await loadDatasets();
  }

  async function selectDataset(id: string) {
    setDatasetId(id);
    setVersionId('');
    setVersionInfo(null);
    if (!id) return;
    const result = await api<{ versions: Version[] }>(`${base}/datasets/${id}/versions`);
    if (!result.ok) return fail(result);
    const latest = result.data.versions.at(-1);
    await loadDatasets();
    if (latest) await selectVersion(latest.id);
  }

  async function selectVersion(id: string) {
    setVersionId(id);
    setDetail(null);
    setValidation(null);
    const result = await api<{ version: Version; issues: Issue[] }>(`${base}/versions/${id}`);
    if (result.ok) setVersionInfo(result.data);
    else fail(result);
  }

  const columns = useMemo(() => versionInfo?.version.columns ?? [], [versionInfo]);

  function specification(): Record<string, unknown> | null {
    if (type === 'cfa' || type === 'pls') {
      try {
        return { analysisType: type, ...JSON.parse(advanced || '{}') };
      } catch {
        setError(t('invalidJson'));
        return null;
      }
    }
    const spec: Record<string, unknown> = { analysisType: type };
    for (const field of FIELDS[type]) {
      const raw = (fields[field.name] ?? '').trim();
      spec[field.name] = field.list ? raw.split(',').map((value) => value.trim()).filter(Boolean) : raw;
    }
    if (type === 'mediation') spec.bootstrap = { resamples: 5000 };
    return spec;
  }

  async function createAndRun() {
    const spec = specification();
    if (!spec || !versionId) return;
    setBusy('run');
    setError(null);
    setClaim(null);
    setProvenance(null);
    const created = await api<{ spec: { id: string }; validation: { specification: Issue[]; dataset: Issue[]; runnable: boolean } }>(`${base}/analyses/specs`, {
      method: 'POST',
      body: JSON.stringify({ datasetVersionId: versionId, spec }),
    });
    if (!created.ok) {
      setBusy(null);
      return fail(created);
    }
    setSpecId(created.data.spec.id);
    setValidation(created.data.validation);
    if (!created.data.validation.runnable) return setBusy(null);
    const run = await api<{ id: string; status: string }>(`${base}/analyses/specs/${created.data.spec.id}/runs`, { method: 'POST', body: JSON.stringify({}) });
    if (!run.ok) {
      setBusy(null);
      return fail(run);
    }
    await poll(run.data.id);
    setBusy(null);
  }

  async function poll(runId: string) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const result = await api<RunDetail>(`${base}/analyses/runs/${runId}`);
      if (!result.ok) return fail(result);
      setDetail(result.data);
      if (!['queued', 'running'].includes(result.data.run.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function showProvenance() {
    if (!detail) return;
    const result = await api<Record<string, unknown>>(`${base}/analyses/runs/${detail.run.id}/provenance`);
    if (result.ok) setProvenance(result.data);
    else fail(result);
  }

  async function cite(key: string) {
    if (!detail) return;
    setBusy(`cite:${key}`);
    const result = await api<{ text: string }>(`${base}/analyses/runs/${detail.run.id}/claims`, { method: 'POST', body: JSON.stringify({ keys: [key] }) });
    setBusy(null);
    if (result.ok) setClaim(result.data.text);
    else fail(result);
  }

  const severityTone = (severity: Issue['severity']) => (severity === 'BLOCKING' || severity === 'ERROR' ? 'danger' : severity === 'WARNING' ? 'warning' : 'neutral');

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <Alert tone="danger" title={t('error')}>
          {error}
        </Alert>
      ) : null}

      <Card>
        <CardHeader title={t('data')} description={t('dataHint')} />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label={t('dataset')} htmlFor="stats-dataset">
            <Select id="stats-dataset" value={datasetId} onChange={(event) => void selectDataset(event.target.value)}>
              <option value="">{t('chooseDataset')}</option>
              {datasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('version')} htmlFor="stats-version">
            <Select id="stats-version" value={versionId} onChange={(event) => void selectVersion(event.target.value)} disabled={!datasetId}>
              {(datasets.find((dataset) => dataset.id === datasetId)?.versions ?? []).map((version) => (
                <option key={version.id} value={version.id}>
                  v{version.versionNo} · {version.rows ?? version.rowCount} {t('rows')} · {version.contentHash.slice(0, 10)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className="mt-4 inline-flex cursor-pointer items-center gap-2 text-sm text-primary">
          {busy === 'upload' ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
          {t('upload')}
          <input data-testid="stats-upload" type="file" accept=".csv,.tsv,.xlsx" className="sr-only" onChange={(event) => event.target.files?.[0] && void upload(event.target.files[0])} />
        </label>
      </Card>

      {versionInfo ? (
        <Card>
          <CardHeader title={t('quality')} description={t('qualityHint')} />
          <p className="mt-3 text-xs text-muted">
            {t('columns')}: {columns.map((column) => `${column.name} (${column.type})`).join(', ')}
          </p>
          <ul className="mt-3 flex flex-col gap-1.5 text-sm" data-testid="stats-quality">
            {versionInfo.issues.length === 0 ? <li className="text-muted">{t('noIssues')}</li> : null}
            {versionInfo.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className="flex items-start gap-2">
                <Badge tone={severityTone(issue.severity)}>{issue.severity}</Badge>
                <span>
                  {issue.columns.length ? <strong>{issue.columns.join(', ')}: </strong> : null}
                  {message(issue)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {versionInfo ? (
        <Card>
          <CardHeader title={t('specify')} description={t('specifyHint')} />
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label={t('analysis')} htmlFor="stats-type">
              <Select id="stats-type" value={type} onChange={(event) => setType(event.target.value as AnalysisType)}>
                {TYPES.map((value) => (
                  <option key={value} value={value}>
                    {t(`types.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {FIELDS[type].map((field) => (
              <Field key={field.name} label={t(`fields.${field.name}`)} htmlFor={`stats-${field.name}`}>
                <TextInput id={`stats-${field.name}`} value={fields[field.name] ?? ''} placeholder={field.list ? 'a, b, c' : ''} onChange={(event) => setFields((current) => ({ ...current, [field.name]: event.target.value }))} />
              </Field>
            ))}
            {type === 'cfa' || type === 'pls' ? (
              <div className="sm:col-span-2">
                <Field label={t('advanced')} htmlFor="stats-advanced">
                  <TextArea id="stats-advanced" rows={5} value={advanced} onChange={(event) => setAdvanced(event.target.value)} placeholder={t('advancedHint')} />
                </Field>
              </div>
            ) : null}
          </div>
          <div className="mt-4">
            <Button data-testid="stats-run" onClick={() => void createAndRun()} disabled={busy !== null}>
              {busy === 'run' ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {t('run')}
            </Button>
          </div>
          {validation && !validation.runnable ? (
            <Alert tone="danger" className="mt-4" title={t('refused')}>
              <ul className="flex flex-col gap-1">
                {validation.specification.filter((issue) => issue.severity === 'ERROR' || issue.severity === 'BLOCKING').map((issue, index) => (
                  <li key={index}>{message(issue)}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {specId ? <p className="mt-2 text-xs text-muted">{t('specId')}: {specId}</p> : null}
        </Card>
      ) : null}

      {detail ? (
        <Card data-testid="stats-result">
          <CardHeader
            title={t('result')}
            description={`${detail.run.method ?? ''} · n = ${detail.run.nUsed ?? '—'} · ${detail.run.engine} ${detail.run.engineVersion}${detail.run.seed !== null ? ` · seed ${detail.run.seed}` : ''}`}
            action={
              detail.run.status === 'succeeded' ? (
                detail.verified ? (
                  <Badge tone="success">
                    <BadgeCheck className="size-3.5" />
                    {t('verified')}
                  </Badge>
                ) : (
                  <Badge tone="warning">{t('replaced')}</Badge>
                )
              ) : (
                <Badge tone={detail.run.status === 'failed' || detail.run.status === 'refused' ? 'danger' : 'neutral'}>{detail.run.status}</Badge>
              )
            }
          />
          {detail.run.issues.filter((issue) => issue.severity !== 'INFO').length ? (
            <ul className="mt-3 flex flex-col gap-1.5 text-sm">
              {detail.run.issues.filter((issue) => issue.severity !== 'INFO').map((issue, index) => (
                <li key={index} className="flex items-start gap-2">
                  <Badge tone={severityTone(issue.severity)}>{issue.severity}</Badge>
                  <span>{message(issue)}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {detail.tables.map((table) => (
            <div key={table.id} className="mt-5 overflow-x-auto">
              <p className="mb-2 text-sm font-semibold text-ink">{table.content.title}</p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-start text-muted">
                    {table.content.columns.map((column) => (
                      <th key={column} className="px-2 py-1 text-start font-medium">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.content.rows.map((row, index) => (
                    <tr key={index} className="border-b border-line/60">
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="px-2 py-1 tabular-nums">
                          {cell.text}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {table.content.note ? <p className="mt-1 text-xs text-muted">{table.content.note}</p> : null}
            </div>
          ))}

          {detail.figures.map((figure) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={figure.id} alt={figure.title} className="mt-5 max-w-full rounded border border-line bg-white" src={`${base}/analyses/runs/${detail.run.id}/figures/${figure.id}`} />
          ))}

          {detail.estimates.length ? (
            <details className="mt-5">
              <summary className="cursor-pointer text-sm font-semibold text-ink">{t('allValues', { count: detail.estimates.length })}</summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs" data-testid="stats-estimates">
                  <thead>
                    <tr className="border-b border-line text-muted">
                      <th className="px-2 py-1 text-start">{t('value')}</th>
                      <th className="px-2 py-1 text-start">{t('estimate')}</th>
                      <th className="px-2 py-1 text-start">SE</th>
                      <th className="px-2 py-1 text-start">{t('test')}</th>
                      <th className="px-2 py-1 text-start">p</th>
                      <th className="px-2 py-1 text-start">CI</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {detail.estimates.map((estimate) => (
                      <tr key={estimate.id} className="border-b border-line/60">
                        <td className="px-2 py-1">{estimate.label}</td>
                        <td className="px-2 py-1 tabular-nums">{fmt(estimate.estimate)}</td>
                        <td className="px-2 py-1 tabular-nums">{fmt(estimate.se)}</td>
                        <td className="px-2 py-1 tabular-nums">{estimate.statistic !== null ? `${estimate.statisticName ?? ''} = ${fmt(estimate.statistic, 2)}` : '—'}</td>
                        <td className="px-2 py-1 tabular-nums">{fmtP(estimate.p)}</td>
                        <td className="px-2 py-1 tabular-nums">{estimate.ciLow !== null ? `[${fmt(estimate.ciLow)}, ${fmt(estimate.ciHigh)}]` : '—'}</td>
                        <td className="px-2 py-1">
                          {detail.verified ? (
                            <Button size="sm" variant="ghost" data-testid={`stats-cite-${estimate.key}`} onClick={() => void cite(estimate.key)} disabled={busy !== null}>
                              <Quote className="size-3.5" />
                              {t('cite')}
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}

          {claim ? (
            <Alert tone="success" className="mt-4" title={t('inserted')}>
              <span data-testid="stats-claim">{claim}</span>
            </Alert>
          ) : null}

          {detail.run.status === 'succeeded' ? (
            <div className="mt-4">
              <Button variant="secondary" size="sm" onClick={() => void showProvenance()}>
                <ScrollText className="size-4" />
                {t('provenance')}
              </Button>
            </div>
          ) : null}
          {provenance ? (
            <pre className="mt-3 max-h-80 overflow-auto rounded bg-surface-2 p-3 text-xs" data-testid="stats-provenance" dir="ltr">
              {JSON.stringify(provenance, null, 2)}
            </pre>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
