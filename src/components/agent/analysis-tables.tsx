'use client';

/**
 * The tables a statistics package prints, drawn from the engine's results.
 *
 * Descriptive Statistics and Frequencies as SPSS lays them out, and a
 * confirmatory factor analysis as AMOS reports it: fit, loadings, reliability
 * and validity. The numbers are the engine's; this component only formats them
 * to the decimals a methods chapter uses.
 */

import { useTranslations } from 'next-intl';

import type { DescriptiveTables } from '@/analysis/descriptives';
import { FigurePreview } from '@/components/agent/task-progress';

const cell = 'px-2 py-1.5 font-mono text-end text-ink';
const head = 'px-2 py-1.5 text-xs font-medium text-muted';

function fixed(value: number | undefined, digits = 3): string {
  return value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

function Table({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
      <span className="text-sm font-semibold text-ink">{title}</span>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" dir="ltr">
          {children}
        </table>
      </div>
    </div>
  );
}

export function DescriptivesView({ payload }: { payload: unknown }) {
  const t = useTranslations('tables');
  const data = payload as DescriptiveTables | null;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-3">
      {data.descriptives.length > 0 && (
        <Table title={t('descriptives')}>
          <thead>
            <tr className="border-b border-line">
              <th className={`${head} text-start`}>{t('variable')}</th>
              <th className={`${head} text-end`}>N</th>
              <th className={`${head} text-end`}>{t('minimum')}</th>
              <th className={`${head} text-end`}>{t('maximum')}</th>
              <th className={`${head} text-end`}>{t('mean')}</th>
              <th className={`${head} text-end`}>{t('sd')}</th>
              <th className={`${head} text-end`}>{t('skewness')}</th>
              <th className={`${head} text-end`}>{t('kurtosis')}</th>
            </tr>
          </thead>
          <tbody>
            {data.descriptives.map((row) => (
              <tr key={row.variable} className="border-b border-line/50 last:border-0">
                <td className="px-2 py-1.5 text-start text-ink">{row.variable}</td>
                <td className={cell}>{row.n}</td>
                <td className={cell}>{fixed(row.min, 2)}</td>
                <td className={cell}>{fixed(row.max, 2)}</td>
                <td className={cell}>{fixed(row.mean, 2)}</td>
                <td className={cell}>{fixed(row.sd, 3)}</td>
                <td className={cell}>{fixed(row.skewness, 3)}</td>
                <td className={cell}>{fixed(row.kurtosis, 3)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {data.frequencies.map((table) => (
        <Table key={table.variable} title={table.variable}>
          <thead>
            <tr className="border-b border-line">
              <th className={`${head} text-start`}>{t('value')}</th>
              <th className={`${head} text-end`}>{t('frequency')}</th>
              <th className={`${head} text-end`}>{t('percent')}</th>
              <th className={`${head} text-end`}>{t('validPercent')}</th>
              <th className={`${head} text-end`}>{t('cumulativePercent')}</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.value} className="border-b border-line/50">
                <td className="px-2 py-1.5 text-start text-ink" dir="auto">
                  {row.value}
                </td>
                <td className={cell}>{row.frequency}</td>
                <td className={cell}>{fixed(row.percent, 1)}</td>
                <td className={cell}>{fixed(row.validPercent, 1)}</td>
                <td className={cell}>{fixed(row.cumulativePercent, 1)}</td>
              </tr>
            ))}
            {table.missing > 0 && (
              <tr className="border-b border-line/50">
                <td className="px-2 py-1.5 text-start text-muted">{t('missing')}</td>
                <td className={cell}>{table.missing}</td>
                <td className={cell}>{fixed((table.missing / table.total) * 100, 1)}</td>
                <td className={cell} />
                <td className={cell} />
              </tr>
            )}
            <tr>
              <td className="px-2 py-1.5 text-start font-medium text-ink">{t('total')}</td>
              <td className={cell}>{table.total}</td>
              <td className={cell}>100.0</td>
              <td className={cell} />
              <td className={cell} />
            </tr>
          </tbody>
        </Table>
      ))}

      {data.skipped.length > 0 && (
        <p className="text-xs text-muted">
          {t('skipped', { columns: data.skipped.map((entry) => entry.variable).join(', ') })}
        </p>
      )}
    </div>
  );
}

/** The figures an analysis drew, each downloadable as PNG or SVG. */
export function ChartsView({ payload }: { payload: unknown }) {
  const items = (payload as { items?: { title: string; artifactId: string; variable: string }[] })?.items ?? [];
  if (items.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <FigurePreview key={item.artifactId} artifactId={item.artifactId} name={`${item.title}.svg`} />
      ))}
    </div>
  );
}

