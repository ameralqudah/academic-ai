'use client';

import { AlertTriangle, CheckCircle2, HelpCircle, Info, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/cn';

/**
 * Draws a statistical result inside the conversation.
 *
 * The structure here mirrors what a supervisor expects to see, in the order
 * they expect it, and that order is a deliberate argument rather than a layout
 * choice.
 *
 * **The effect size sits beside the p-value, not below it.** A p-value answers
 * "could this be chance"; with four hundred respondents a difference of no
 * consequence clears .05. Putting the magnitude anywhere less prominent invites
 * the reader to report significance and call it a finding.
 *
 * **The assumptions are shown, not hidden behind a toggle.** A violated
 * assumption changes which test is correct, and a researcher who has to click
 * to discover that Levene failed will not click.
 *
 * **The warnings come last and are impossible to miss.** A reverse-coded item,
 * a sample of twenty, a correlation whose interval crosses zero — these are the
 * things that separate a number from a finding, and they are the reason this
 * panel exists at all rather than just printing the coefficient.
 */

interface Estimate {
  label: string;
  n: number;
  mean: number;
  sd: number;
}

interface Assumption {
  key: string;
  status: 'met' | 'violated' | 'inconclusive' | 'not-testable';
  statistic?: number;
  pValue?: number;
}

interface Warning {
  code: string;
  severity: 'info' | 'warning' | 'error';
  columns?: string[];
  params?: Record<string, string | number>;
}

export interface StatisticalResult {
  test: string;
  variables: string[];
  statistic: { name: string; value: number };
  df: number | [number, number];
  pValue: number;
  effect: { name: string; value: number; band: string } | null;
  estimates: Estimate[];
  assumptions: Assumption[];
  warnings: Warning[];
  n: number;
  rowsDropped: number;
  secondary?: {
    label: string;
    statistic: { name: string; value: number };
    df: number | [number, number];
    pValue: number;
  };
  detail?: Record<string, unknown>;
}

/** Three decimals is the reporting convention; p is given more room in the tail. */
function fmt(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/**
 * Formats a p-value.
 *
 * Below .001 it is written as "< .001" rather than as a long decimal, which is
 * the convention in every style guide a thesis will be held to — and avoids
 * implying a precision the number does not carry.
 */
function fmtP(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p < 0.001) return '< .001';
  return p.toFixed(3);
}

function fmtDf(df: number | [number, number]): string {
  return Array.isArray(df) ? `${fmt(df[0], 0)}, ${fmt(df[1], 2)}` : fmt(df, 2);
}

export function ResultCard({ result }: { result: StatisticalResult }) {
  const t = useTranslations('agent');

  const significant = result.pValue < 0.05;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
      {/* Headline: the statistic, its p-value, and the size of the effect. */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <span className="font-mono text-sm text-ink">
          {result.statistic.name} ({fmtDf(result.df)}) = {fmt(result.statistic.value)}
        </span>
        <span
          className={cn(
            'font-mono text-sm font-semibold',
            significant ? 'text-ink' : 'text-muted',
          )}
        >
          p = {fmtP(result.pValue)}
        </span>
        {result.effect && (
          <span className="font-mono text-sm text-muted">
            {result.effect.name} = {fmt(result.effect.value)}
            <span className="ms-1.5 rounded bg-subtle px-1.5 py-0.5 text-xs">
              {t(`effect.${result.effect.band}`)}
            </span>
          </span>
        )}
        <span className="text-xs text-muted">n = {result.n}</span>
      </div>

      {/*
        The secondary form — Student's t beside Welch's, most often. Shown
        because examiners expect it and because the two disagreeing is itself
        informative, but never presented as the primary answer.
      */}
      {result.secondary && (
        <div className="flex flex-wrap items-baseline gap-x-4 border-s-2 border-line ps-3 text-xs text-muted">
          <span>{t(`secondary.${result.secondary.label}`)}</span>
          <span className="font-mono">
            {result.secondary.statistic.name} ({fmtDf(result.secondary.df)}) ={' '}
            {fmt(result.secondary.statistic.value)}
          </span>
          <span className="font-mono">p = {fmtP(result.secondary.pValue)}</span>
        </div>
      )}

      {/* Group means, when the test compares groups. */}
      {result.estimates.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-start text-xs text-muted">
              <th className="py-1.5 text-start font-medium">{t('table.group')}</th>
              <th className="py-1.5 text-end font-medium">n</th>
              <th className="py-1.5 text-end font-medium">{t('table.mean')}</th>
              <th className="py-1.5 text-end font-medium">{t('table.sd')}</th>
            </tr>
          </thead>
          <tbody>
            {result.estimates.map((estimate) => (
              <tr key={estimate.label} className="border-b border-line/50 last:border-0">
                <td className="py-1.5 text-ink">{estimate.label}</td>
                <td className="py-1.5 text-end font-mono text-muted">{estimate.n}</td>
                <td className="py-1.5 text-end font-mono text-ink">{fmt(estimate.mean, 2)}</td>
                <td className="py-1.5 text-end font-mono text-muted">{fmt(estimate.sd, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Assumptions, always visible. */}
      {result.assumptions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">{t('assumptions')}</span>
          {result.assumptions.map((assumption, index) => (
            <div key={`${assumption.key}-${index}`} className="flex items-center gap-2 text-xs">
              <AssumptionIcon status={assumption.status} />
              <span className="text-ink">{t(`assumption.${assumption.key}`)}</span>
              <span className="text-muted">{t(`status.${assumption.status}`)}</span>
              {assumption.pValue !== undefined && (
                <span className="font-mono text-muted">p = {fmtP(assumption.pValue)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Warnings last, and loudest — these are what turn a number into a finding. */}
      {result.warnings.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {result.warnings.map((warning, index) => (
            <div
              key={`${warning.code}-${index}`}
              className={cn(
                'flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs',
                warning.severity === 'error' && 'bg-danger/10 text-danger',
                warning.severity === 'warning' && 'bg-warning/10 text-warning-strong',
                warning.severity === 'info' && 'bg-subtle text-muted',
              )}
            >
              <WarningIcon severity={warning.severity} />
              <span>
                {t(`warning.${warning.code}`, { ...(warning.params ?? {}) })}
                {warning.columns && warning.columns.length > 0 && (
                  <span className="ms-1 font-mono">({warning.columns.join(', ')})</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {result.rowsDropped > 0 && (
        <p className="text-xs text-muted">{t('rowsDropped', { count: result.rowsDropped })}</p>
      )}
    </div>
  );
}

function AssumptionIcon({ status }: { status: Assumption['status'] }) {
  if (status === 'met') return <CheckCircle2 className="size-3.5 shrink-0 text-success" />;
  if (status === 'violated') return <XCircle className="size-3.5 shrink-0 text-danger" />;
  if (status === 'not-testable') return <HelpCircle className="size-3.5 shrink-0 text-muted" />;
  return <Info className="size-3.5 shrink-0 text-muted" />;
}

function WarningIcon({ severity }: { severity: Warning['severity'] }) {
  if (severity === 'info') return <Info className="mt-0.5 size-3.5 shrink-0" />;
  return <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />;
}
