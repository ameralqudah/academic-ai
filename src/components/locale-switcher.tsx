'use client';

import { Languages } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';

import { usePathname, useRouter } from '@/i18n/navigation';
import { locales, type Locale } from '@/i18n/routing';
import { cn } from '@/lib/cn';

const LABEL: Record<Locale, string> = { ar: 'العربية', en: 'English' };

export function LocaleSwitcher({ className }: { className?: string }) {
  const t = useTranslations('common');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const other = locales.find((candidate) => candidate !== locale) ?? locale;

  function switchTo(next: Locale) {
    startTransition(() => {
      // `pathname` already carries the resolved dynamic segments (project id,
      // step, …) so the user stays on the same page instead of being dropped at
      // the dashboard.
      router.replace(pathname, { locale: next });
    });
  }

  return (
    <button
      type="button"
      onClick={() => switchTo(other)}
      disabled={pending}
      aria-label={`${t('language')}: ${LABEL[other]}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5',
        'text-sm font-medium text-ink-soft transition-colors hover:text-ink disabled:opacity-60',
        className,
      )}
    >
      <Languages className="size-4" aria-hidden />
      {LABEL[other]}
    </button>
  );
}