export function NoteView({ payload }: { payload: unknown }) {
  const note = payload as { title?: string; lines?: string[] } | null;
  if (!note?.lines?.length) return null;

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-subtle/40 p-4" dir="auto">
      {note.title && <span className="text-sm font-semibold text-ink">{note.title}</span>}
      {note.lines.map((line) => (
        <p key={line} className="text-sm text-ink">
          {line}
        </p>
      ))}
    </div>
  );
}

interface CbSemPayload {
  n: number;
  fit: {
    chiSquare: number;
    df: number;
    pValue: number;
    normedChiSquare: number;
    cfi: number;
    tli: number;
    rmsea: number;
    srmr: number;
    verdict: 'good' | 'acceptable' | 'poor';
  };
  loadings: { construct: string; indicator: string; standardised: number; pValue: number; isReference: boolean }[];
  reliability: { construct: string; compositeReliability: number; ave: number }[];
  factorCorrelations: { first: string; second: string; estimate: number; pValue: number }[];
}

function p(value: number): string {
  return value < 0.001 ? '< .001' : value.toFixed(3);
}

export function CbSemView({ payload }: { payload: unknown }) {
  const t = useTranslations('tables');
  const data = payload as CbSemPayload | null;
  if (!data?.fit) return null;

  const fit = data.fit;
  const indices: [string, string, string][] = [
    ['χ² (df)', `${fixed(fit.chiSquare, 2)} (${fit.df})`, `p = ${p(fit.pValue)}`],
    ['χ²/df', fixed(fit.normedChiSquare, 2), '< 3'],
    ['CFI', fixed(fit.cfi), '≥ .90'],
    ['TLI', fixed(fit.tli), '≥ .90'],
    ['RMSEA', fixed(fit.rmsea), '≤ .08'],
    ['SRMR', fixed(fit.srmr), '≤ .08'],
  ];

  return (
    <div className="flex flex-col gap-3">
      <Table title={`${t('fit')} — ${t(`verdict.${fit.verdict}`)} (n = ${data.n})`}>
        <thead>
          <tr className="border-b border-line">
            <th className={`${head} text-start`}>{t('index')}</th>
            <th className={`${head} text-end`}>{t('value')}</th>
            <th className={`${head} text-end`}>{t('criterion')}</th>
          </tr>
        </thead>
        <tbody>
          {indices.map(([name, value, criterion]) => (
            <tr key={name} className="border-b border-line/50 last:border-0">
              <td className="px-2 py-1.5 text-start text-ink">{name}</td>
              <td className={cell}>{value}</td>
              <td className={`${cell} text-muted`}>{criterion}</td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Table title={t('loadings')}>
        <thead>
          <tr className="border-b border-line">
            <th className={`${head} text-start`}>{t('construct')}</th>
            <th className={`${head} text-start`}>{t('item')}</th>
            <th className={`${head} text-end`}>{t('standardised')}</th>
            <th className={`${head} text-end`}>p</th>
          </tr>
        </thead>
        <tbody>
          {data.loadings.map((loading) => (
            <tr key={`${loading.construct}-${loading.indicator}`} className="border-b border-line/50 last:border-0">
              <td className="px-2 py-1.5 text-start text-ink">{loading.construct}</td>
              <td className="px-2 py-1.5 text-start text-ink">{loading.indicator}</td>
              <td className={cell}>{fixed(loading.standardised)}</td>
              <td className={cell}>{loading.isReference ? '—' : p(loading.pValue)}</td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Table title={t('reliabilityValidity')}>
        <thead>
          <tr className="border-b border-line">
            <th className={`${head} text-start`}>{t('construct')}</th>
            <th className={`${head} text-end`}>CR</th>
            <th className={`${head} text-end`}>AVE</th>
          </tr>
        </thead>
        <tbody>
          {data.reliability.map((row) => (
            <tr key={row.construct} className="border-b border-line/50 last:border-0">
              <td className="px-2 py-1.5 text-start text-ink">{row.construct}</td>
              <td className={cell}>{fixed(row.compositeReliability)}</td>
              <td className={cell}>{fixed(row.ave)}</td>
            </tr>
          ))}
        </tbody>
      </Table>

      {data.factorCorrelations.length > 0 && (
        <Table title={t('factorCorrelations')}>
          <tbody>
            {data.factorCorrelations.map((row) => (
              <tr key={`${row.first}-${row.second}`} className="border-b border-line/50 last:border-0">
                <td className="px-2 py-1.5 text-start text-ink">
                  {row.first} ↔ {row.second}
                </td>
                <td className={cell}>{fixed(row.estimate)}</td>
                <td className={cell}>p = {p(row.pValue)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
