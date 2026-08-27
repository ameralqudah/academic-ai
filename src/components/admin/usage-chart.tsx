/**
 * Daily AI requests over the last 30 days.
 *
 * One series, so no legend — the figure caption names it. Bars rather than a line
 * because the quantity is a count per day, not a continuous level, and gaps mean
 * "no requests", which a line would draw through. Native `<title>` tooltips keep
 * the hover layer working without shipping JavaScript for an admin sparkline.
 */

import { getFormatter, getTranslations } from 'next-intl/server';

export async function UsageChart({
  locale,
  data,
}: {
  locale: string;
  data: { day: string; requests: number }[];
}) {
  const t = await getTranslations({ locale, namespace: 'admin' });
  const format = await getFormatter({ locale });
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US');

  if (data.length === 0) {
    return <p className="surface-card p-6 text-sm text-muted">{t('empty')}</p>;
  }

  const width = 720;
  const height = 180;
  const padding = { top: 12, right: 8, bottom: 24, left: 8 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const max = Math.max(...data.map((point) => point.requests), 1);
  // 2px of surface between bars, per the mark spec.
  const slot = plotWidth / data.length;
  const barWidth = Math.max(3, slot - 2);

  const gridLines = [0, 0.5, 1];
  const peak = data.reduce((best, point) => (point.requests > best.requests ? point : best), data[0]!);
  const last = data[data.length - 1]!;

  return (
    <figure className="surface-card flex flex-col gap-3 p-5">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-ink">{t('stats.aiRequests')}</span>
        <span className="tabular text-xs text-muted">
          {t('table.requests')}: {number.format(last.requests)}
        </span>
      </figcaption>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${t('stats.aiRequests')} — ${data.length}`}
          className="h-auto w-full min-w-[36rem]"
          style={{ color: 'var(--muted)' }}
        >
          {gridLines.map((ratio) => {
            const y = padding.top + plotHeight * (1 - ratio);
            return (
              <line
                key={ratio}
                x1={padding.left}
                x2={width - padding.right}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeWidth={1}
                opacity={0.18}
              />
            );
          })}

          {data.map((point, index) => {
            const barHeight = (point.requests / max) * plotHeight;
            const x = padding.left + index * slot + (slot - barWidth) / 2;
            const y = padding.top + plotHeight - barHeight;
            const isPeak = point.day === peak.day && peak.requests > 0;

            return (
              <rect
                key={point.day}
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(barHeight, point.requests > 0 ? 2 : 0)}
                rx={Math.min(4, barWidth / 2)}
                fill={isPeak ? 'var(--upgrade)' : 'var(--accent)'}
                opacity={isPeak ? 1 : 0.85}
              >
                <title>
                  {format.dateTime(new Date(point.day), { dateStyle: 'medium' })} —{' '}
                  {number.format(point.requests)}
                </title>
              </rect>
            );
          })}

          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={padding.top + plotHeight}
            y2={padding.top + plotHeight}
            stroke="currentColor"
            strokeWidth={1}
            opacity={0.4}
          />

          <text
            x={padding.left}
            y={height - 6}
            fontSize={11}
            fill="currentColor"
            opacity={0.75}
            textAnchor="start"
          >
            {format.dateTime(new Date(data[0]!.day), { day: 'numeric', month: 'short' })}
          </text>
          <text
            x={width - padding.right}
            y={height - 6}
            fontSize={11}
            fill="currentColor"
            opacity={0.75}
            textAnchor="end"
          >
            {format.dateTime(new Date(last.day), { day: 'numeric', month: 'short' })}
          </text>
        </svg>
      </div>

      {/* The table view keeps the data readable without relying on the chart. */}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">{t('table.requests')}</summary>
        <div className="mt-2 max-h-48 overflow-y-auto">
          <table className="w-full">
            <tbody>
              {[...data].reverse().map((point) => (
                <tr key={point.day} className="border-b border-line last:border-b-0">
                  <td className="py-1">
                    {format.dateTime(new Date(point.day), { dateStyle: 'medium' })}
                  </td>
                  <td className="tabular py-1 text-end text-ink">
                    {number.format(point.requests)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
