import { getTranslations } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

export async function CallToAction({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: 'landing' });

  return (
    <section className="border-b border-line py-16 lg:py-20">
      <div className="container-page">
        <div className="surface-card flex flex-col items-start gap-5 bg-primary p-8 text-on-primary sm:p-12">
          <h2 className="max-w-[22ch] text-[1.6rem] leading-snug font-bold sm:text-[2rem]">
            {t('ctaTitle')}
          </h2>
          <p className="max-w-[54ch] text-[0.98rem] leading-relaxed opacity-90">{t('ctaBody')}</p>
          <Button
            asChild
            size="lg"
            className="bg-surface text-primary hover:bg-surface-2"
          >
            <Link href="/register">{t('startResearch')}</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
