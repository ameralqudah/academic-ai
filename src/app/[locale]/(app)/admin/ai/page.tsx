import { getTranslations } from 'next-intl/server';

import { AIProviderForm } from '@/components/admin/ai-provider-form';
import { Card, CardHeader } from '@/components/ui/card';
import { aiUsage, getAISettings } from '@/server/services/admin.service';

export default async function AdminAIPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'admin' });

  const [usage, settings] = await Promise.all([aiUsage(), getAISettings()]);
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US');
  const money = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US', {
    style: 'currency',
    currency: 'USD',
  });

  return (
    <div className="flex flex-col gap-6">
      <AIProviderForm current={settings.provider} models={settings.models ?? {}} />

      <Card className="flex flex-col gap-4">
        <CardHeader title={t('aiUsage')} description={t('period', { period: usage.periodKey })} />

        {usage.byUser.length === 0 ? (
          <p className="text-sm text-muted">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="py-2 text-start font-medium">{t('table.user')}</th>
                  <th className="py-2 text-end font-medium">{t('table.requests')}</th>
                  <th className="py-2 text-end font-medium">{t('stats.words')}</th>
                  <th className="py-2 text-end font-medium">{t('table.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {usage.byUser.map((row) => (
                  <tr key={row.userId} className="border-b border-line last:border-b-0">
                    <td className="py-2">
                      <div className="flex flex-col">
                        <span className="text-ink">{row.name ?? t('table.none')}</span>
                        <span dir="ltr" className="text-xs text-muted">
                          {row.email}
                        </span>
                      </div>
                    </td>
                    <td className="tabular py-2 text-end">{number.format(row.requests)}</td>
                    <td className="tabular py-2 text-end">{number.format(row.words)}</td>
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
