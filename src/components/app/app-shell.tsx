'use client';

import {
  BarChart3,
  FolderKanban,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Shield,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import { signOut } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/cn';

const NAV = [
  { href: '/dashboard', key: 'dashboard', icon: LayoutDashboard },
  { href: '/projects', key: 'projects', icon: FolderKanban },
  { href: '/tools', key: 'tools', icon: Sparkles },
  { href: '/analysis', key: 'analysis', icon: BarChart3 },
  { href: '/billing', key: 'billing', icon: Wallet },
  { href: '/settings', key: 'settings', icon: Settings },
] as const;

export function AppShell({
  children,
  userName,
  userEmail,
  isAdmin,
  aside,
}: {
  children: ReactNode;
  userName: string;
  userEmail: string;
  isAdmin: boolean;
  aside?: ReactNode;
}) {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const locale = useLocale();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex flex-col gap-1" aria-label={t('dashboard')}>
      {NAV.map(({ href, key, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors',
              active
                ? 'bg-primary-soft font-medium text-primary'
                : 'text-ink-soft hover:bg-surface-2 hover:text-ink',
            )}
          >
            <Icon className="size-4.5 shrink-0" aria-hidden />
            {t(key)}
          </Link>
        );
      })}

      {isAdmin ? (
        <Link
          href="/admin"
          onClick={() => setOpen(false)}
          className={cn(
            'mt-1 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors',
            pathname.startsWith('/admin')
              ? 'bg-upgrade-soft font-medium text-upgrade'
              : 'text-ink-soft hover:bg-surface-2 hover:text-ink',
          )}
        >
          <Shield className="size-4.5 shrink-0" aria-hidden />
          {t('admin')}
        </Link>
      ) : null}
    </nav>
  );

  const sidebarBody = (
    <div className="flex h-full flex-col gap-6 p-4">
      <Link href="/dashboard" className="flex items-center gap-2.5 px-1 font-semibold text-ink">
        <span className="grid size-9 place-items-center rounded-lg bg-primary text-on-primary">
          <GraduationCap className="size-5" aria-hidden />
        </span>
        {tc('appName')}
      </Link>

      {nav}

      <div className="mt-auto flex flex-col gap-3">
        {aside}

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <LocaleSwitcher />
        </div>

        <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{userName}</p>
            <p dir="ltr" className="truncate text-xs text-muted">
              {userEmail}
            </p>
          </div>
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: `/${locale}` })}
            aria-label={t('logout')}
            title={t('logout')}
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-danger"
          >
            <LogOut className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh border-e border-line bg-ground lg:block">
        {sidebarBody}
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-line bg-ground/90 px-4 backdrop-blur-md lg:hidden">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold text-ink">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-on-primary">
              <GraduationCap className="size-4" aria-hidden />
            </span>
            {tc('appName')}
          </Link>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={t('openMenu')}
            className="rounded-lg border border-line p-2 text-ink-soft"
          >
            <Menu className="size-5" aria-hidden />
          </button>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label={t('closeMenu')}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-ink/40"
          />
          <div className="absolute inset-y-0 start-0 w-72 max-w-[85vw] border-e border-line bg-ground shadow-xl">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t('closeMenu')}
              className="absolute top-3 end-3 rounded-md p-1.5 text-muted hover:text-ink"
            >
              <X className="size-5" aria-hidden />
            </button>
            {sidebarBody}
          </div>
        </div>
      ) : null}
    </div>
  );
}
