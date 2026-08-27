'use client';

import { GraduationCap, Menu, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

const ANCHORS = [
  { href: '#features', key: 'features' },
  { href: '#how-it-works', key: 'howItWorks' },
  { href: '#pricing', key: 'pricing' },
  { href: '#faq', key: 'faq' },
] as const;

export function SiteHeader({ isAuthenticated }: { isAuthenticated: boolean }) {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ground/85 backdrop-blur-md">
      <div className="container-page flex h-16 items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2.5 font-semibold text-ink">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-on-primary">
            <GraduationCap className="size-5" aria-hidden />
          </span>
          <span className="text-[1.05rem]">{tc('appName')}</span>
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label={t('features')}>
          {ANCHORS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {t(item.key)}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <ThemeToggle />
          <LocaleSwitcher />
          {isAuthenticated ? (
            <Button asChild size="sm">
              <Link href="/dashboard">{t('dashboard')}</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">{t('login')}</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/register">{t('register')}</Link>
              </Button>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded-lg border border-line p-2 text-ink-soft lg:hidden"
          aria-expanded={open}
          aria-label={open ? t('closeMenu') : t('openMenu')}
        >
          {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
        </button>
      </div>

      {open ? (
        <div className="border-t border-line bg-surface lg:hidden">
          <div className="container-page flex flex-col gap-1 py-4">
            {ANCHORS.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2.5 text-sm text-ink-soft hover:bg-surface-2"
              >
                {t(item.key)}
              </a>
            ))}
            <div className="mt-2 flex items-center gap-2">
              <ThemeToggle />
              <LocaleSwitcher />
            </div>
            <div className="mt-2 flex flex-col gap-2">
              {isAuthenticated ? (
                <Button asChild>
                  <Link href="/dashboard">{t('dashboard')}</Link>
                </Button>
              ) : (
                <>
                  <Button asChild variant="outline">
                    <Link href="/login">{t('login')}</Link>
                  </Button>
                  <Button asChild>
                    <Link href="/register">{t('register')}</Link>
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
