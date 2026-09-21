import { redirect } from 'next/navigation';

import { CallToAction } from '@/components/marketing/cta';
import { Faq } from '@/components/marketing/faq';
import { Features } from '@/components/marketing/features';
import { Hero } from '@/components/marketing/hero';
import { HowItWorks } from '@/components/marketing/how-it-works';
import { PricingSection } from '@/components/marketing/pricing-section';
import { SIGNED_IN_HOME } from '@/config/home';
import { getCurrentUser } from '@/server/auth/guards';

export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  /*
   * This page sells the product to someone who does not have it. A person who
   * is already signed in — most often opening the installed app, whose start
   * URL is the bare domain — came to work, so they go straight to it. Pricing,
   * privacy and terms stay open to everyone; only the front door moves.
   */
  if (await getCurrentUser()) redirect(`/${locale}${SIGNED_IN_HOME}`);

  return (
    <>
      <Hero locale={locale} />
      <Features locale={locale} />
      <HowItWorks locale={locale} />
      <PricingSection locale={locale} />
      <Faq locale={locale} />
      <CallToAction locale={locale} />
    </>
  );
}
