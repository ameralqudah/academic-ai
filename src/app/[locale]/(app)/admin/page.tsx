import { CircleDollarSign, FolderKanban, Sparkles, UserPlus, Users } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { StatTile } from '@/components/app/stat-tile';
import { UsageChart } from '@/components/admin/usage-chart';
import { Card, CardHeader } from '@/components/ui/card';
import { overview } from '@/server/services/admin.service';

export default async function AdminOverviewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'admin' });

  const { stats, byProvider, daily, periodKey } = await overview();
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US');
  const money = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US', {
    style: 'currency',
    currency: 'USD',
  });

  return (
    <div className="flex flex-col gap-6">
      <p className="tabular text-xs text-muted">{t('period', { period: periodKey })}</p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label={t('stats.totalUsers')}
          value={number.format(stats.totalUsers)}
          hint={`${t('stats.suspended')}: ${number.format(stats.suspendedUsers)}`}
          icon={Users}
          tone="primary"
        />
        <StatTile
          label={t('stats.newUsers')}
          value={number.format(stats.newUsers30d)}
          icon={UserPlus}
        />
        <StatTile
          label={t('stats.proUsers')}
          value={number.format(stats.proUsers)}
          hint={`${t('stats.activeSubscriptions')}: ${number.format(stats.activeSubscriptions)}`}
          icon={Sparkles}
          tone="upgrade"
        />
        <StatTile
          label={t('stats.monthlyRevenue')}
          value={money.format(stats.monthlyRevenueCents / 100)}
          icon={CircleDollarSign}
          tone="accent"
        />
        <StatTile
          label={t('stats.totalProjects')}
          value={number.format(stats.totalProjects)}
          icon={FolderKanban}
        />
        <StatTile
          label={t('stats.aiRequests')}
          value={number.format(stats.aiRequestsThisPeriod)}
        />
        <StatTile label={t('stats.words')} value={number.format(stats.wordsThisPeriod)} />
        <StatTile
          label={t('stats.estimatedCost')}
          value={money.format(stats.estimatedCostMicroUsd / 1_000_000)}
          tone="accent"
        />
      </div>

      <UsageChart locale={locale} data={daily} />

      <Card className="flex flex-col gap-4">
        <CardHeader title={t('aiUsage')} />
        {byProvider.length === 0 ? (
          <p className="text-sm text-muted">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="py-2 text-start font-medium">{t('table.provider')}</th>
                  <th className="py-2 text-start font-medium">{t('table.model')}</th>
                  <th className="py-2 text-end font-medium">{t('table.requests')}</th>
                  <th className="py-2 text-end font-medium">{t('table.tokensIn')}</th>
                  <th className="py-2 text-end font-medium">{t('table.tokensOut')}</th>
                  <th className="py-2 text-end font-medium">{t('table.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {byProvider.map((row) => (
                  <tr
                    key={`${row.provider}-${row.model}`}
                    className="border-b border-line last:border-b-0"
                  >
                    <td className="py-2 text-ink">{row.provider ?? t('table.none')}</td>
                    <td className="py-2 text-ink-soft">{row.model ?? t('table.none')}</td>
                    <td className="tabular py-2 text-end">{number.format(row.requests)}</td>
                    <td className="tabular py-2 text-end">{number.format(row.tokensIn)}</td>
                    <td className="tabular py-2 text-end">{number.format(row.tokensOut)}</td>
                    <td className="tabular py-2 text-end text-ink">
                      {money.format(row.costMicroUsd / 1_000_000)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
