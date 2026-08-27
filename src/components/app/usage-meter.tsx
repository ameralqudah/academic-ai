import { getTranslations } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Link } from '@/i18n/navigation';
import type { UsageSummary } from '@/server/services/usage.service';

function toneFor(used: number, limit: number): 'primary' | 'warning' | 'danger' {
  if (limit < 0) return 'primary';
  const ratio = limit === 0 ? 1 : used / limit;
  if (ratio >= 1) return 'danger';
  if (ratio >= 0.8) return 'warning';
  return 'primary';
}

export async function UsageMeter({
  locale,
  summary,
}: {
  locale: string;
  summary: UsageSummary;
}) {
  const t = await getTranslations({ locale, namespace: 'usage' });
  const td = await getTranslations({ locale, namespace: 'dashboard' });
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US');

  const rows = [
    { key: 'aiRequests', label: t('aiRequests'), ...summary.aiRequests },
    { key: 'generatedWords', label: t('generatedWords'), ...summary.generatedWords },
  ];

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3.5">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{t('title')}</p>

      {rows.map((row) => (
        <div key={row.key} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-ink-soft">{row.label}</span>
            <span className="tabular text-muted">
              {row.limit < 0
                ? td('stats.unlimited')
                : `${number.format(row.used)} / ${number.format(row.limit)}`}
            </span>
          </div>
          <Progress
            value={row.used}
            max={row.limit < 0 ? Math.max(row.used, 1) : row.limit}
            tone={toneFor(row.used, row.limit)}
            label={row.label}
          />
        </div>
      ))}

      {!summary.plan.isPro ? (
        <Button asChild size="sm" variant="upgrade" className="mt-1 w-full">
          <Link href="/billing">{t('limitReachedAction')}</Link>
        </Button>
      ) : null}
    </div>
  );
}
