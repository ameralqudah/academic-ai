import { GraduationCap } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

export async function SiteFooter({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: 'landing' });
  const tc = await getTranslations({ locale, namespace: 'common' });
  const tn = await getTranslations({ locale, namespace: 'nav' });

  return (
    <footer className="py-12">
      <div className="container-page flex flex-col gap-10">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-3">
            <Link href="/" className="flex items-center gap-2.5 font-semibold text-ink">
              <span className="grid size-8 place-items-center rounded-lg bg-primary text-on-primary">
                <GraduationCap className="size-4" aria-hidden />
              </span>
              {tc('appName')}
            </Link>
            <p className="max-w-[32ch] text-sm text-muted">{tc('tagline')}</p>
          </div>

          <nav className="flex flex-col gap-2.5 text-sm" aria-label={t('footerProduct')}>
            <p className="text-xs font-semibold tracking-wide text-ink uppercase">
              {t('footerProduct')}
            </p>
            <a href="#features" className="text-muted hover:text-ink">
              {tn('features')}
            </a>
            <a href="#how-it-works" className="text-muted hover:text-ink">
              {tn('howItWorks')}
            </a>
            <Link href="/pricing" className="text-muted hover:text-ink">
              {tn('pricing')}
            </Link>
          </nav>

          <nav className="flex flex-col gap-2.5 text-sm" aria-label={t('footerCompany')}>
            <p className="text-xs font-semibold tracking-wide text-ink uppercase">
              {t('footerCompany')}
            </p>
            <a href="#faq" className="text-muted hover:text-ink">
              {tn('faq')}
            </a>
            <a href="mailto:support@academic-ai.app" className="text-muted hover:text-ink">
              {t('contact')}
            </a>
          </nav>

          <nav className="flex flex-col gap-2.5 text-sm" aria-label={t('footerLegal')}>
            <p className="text-xs font-semibold tracking-wide text-ink uppercase">
              {t('footerLegal')}
            </p>
            <Link href="/privacy" className="text-muted hover:text-ink">
              {t('privacy')}
            </Link>
            <Link href="/terms" className="text-muted hover:text-ink">
              {t('terms')}
            </Link>
          </nav>
        </div>

        <p className="border-t border-line pt-6 text-xs text-muted">
          © {new Date().getFullYear()} {tc('appFullName')}. {t('footerRights')}
        </p>
      </div>
    </footer>
  );
}
