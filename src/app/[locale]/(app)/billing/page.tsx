import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';

import { BillingActions } from '@/components/billing/billing-actions';
import { PricingSection } from '@/components/marketing/pricing-section';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { getEnv } from '@/config/env';
import { requirePageUser } from '@/server/auth/guards';
import { billingProvider } from '@/server/billing';
import { listUserPayments, reconcileCheckout } from '@/server/services/billing.service';
import { resolvePlanForUser } from '@/server/services/subscription.service';
import { getSummary } from '@/server/services/usage.service';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'billing' });
  return { title: t('title') };
}

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ checkout?: string; subscription_id?: string }>;
}) {
  const { locale } = await params;
  const { checkout, subscription_id: subscriptionId } = await searchParams;
  const user = await requirePageUser(locale);

  const t = await getTranslations({ locale, namespace: 'billing' });
  const tu = await getTranslations({ locale, namespace: 'usage' });
  const td = await getTranslations({ locale, namespace: 'dashboard' });
  const format = await getFormatter({ locale });
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US');

  // PayPal sends the subscriber back with the subscription id. Confirming it
  // here means the plan activates on return even if the webhook is late or was
  // never registered — the webhook still drives renewals and cancellations.
  if (subscriptionId) {
    await reconcileCheckout({ userId: user.id, subscriptionId });
  }

  const [plan, summary, payments] = await Promise.all([
    resolvePlanForUser(user.id),
    getSummary(user.id),
    listUserPayments(user.id),
  ]);
  const planName = locale === 'ar' ? plan.plan.nameAr : plan.plan.nameEn;
  const provider = billingProvider();
  const env = getEnv();

  const rows = [
    { label: tu('aiRequests'), ...summary.aiRequests },
    { label: tu('generatedWords'), ...summary.generatedWords },
    { label: tu('projects'), ...summary.projects },
  ];

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-ink">{t('title')}</h1>
      </header>

      {provider.name === 'manual' && env.NODE_ENV !== 'production' ? (
        <Alert tone="info">{t('manualNotice')}</Alert>
      ) : null}

      {plan.isOwner ? <Alert tone="upgrade">{t('ownerNotice')}</Alert> : null}

      {checkout === 'success' ? <Alert tone="success">{t('checkoutSuccess')}</Alert> : null}
      {checkout === 'cancelled' ? <Alert tone="warning">{t('checkoutCancelled')}</Alert> : null}
      {plan.status === 'PAST_DUE' ? <Alert tone="danger">{t('pastDue')}</Alert> : null}

      {plan.cancelAtPeriodEnd && plan.periodEnd ? (
        <Alert tone="warning">
          {t('cancelScheduled', {
            date: format.dateTime(plan.periodEnd, { dateStyle: 'medium' }),
          })}
        </Alert>
      ) : null}

      <Card className="flex flex-col gap-5">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              {planName}
              <Badge tone={plan.isPro ? 'upgrade' : 'neutral'}>{plan.status}</Badge>
            </span>
          }
          description={
            plan.periodEnd
              ? plan.cancelAtPeriodEnd
                ? t('endsOn', { date: format.dateTime(plan.periodEnd, { dateStyle: 'medium' }) })
                : t('renewsOn', { date: format.dateTime(plan.periodEnd, { dateStyle: 'medium' }) })
              : td('stats.resetsOn', {
                  date: format.dateTime(summary.resetsAt, { dateStyle: 'medium' }),
                })
          }
        />

        <dl className="grid gap-4 sm:grid-cols-3">
          {rows.map((row) => (
            <div key={row.label} className="flex flex-col gap-1">
              <dt className="text-xs tracking-wide text-muted uppercase">{row.label}</dt>
              <dd className="tabular text-lg font-semibold text-ink">
                {row.limit < 0
                  ? td('stats.unlimited')
                  : tu('remaining', {
                      used: number.format(row.used),
                      limit: number.format(row.limit),
                    })}
              </dd>
            </div>
          ))}
        </dl>

        {plan.isOwner ? null : (
          <BillingActions
            isPro={plan.isPro}
            cancelAtPeriodEnd={plan.cancelAtPeriodEnd}
            proPlanCode="PRO"
            supportsPortal={provider.name === 'stripe'}
          />
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <CardHeader title={t('paymentsTitle')} description={t('paymentsHint')} />
        {payments.length === 0 ? (
          <p className="text-sm text-muted">{t('noPayments')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="py-2 text-start font-medium">{t('paymentDate')}</th>
                  <th className="py-2 text-start font-medium">{t('paymentPlan')}</th>
                  <th className="py-2 text-start font-medium">{t('paymentStatus')}</th>
                  <th className="py-2 text-end font-medium">{t('paymentAmount')}</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id} className="border-b border-line last:border-b-0">
                    <td className="tabular py-2.5 text-ink-soft">
                      {format.dateTime(payment.occurredAt, { dateStyle: 'medium' })}
                    </td>
                    <td className="py-2.5 text-ink-soft">{payment.planCode ?? '—'}</td>
                    <td className="py-2.5">
                      <Badge
                        tone={
                          payment.status === 'SUCCEEDED'
                            ? 'success'
                            : payment.status === 'FAILED'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {t(`paymentStatuses.${payment.status}`)}
                      </Badge>
                    </td>
                    <td className="tabular py-2.5 text-end text-ink">
                      {new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US', {
                        style: 'currency',
                        currency: payment.currency,
                      }).format(payment.amountCents / 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {plan.isOwner ? null : (
        <div className="-mx-4 sm:-mx-6 lg:-mx-8">
          <PricingSection locale={locale} currentPlan={plan} compact />
        </div>
      )}
    </div>
  );
}
