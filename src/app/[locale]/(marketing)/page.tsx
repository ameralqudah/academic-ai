import { CallToAction } from '@/components/marketing/cta';
import { Faq } from '@/components/marketing/faq';
import { Features } from '@/components/marketing/features';
import { Hero } from '@/components/marketing/hero';
import { HowItWorks } from '@/components/marketing/how-it-works';
import { PricingSection } from '@/components/marketing/pricing-section';

export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

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
