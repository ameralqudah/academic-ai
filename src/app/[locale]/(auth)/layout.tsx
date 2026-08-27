import { GraduationCap, Quote } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { Link } from '@/i18n/navigation';

export default async function AuthLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const tc = await getTranslations({ locale, namespace: 'common' });
  const tl = await getTranslations({ locale, namespace: 'landing' });

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(0,1.1fr)]">
      {/* Brand panel — hidden on small screens so the form is the whole viewport. */}
      <aside className="relative hidden flex-col justify-between bg-primary p-10 text-on-primary lg:flex">
        <Link href="/" className="flex items-center gap-2.5 font-semibold">
          <span className="grid size-9 place-items-center rounded-lg bg-on-primary/15">
            <GraduationCap className="size-5" aria-hidden />
          </span>
          {tc('appName')}
        </Link>

        <div className="flex max-w-md flex-col gap-5">
          <Quote className="size-7 opacity-50" aria-hidden />
          <p className="text-[1.35rem] leading-relaxed font-medium">{tl('heroTitle')}</p>
          <p className="text-sm leading-relaxed opacity-85">{tl('trustLine')}</p>
        </div>

        <p className="text-xs opacity-70">
          © {new Date().getFullYear()} {tc('appFullName')}
        </p>
      </aside>

      <main className="flex flex-col">
        <div className="flex items-center justify-between p-5">
          <Link href="/" className="flex items-center gap-2 font-semibold text-ink lg:invisible">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-on-primary">
              <GraduationCap className="size-4" aria-hidden />
            </span>
            {tc('appName')}
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <LocaleSwitcher />
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center px-5 pb-12">
          <div className="w-full max-w-[26rem]">{children}</div>
        </div>
      </main>
    </div>
  );
}
