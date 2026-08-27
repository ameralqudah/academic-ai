'use client';

import { useTranslations } from 'next-intl';

import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/cn';

const TABS = [
  { href: '/admin', key: 'overview' },
  { href: '/admin/users', key: 'users' },
  { href: '/admin/plans', key: 'plans' },
  { href: '/admin/billing', key: 'billingTab' },
  { href: '/admin/ai', key: 'aiUsage' },
] as const;

export function AdminTabs() {
  const t = useTranslations('admin');
  const pathname = usePathname();

  return (
    <nav className="scrollbar-slim -mx-1 overflow-x-auto" aria-label={t('title')}>
      <ul className="flex min-w-max gap-1 px-1">
        {TABS.map((tab) => {
          const active = tab.href === '/admin' ? pathname === '/admin' : pathname.startsWith(tab.href);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'block rounded-lg px-3.5 py-2 text-sm whitespace-nowrap transition-colors',
                  active
                    ? 'bg-upgrade-soft font-medium text-upgrade'
                    : 'text-ink-soft hover:bg-surface-2 hover:text-ink',
                )}
              >
                {t(tab.key)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
