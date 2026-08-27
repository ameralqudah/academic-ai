import { CircleDollarSign, CreditCard, RefreshCcw, Users } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';

import { StatTile } from '@/components/app/stat-tile';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { billingOverview } from '@/server/services/admin.service';

export default async function AdminBillingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'admin' });
  const tb = await getTranslations({ locale, namespace: 'billing' });
  const format = await getFormatter({ locale });

  const data = await billingOverview();
  const intlLocale = locale === 'ar' ? 'ar-EG' : 'en-US';
  const number = new Intl.NumberFormat(intlLocale);
  const money = (cents: number, currency = data.revenue.currency) =>
    new Intl.NumberFormat(intlLocale, { style: 'currency', currency }).format(cents / 100);

  const statusTone = (status: string) =>
    status === 'ACTIVE' ? 'upgrade' : status === 'PAST_DUE' ? 'warning' : 'neutral';

  const paymentTone = (status: string) =>
    status === 'SUCCEEDED' ? 'success' : status === 'FAILED' ? 'danger' : 'warning';

  return (
    <div className="flex flex-col gap-6">
      {data.environmentMismatch ? (
        <Alert tone="danger">{t('billing.environmentMismatch')}</Alert>
      ) : data.environment === 'sandbox' ? (
        <Alert tone="danger">{t('billing.sandboxWarning')}</Alert>
      ) : !data.takesRealPayments ? (
        <Alert tone="warning">{t('billing.manualWarning')}</Alert>
      ) : !data.configured ? (
        <Alert tone="danger">{t('billing.unconfigured', { provider: data.provider })}</Alert>
      ) : (
        <p className="text-xs text-muted">
          {t('billing.providerLine', { provider: data.provider })}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label={t('billing.mrr')}
          value={money(data.monthlyRecurringCents)}
          hint={t('billing.subscribersCount', { count: data.subscribers.length })}
          icon={CircleDollarSign}
          tone="upgrade"
        />
        <StatTile
          label={t('billing.last30Days')}
          value={money(data.revenue.last30DaysCents)}
          icon={CreditCard}
          tone="primary"
        />
        <StatTile
          label={t('billing.grossTotal')}
          value={money(data.revenue.grossCents)}
          hint={`${t('billing.refunded')}: ${money(data.revenue.refundedCents)}`}
          icon={RefreshCcw}
          tone="accent"
        />
        <StatTile
          label={t('billing.paymentsCount')}
          value={number.format(data.revenue.succeededCount)}
          hint={`${t('billing.failed')}: ${number.format(data.revenue.failedCount)}`}
          icon={Users}
        />
      </div>

      <Card className="flex flex-col gap-4">
        <CardHeader title={t('billing.subscribers')} />
        {data.subscribers.length === 0 ? (
          <p className="text-sm text-muted">{t('billing.noSubscribers')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="py-2 text-start font-medium">{t('table.user')}</th>
                  <th className="py-2 text-start font-medium">{t('billing.plan')}</th>
                  <th className="py-2 text-start font-medium">{t('table.status')}</th>
                  <th className="py-2 text-end font-medium">{t('billing.price')}</th>
                  <th className="py-2 text-start font-medium">{t('billing.renewal')}</th>
                  <th className="py-2 text-start font-medium">{t('table.provider')}</th>
                </tr>
              </thead>
              <tbody>
                {data.subscribers.map((row) => (
                  <tr key={row.userId} className="border-b border-line last:border-b-0">
                    <td className="py-2.5">
                      <span className="block text-ink">{row.name ?? '—'}</span>
                      <span className="block text-xs text-muted" dir="ltr">
                        {row.email}
                      </span>
                    </td>
                    <td className="py-2.5 text-ink-soft">
                      {locale === 'ar' ? row.planNameAr : row.planNameEn}
                    </td>
                    <td className="py-2.5">
                      <Badge tone={statusTone(row.status)}>
                        {row.cancelAtPeriodEnd ? t('billing.cancelling') : row.status}
                      </Badge>
                    </td>
                    <td className="tabular py-2.5 text-end text-ink">
                      {money(row.priceCents, row.currency)}
                    </td>
                    <td className="tabular py-2.5 text-ink-soft">
                      {row.periodEnd
                        ? format.dateTime(row.periodEnd, { dateStyle: 'medium' })
                        : '—'}
                    </td>
                    <td className="py-2.5 text-xs text-muted">{row.provider}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <CardHeader title={t('billing.payments')} description={t('billing.paymentsHint')} />
        {data.payments.length === 0 ? (
          <p className="text-sm text-muted">{tb('noPayments')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="py-2 text-start font-medium">{t('billing.date')}</th>
                  <th className="py-2 text-start font-medium">{t('table.user')}</th>
                  <th className="py-2 text-start font-medium">{t('billing.plan')}</th>
                  <th className="py-2 text-start font-medium">{t('table.status')}</th>
                  <th className="py-2 text-end font-medium">{t('billing.amount')}</th>
                  <th className="py-2 text-start font-medium">{t('billing.reference')}</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.map((row) => (
                  <tr key={row.id} className="border-b border-line last:border-b-0">
                    <td className="tabular py-2.5 text-ink-soft">
                      {format.dateTime(row.occurredAt, { dateStyle: 'medium' })}
                    </td>
                    <td className="py-2.5 text-xs text-muted" dir="ltr">
                      {row.userEmail}
                    </td>
                    <td className="py-2.5 text-ink-soft">{row.planCode ?? '—'}</td>
                    <td className="py-2.5">
                      <Badge tone={paymentTone(row.status)}>{row.status}</Badge>
                    </td>
                    <td className="tabular py-2.5 text-end text-ink">
                      {money(row.amountCents, row.currency)}
                    </td>
                    <td className="py-2.5 font-mono text-xs text-muted" dir="ltr">
                      {row.externalPaymentId ?? '—'}
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
