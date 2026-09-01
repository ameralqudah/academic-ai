'use client';

import { Check, Loader2, Scale, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/cn';
import type { TitleCandidate } from '@/server/db/schema';

interface Comparison {
  comparison: {
    title: string;
    strengths: string[];
    weaknesses: string[];
    feasibility: string;
    score: number;
  }[];
  recommendation: { title: string; reason: string };
}

type Busy = 'generate' | 'improve' | 'compare' | 'select' | 'discard' | null;

export function TitleGenerator({
  projectId,
  initialTitles,
}: {
  projectId: string;
  initialTitles: TitleCandidate[];
}) {
  const t = useTranslations('titles');
  const te = useTranslations('errors');
  const tu = useTranslations('usage');
  const router = useRouter();

  const [titles, setTitles] = useState(initialTitles);
  const [chosen, setChosen] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(false);

  async function call<T>(url: string, payload: unknown): Promise<T | null> {
    setError(null);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body = (await response.json()) as
      | { ok: true; data: T }
      | { ok: false; error: { code: string; messageAr: string; message: string } };

    if (!response.ok || !body.ok) {
      if (!body.ok && body.error.code === 'PLAN_LIMIT') setLimit(true);
      else if (!body.ok && body.error.code === 'AI_UNAVAILABLE') setError(te('aiUnavailable'));
      else if (!body.ok && body.error.code === 'RATE_LIMITED') setError(te('rateLimited'));
      else setError(te('server'));
      return null;
    }

    return body.data;
  }

  async function generate() {
    setBusy('generate');
    const data = await call<TitleCandidate[]>('/api/ai/titles', { projectId, count: 10 });
    if (data) setTitles((current) => [...data, ...current]);
    setBusy(null);
  }

  async function improve(candidate: TitleCandidate) {
    setBusy('improve');
    setBusyId(candidate.id);
    const data = await call<TitleCandidate[]>('/api/ai/titles/improve', {
      projectId,
      title: candidate.title,
    });
    if (data) setTitles((current) => [...data, ...current]);
    setBusy(null);
    setBusyId(null);
  }

  async function compare() {
    setBusy('compare');
    const selected = titles.filter((title) => chosen.includes(title.id)).map((t2) => t2.title);
    const data = await call<Comparison>('/api/ai/titles/compare', { projectId, titles: selected });
    if (data) setComparison(data);
    setBusy(null);
  }

  /**
   * Removes one suggestion.
   *
   * Removed from the list immediately and restored if the request fails, rather
   * than waiting for the server: a card that lingers after a click reads as a
   * button that did not work.
   */
  async function discard(candidate: TitleCandidate) {
    setBusy('discard');
    setBusyId(candidate.id);

    const previous = titles;
    setTitles((current) => current.filter((title) => title.id !== candidate.id));

    try {
      const response = await fetch(
        `/api/ai/titles?projectId=${encodeURIComponent(projectId)}&candidateId=${encodeURIComponent(candidate.id)}`,
        { method: 'DELETE' },
      );

      if (!response.ok) setTitles(previous);
    } catch {
      setTitles(previous);
    } finally {
      setBusy(null);
      setBusyId(null);
    }
  }

  /**
   * Clears every suggestion that was not chosen.
   *
   * For a researcher who has settled and wants the rejected ones gone. The
   * selected title stays, which is why this is not "delete all".
   */
  async function clearRejected() {
    setBusy('discard');

    const previous = titles;
    setTitles((current) => current.filter((title) => title.selected));

    try {
      const response = await fetch(
        `/api/ai/titles?projectId=${encodeURIComponent(projectId)}`,
        { method: 'DELETE' },
      );

      if (!response.ok) setTitles(previous);
    } catch {
      setTitles(previous);
    } finally {
      setBusy(null);
    }
  }

  async function select(candidate: TitleCandidate) {
    setBusy('select');
    setBusyId(candidate.id);
    const data = await call<{ title: string }>('/api/ai/titles/select', {
      projectId,
      candidateId: candidate.id,
    });
    if (data) {
      setTitles((current) =>
        current.map((title) => ({ ...title, selected: title.id === candidate.id })),
      );
      router.push(`/projects/${projectId}/wizard/2`);
      router.refresh();
    }
    setBusy(null);
    setBusyId(null);
  }

  function toggleCompare(id: string) {
    setChosen((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : current.length >= 6
          ? current
          : [...current, id],
    );
  }

  if (limit) {
    return (
      <Alert tone="upgrade" title={tu('limitReachedTitle')}>
        {tu('limitReachedBody')}
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={generate} disabled={busy !== null}>
          {busy === 'generate' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="size-4" aria-hidden />
          )}
          {busy === 'generate'
            ? t('generating')
            : titles.length === 0
              ? t('generate')
              : t('generateMore')}
        </Button>

        <Button
          variant="outline"
          onClick={compare}
          disabled={busy !== null || chosen.length < 2}
        >
          {busy === 'compare' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Scale className="size-4" aria-hidden />
          )}
          {busy === 'compare' ? t('comparing') : t('compare')}
        </Button>

        <p className="text-xs text-muted">{t('compareHint')}</p>

        {/*
          Clearing the rejected suggestions, offered once there are enough for
          the list to be in the way. Below that threshold the button is clutter
          solving a problem nobody has.
        */}
        {titles.filter((title) => !title.selected).length >= 3 && (
          <Button
            variant="ghost"
            onClick={() => void clearRejected()}
            disabled={busy !== null}
            className="ms-auto text-muted hover:text-danger"
          >
            {busy === 'discard' && busyId === null ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="size-4" aria-hidden />
            )}
            {t('clearRejected')}
          </Button>
        )}
      </div>

      {comparison ? (
        <section className="surface-card flex flex-col gap-4 p-5">
          <h2 className="text-base font-semibold text-ink">{t('comparisonTitle')}</h2>

          <div className="flex flex-col gap-3">
            {comparison.comparison.map((entry) => (
              <article key={entry.title} className="flex flex-col gap-2 border-b border-line pb-3 last:border-b-0">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-medium text-ink">{entry.title}</h3>
                  <span className="tabular shrink-0 text-sm font-semibold text-primary">
                    {entry.score}
                  </span>
                </div>
                <div className="grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <p className="mb-1 font-medium text-success">{t('strengths')}</p>
                    <ul className="list-disc space-y-0.5 ps-4 text-ink-soft">
                      {entry.strengths.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-1 font-medium text-warning">{t('weaknesses')}</p>
                    <ul className="list-disc space-y-0.5 ps-4 text-ink-soft">
                      {entry.weaknesses.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <p className="text-xs text-muted">
                  <span className="font-medium">{t('feasibility')}: </span>
                  {entry.feasibility}
                </p>
              </article>
            ))}
          </div>

          <Alert tone="success" title={t('recommendation')}>
            <p className="font-medium text-ink">{comparison.recommendation.title}</p>
            <p className="mt-1">{comparison.recommendation.reason}</p>
          </Alert>
        </section>
      ) : null}

      {titles.length === 0 ? (
        <p className="surface-card p-8 text-sm text-muted">{t('empty')}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {titles.map((candidate) => {
            const inComparison = chosen.includes(candidate.id);

            return (
              <article
                key={candidate.id}
                className={cn(
                  'surface-card flex flex-col gap-4 p-5',
                  candidate.selected ? 'border-success ring-1 ring-success/25' : '',
                  inComparison ? 'border-primary' : '',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-[1.02rem] leading-snug font-semibold text-ink">
                    {candidate.title}
                  </h3>
                  {candidate.selected ? (
                    <Badge tone="success">
                      <Check className="size-3" aria-hidden />
                      {t('selected')}
                    </Badge>
                  ) : null}
                </div>

                {candidate.rationale ? (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium tracking-wide text-muted uppercase">
                      {t('rationale')}
                    </p>
                    <p className="text-sm leading-relaxed text-ink-soft">{candidate.rationale}</p>
                  </div>
                ) : null}

                {candidate.researchProblem ? (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium tracking-wide text-muted uppercase">
                      {t('researchProblem')}
                    </p>
                    <p className="text-sm leading-relaxed text-ink-soft">
                      {candidate.researchProblem}
                    </p>
                  </div>
                ) : null}

                {candidate.variables.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-medium tracking-wide text-muted uppercase">
                      {t('variables')}
                    </p>
                    <ul className="flex flex-wrap gap-1.5">
                      {candidate.variables.map((variable) => (
                        <li key={variable}>
                          <Badge tone="accent">{variable}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="text-muted">{t('fit')}</span>
                      <span className="tabular text-ink">{candidate.fitScore}</span>
                    </div>
                    <Progress value={candidate.fitScore} tone="primary" label={t('fit')} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="text-muted">{t('innovation')}</span>
                      <span className="tabular text-ink">{candidate.innovationScore}</span>
                    </div>
                    <Progress
                      value={candidate.innovationScore}
                      tone="accent"
                      label={t('innovation')}
                    />
                  </div>
                </div>

                <div className="mt-auto flex flex-wrap gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={() => select(candidate)}
                    disabled={busy !== null || candidate.selected}
                  >
                    {busy === 'select' && busyId === candidate.id ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : null}
                    {candidate.selected ? t('selected') : t('select')}
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => improve(candidate)}
                    disabled={busy !== null}
                  >
                    {busy === 'improve' && busyId === candidate.id ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <Wand2 className="size-4" aria-hidden />
                    )}
                    {t('improve')}
                  </Button>

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => toggleCompare(candidate.id)}
                    disabled={busy !== null}
                  >
                    {inComparison ? t('removeFromCompare') : t('selectForCompare')}
                  </Button>

                  {/*
                    Removing a suggestion. There was no way to: three batches of
                    five leaves fifteen candidates, most rejected on sight, and
                    the useful ones end up buried under the discarded.

                    The chosen title has no delete — it is the project's working
                    title, and removing it would leave the project without one.
                    Choosing a different title is the way to change it.
                  */}
                  {!candidate.selected && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void discard(candidate)}
                      disabled={busy !== null}
                      aria-label={t('discard')}
                      className="ms-auto text-muted hover:text-danger"
                    >
                      {busy === 'discard' && busyId === candidate.id ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                      ) : (
                        <Trash2 className="size-4" aria-hidden />
                      )}
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
