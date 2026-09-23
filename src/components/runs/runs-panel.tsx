'use client';

import { Ban, CheckCircle2, Circle, Clock, Loader2, Play, ShieldCheck, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Select, TextArea } from '@/components/ui/field';

/*
 * Research runs (P1-D): the minimum interface to see what a run is doing,
 * why each step was allowed, which action waits for approval, and what
 * happened. Everything shown comes from the server; approval sends back the
 * exact action hash it displayed.
 */

interface Run {
  id: string;
  intent: string;
  status: string;
  stopReason: string | null;
  createdAt: string;
  planner: { model?: string; provider?: string } | null;
}
interface Step {
  id: string;
  seq: number;
  tool: string;
  toolVersion: string;
  label: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  policy: { outcome?: string; reason?: string | null; rules?: { rule: string; ok: boolean; detail: string | null }[] } | null;
  outputRef: { kind: string; id: string } | null;
  error: { code?: string; message?: string } | null;
}
interface Approval {
  id: string;
  stepId: string;
  status: string;
  reason: string;
  actionHash: string;
  expiresAt: string;
  action: {
    tool?: string;
    risk?: string;
    sideEffect?: string;
    summary?: { en?: string; ar?: string };
    preview?: { items?: unknown[] };
  };
}
interface RunEvent {
  id: number;
  type: string;
  createdAt: string;
}
interface Detail {
  run: Run;
  steps: Step[];
  approvals: Approval[];
  events: RunEvent[];
  role: string;
}
interface VersionOption {
  id: string;
  label: string;
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

function tone(status: string): 'success' | 'danger' | 'warning' | 'accent' | 'neutral' {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'FAILED' || status === 'REJECTED') return 'danger';
  if (status === 'WAITING_APPROVAL' || status === 'PENDING') return 'warning';
  if (status === 'RUNNING' || status === 'PLANNING' || status === 'AUTHORIZED') return 'accent';
  return 'neutral';
}

function StepIcon({ status }: { status: string }) {
  if (status === 'SUCCEEDED') return <CheckCircle2 className="size-4 text-success" aria-hidden />;
  if (status === 'FAILED') return <XCircle className="size-4 text-danger" aria-hidden />;
  if (status === 'RUNNING') return <Loader2 className="size-4 animate-spin text-accent" aria-hidden />;
  if (status === 'WAITING_APPROVAL') return <Clock className="size-4 text-warning" aria-hidden />;
  if (status === 'CANCELLED' || status === 'SKIPPED') return <Ban className="size-4 text-muted" aria-hidden />;
  return <Circle className="size-4 text-muted" aria-hidden />;
}

