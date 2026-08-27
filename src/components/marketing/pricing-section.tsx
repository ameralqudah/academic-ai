import { Check, Minus } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PLAN_SEEDS } from '@/config/plans';
import { Link } from '@/i18n/navigation';
import { logger } from '@/lib/logger';
import { listPublicPlans, type ResolvedPlan } from '@/server/services/subscription.service';

interface DisplayPlan {
  code: string;
  name: string;
  description: string;
  priceCents: number;
  features: { key: string; label: string; enabled: boolean }[];
}

/**
 * Plans come from the database so the admin dashboard can change them without a
 * deploy. If the database is unreachable the marketing page still renders from the
 * seed values rather than failing — a pricing page that 500s costs signups.
 */
async function loadPlans(locale: string): Promise<DisplayPlan[]> {
  const isArabic = locale === 'ar';

  try {
    const plans = await listPublicPlans();
    if (plans.length > 0) {
      return plans.map((plan) => ({
        code: plan.code,
        name: isArabic ? plan.nameAr : plan.nameEn,
        description: (isArabic ? plan.descriptionAr : plan.descriptionEn) ?? '',
        priceCents: plan.priceCents,
        features: plan.features.map((feature) => ({
          key: feature.featureKey,
          label: isArabic ? feature.labelAr : feature.labelEn,
          enabled: feature.enabled,
        })),
      }));
    }
  } catch (error) {
    logger.warn('pricing.fallbackToSeeds', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return PLAN_SEEDS.map((plan) => ({
    code: plan.code,
    name: isArabic ? plan.nameAr : plan.nameEn,
    description: isArabic ? plan.descriptionAr : plan.descriptionEn,
    priceCents: plan.priceCents,
    features: plan.features.map((feature) => ({
      key: feature.key,
      label: isArabic ? feature.labelAr : feature.labelEn,
      enabled: feature.enabled,
    })),
  }));
}

export async function PricingSection({
  locale,
  currentPlan,
  compact = false,
}: {
  locale: string;
  currentPlan?: ResolvedPlan | null;
  compact?: boolean;
}) {
  const t = await getTranslations({ locale, namespace: 'pricing' });
  const tl = await getTranslations({ locale, namespace: 'landing' });
  const plans = await loadPlans(locale);

  const format = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

  return (
    <section id="pricing" className="border-b border-line bg-surface py-16 lg:py-24">
      <div className="container-page flex flex-col gap-10">
        {!compact ? (
          <header className="flex max-w-2xl flex-col gap-3">
            <h2 className="text-[1.75rem] font-bold text-ink sm:text-[2.1rem]">
              {tl('pricingTitle')}
            </h2>
            <p className="text-ink-soft">{tl('pricingSubtitle')}</p>
          </header>
        ) : null}

        <div className="grid max-w-4xl gap-5 md:grid-cols-2">
          {plans.map((plan) => {
            const isPro = plan.priceCents > 0;
            const isCurrent = currentPlan?.plan.code === plan.code;

            return (
              <article
                key={plan.code}
                className={[
                  'surface-card flex flex-col gap-6 p-7',
                  isPro ? 'border-upgrade/40 ring-1 ring-upgrade/15' : '',
                ].join(' ')}
              >
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-lg font-semibold text-ink">{plan.name}</h3>
                    {isPro ? <Badge tone="upgrade">{t('mostPopular')}</Badge> : null}
                    {isCurrent ? <Badge tone="success">{t('currentPlan')}</Badge> : null}
                  </div>
                  <p className="text-sm text-muted">{plan.description}</p>
                </div>

                <p className="flex items-baseline gap-1.5">
                  <span className="tabular text-4xl font-bold text-ink">
                    {plan.priceCents === 0 ? t('free') : format.format(plan.priceCents / 100)}
                  </span>
                  {plan.priceCents > 0 ? (
                    <span className="text-sm text-muted">{t('perMonth')}</span>
                  ) : null}
                </p>

                <ul className="flex flex-col gap-2.5">
                  {plan.features.map((feature) => (
                    <li key={feature.key} className="flex items-start gap-2.5 text-sm">
                      {feature.enabled ? (
                        <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                      ) : (
                        <Minus className="mt-0.5 size-4 shrink-0 text-muted/60" aria-hidden />
                      )}
                      <span className={feature.enabled ? 'text-ink-soft' : 'text-muted/70'}>
                        {feature.label}
                      </span>
                    </li>
                  ))}
                </ul>

                <div className="mt-auto">
                  {isCurrent ? (
                    <Button variant="secondary" className="w-full" disabled>
                      {t('currentPlan')}
                    </Button>
                  ) : (
                    <Button
                      asChild
                      variant={isPro ? 'upgrade' : 'outline'}
                      className="w-full"
                    >
                      <Link href={isPro ? '/billing' : '/register'}>
                        {isPro ? t('upgradeToPro') : t('choosePlan', { plan: plan.name })}
                      </Link>
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        <p className="text-xs text-muted">{t('faqNote')}</p>
      </div>
    </section>
  );
}
