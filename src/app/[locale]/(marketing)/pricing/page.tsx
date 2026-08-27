import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { Faq } from '@/components/marketing/faq';
import { PricingSection } from '@/components/marketing/pricing-section';
import { getCurrentUser } from '@/server/auth/guards';
import { resolvePlanForUser } from '@/server/services/subscription.service';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'pricing' });
  return { title: t('title'), description: t('subtitle') };
}

export default async function PricingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'pricing' });
  const user = await getCurrentUser();
  const currentPlan = user ? await resolvePlanForUser(user.id).catch(() => null) : null;

  return (
    <>
      <section className="border-b border-line py-14">
        <div className="container-page flex max-w-2xl flex-col gap-3">
          <h1 className="text-[2rem] font-bold text-ink sm:text-[2.4rem]">{t('title')}</h1>
          <p className="text-ink-soft">{t('subtitle')}</p>
        </div>
      </section>
      <PricingSection locale={locale} currentPlan={currentPlan} compact />
      <Faq locale={locale} />
    </>
  );
}