export function RunsPanel({ projectId, locale, initialRuns, versions }: { projectId: string; locale: 'en' | 'ar'; initialRuns: Run[]; versions: VersionOption[] }) {
  const t = useTranslations('runs');
  const [runs, setRuns] = useState<Run[]>(initialRuns);
  const [intent, setIntent] = useState('');
  const [versionId, setVersionId] = useState('');
  const [selected, setSelected] = useState<string | null>(initialRuns[0]?.id ?? null);
  const [loaded, setDetail] = useState<Detail | null>(null);
  // Only the selected run's detail is shown; a previous run's never stands in for it.
  const detail = loaded && loaded.run.id === selected ? loaded : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/v1/projects/${projectId}/runs`;
  const state = (value: string) => (t.has(`state.${value}`) ? t(`state.${value}`) : value);

  const refresh = useCallback(
    async (runId: string) => {
      const response = await fetch(`${base}/${runId}`);
      if (!response.ok) return;
      const body = (await response.json()) as { data: Detail };
      setDetail(body.data);
      setRuns((current) => current.map((run) => (run.id === runId ? body.data.run : run)));
    },
    [base],
  );

  // One effect loads the selected run and keeps polling while it is live.
  // The first fetch is deferred so no state is set synchronously in the effect.
  const polling = !!selected && (!detail || !TERMINAL.has(detail.run.status));
  useEffect(() => {
    if (!selected || !polling) return;
    const kick = setTimeout(() => void refresh(selected), 0);
    const timer = setInterval(() => void refresh(selected), 2000);
    return () => {
      clearTimeout(kick);
      clearInterval(timer);
    };
  }, [selected, polling, refresh]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `ui-${crypto.randomUUID()}` },
        body: JSON.stringify({ intent, ...(versionId ? { datasetVersionId: versionId } : {}) }),
      });
      const body = (await response.json()) as { data?: { run: Run }; error?: { message?: string; messageAr?: string } };
      if (!response.ok || !body.data) {
        setError((locale === 'ar' ? body.error?.messageAr : body.error?.message) ?? t('error'));
        return;
      }
      setRuns((current) => [body.data!.run, ...current]);
      setSelected(body.data.run.id);
      setIntent('');
    } catch {
      setError(t('error'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(runId: string) {
    setBusy(true);
    try {
      await fetch(`${base}/${runId}`, { method: 'DELETE' });
      await refresh(runId);
    } finally {
      setBusy(false);
    }
  }

  async function decide(approval: Approval, decision: 'approve' | 'reject') {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${base}/${detail.run.id}/approvals/${approval.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, actionHash: approval.actionHash }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string; messageAr?: string } } | null;
        setError((locale === 'ar' ? body?.error?.messageAr : body?.error?.message) ?? t('error'));
      }
      await refresh(detail.run.id);
    } finally {
      setBusy(false);
    }
  }

  const pending = detail?.approvals.filter((approval) => approval.status === 'PENDING') ?? [];
  const canAct = detail ? detail.role !== 'VIEWER' : false;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title={t('title')} description={t('intro')} />
        <div className="mt-4 flex flex-col gap-3">
          <Field label={t('intent')} htmlFor="run-intent">
            <TextArea id="run-intent" value={intent} maxLength={4000} placeholder={t('intentPlaceholder')} onChange={(event) => setIntent(event.target.value)} />
          </Field>
          <Field label={t('dataset')} htmlFor="run-dataset">
            <Select id="run-dataset" value={versionId} onChange={(event) => setVersionId(event.target.value)}>
              <option value="">{t('noDataset')}</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.label}
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <Button data-testid="runs-start" onClick={() => void start()} disabled={busy || intent.trim().length === 0}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
              {busy ? t('starting') : t('start')}
            </Button>
          </div>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
      </Card>

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader title={t('runs')} />
          <ul className="mt-3 flex flex-col gap-2" data-testid="runs-list">
            {runs.length === 0 ? <li className="text-sm text-muted">{t('noRuns')}</li> : null}
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => setSelected(run.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-start text-sm transition-colors ${selected === run.id ? 'border-accent bg-accent-soft/40' : 'border-line hover:border-line-strong'}`}
                >
                  <span className="line-clamp-2 text-ink">{run.intent}</span>
                  <span className="mt-1 flex items-center gap-2">
                    <Badge tone={tone(run.status)}>{state(run.status)}</Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        {detail ? (
          <Card data-testid="runs-detail">
            <CardHeader
              title={detail.run.intent}
              description={detail.run.planner?.model ? `${t('planner')} ${detail.run.planner.model}` : undefined}
              action={
                !TERMINAL.has(detail.run.status) && canAct ? (
                  <Button variant="outline" size="sm" data-testid="runs-cancel" disabled={busy} onClick={() => void cancel(detail.run.id)}>
                    {t('cancel')}
                  </Button>
                ) : null
              }
            />
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">{t('status')}:</span>
              <Badge tone={tone(detail.run.status)}>
                <span data-testid="runs-status">{state(detail.run.status)}</span>
              </Badge>
              {detail.run.stopReason && detail.run.stopReason !== 'completed' ? (
                <span className="text-muted">
                  {t('stopReason')}: <code>{detail.run.stopReason}</code>
                </span>
              ) : null}
            </div>

            {pending.map((approval) => (
              <div key={approval.id} className="mt-4 rounded-lg border border-warning/40 bg-warning/5 p-4" data-testid="runs-approval">
                <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <ShieldCheck className="size-4 text-warning" aria-hidden />
                  {t('approvalTitle')}
                </div>
                <p className="mt-2 text-sm text-ink">{(locale === 'ar' ? approval.action.summary?.ar : approval.action.summary?.en) ?? approval.reason}</p>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted">
                  <dt>{t('tool')}</dt>
                  <dd><code>{approval.action.tool}</code></dd>
                  <dt>{t('effect')}</dt>
                  <dd>{approval.action.sideEffect}</dd>
                  <dt>{t('risk')}</dt>
                  <dd>{approval.action.risk}</dd>
                  {approval.action.preview?.items ? (
                    <>
                      <dt>{t('affected')}</dt>
                      <dd>{approval.action.preview.items.length}</dd>
                    </>
                  ) : null}
                  <dt>{t('actionHash')}</dt>
                  <dd><code>{approval.actionHash.slice(0, 12)}…</code></dd>
                  <dt>{t('expires')}</dt>
                  <dd>{new Date(approval.expiresAt).toLocaleString(locale)}</dd>
                </dl>
                <p className="mt-2 text-xs text-muted">{t('approvalHint')}</p>
                {canAct ? (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" data-testid="runs-approve" disabled={busy} onClick={() => void decide(approval, 'approve')}>
                      {t('approve')}
                    </Button>
                    <Button size="sm" variant="outline" data-testid="runs-reject" disabled={busy} onClick={() => void decide(approval, 'reject')}>
                      {t('reject')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}

            <h3 className="mt-5 text-sm font-semibold text-ink">{t('steps')}</h3>
            <ol className="mt-2 flex flex-col gap-2" data-testid="runs-steps">
              {detail.steps.map((step) => (
                <li key={step.id} className="rounded-lg border border-line p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <StepIcon status={step.status} />
                    <span className="font-medium text-ink">{step.label}</span>
                    <code className="text-xs text-muted">
                      {step.tool}@{step.toolVersion}
                    </code>
                    <Badge tone={tone(step.status)}>{state(step.status)}</Badge>
                  </div>
                  {step.error?.code ? <p className="mt-1 text-xs text-danger">{step.error.message ?? step.error.code}</p> : null}
                  {step.outputRef ? (
                    <p className="mt-1 text-xs text-muted">
                      {t('output')}: <code>{step.outputRef.kind}</code> <code>{step.outputRef.id.slice(0, 8)}</code>
                    </p>
                  ) : null}
                  {step.policy?.rules ? (
                    <details className="mt-1 text-xs text-muted">
                      <summary>{t('policy')}</summary>
                      <ul className="mt-1">
                        {step.policy.rules.map((rule) => (
                          <li key={rule.rule}>
                            {rule.ok ? '✓' : '✗'} {rule.rule}
                            {rule.detail ? ` — ${rule.detail}` : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              ))}
            </ol>

            <details className="mt-4 text-xs text-muted">
              <summary>
                {t('events')} ({detail.events.length})
              </summary>
              <ul className="mt-1 max-h-60 overflow-auto">
                {detail.events.map((event) => (
                  <li key={event.id}>
                    <code>{event.type}</code> · {new Date(event.createdAt).toLocaleTimeString(locale)}
                  </li>
                ))}
              </ul>
            </details>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
