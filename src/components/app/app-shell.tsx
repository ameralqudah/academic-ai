'use client';

import { Menu, Sparkles, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';

import { Sidebar, type ConversationSummary } from '@/components/app/sidebar';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { Link, usePathname } from '@/i18n/navigation';

/**
 * The application frame.
 *
 * A sidebar and a content area, which is the arrangement it always had. What
 * changed is that navigation moved into its own component with sections and a
 * list of recent conversations, and the frame kept only the job of placing it —
 * permanently at desktop widths, behind a button as a drawer on a phone.
 *
 * The drawer closes on Escape and on tapping outside, because those are the two
 * ways anyone dismisses an overlay, and one that only closes by its own X feels
 * broken.
 */
export function AppShell({
  children,
  userName,
  userEmail,
  isAdmin,
  conversations = [],
  aside,
}: {
  children: ReactNode;
  userName: string;
  userEmail: string;
  isAdmin: boolean;
  /**
   * Recent conversations, loaded by the server layout and passed down.
   *
   * Not fetched here: this is a client component, and a client component
   * reaching for data directly is the coupling that the
   * app → API → service → repository layering exists to prevent.
   */
  conversations?: ConversationSummary[];
  aside?: ReactNode;
}) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  /* The chat manages its own full-height layout down to the composer. */
  const isChat = pathname === '/chat' || pathname.startsWith('/chat/');

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('keydown', onKeyDown);
    /* The page behind a drawer should not scroll under it. */
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [open]);

  const sidebar = (
    <Sidebar
      conversations={conversations}
      userName={userName}
      userEmail={userEmail}
      isAdmin={isAdmin}
      onNavigate={() => setOpen(false)}
    />
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh shrink-0 lg:block">{sidebar}</aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-line bg-ground/90 px-4 backdrop-blur-md lg:hidden">
          <Link href="/chat" className="flex items-center gap-2 font-semibold text-ink">
            <Sparkles className="size-4 text-accent" aria-hidden />
            Academic AI
          </Link>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={t('openMenu')}
            aria-expanded={open}
            className="rounded-lg border border-line p-2 text-ink-soft"
          >
            <Menu className="size-5" aria-hidden />
          </button>
        </header>

        <main className="flex min-h-0 flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>

        {/*
          Theme, language and the usage meter.
          
          Hidden on the chat page. The composer is pinned to the bottom of the
          viewport there, and a footer underneath it sat on top of the input —
          the user could see "USAGE THIS MONTH" overlapping the box they were
          trying to type in. These are settings and a status readout; the
          composer is the reason the page exists, and it wins the space.
        */}
        {!isChat && (
          <div className="flex items-center gap-2 px-4 pb-4 sm:px-6 lg:px-8">
            <ThemeToggle />
            <LocaleSwitcher />
            {aside}
          </div>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label={t('closeMenu')}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-ink/40"
          />
          <div className="absolute inset-y-0 start-0 max-w-[85vw] shadow-xl">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t('closeMenu')}
              className="absolute top-3 end-3 z-10 rounded-md p-1.5 text-muted hover:text-ink"
            >
              <X className="size-5" aria-hidden />
            </button>
            {sidebar}
          </div>
        </div>
      )}
    </div>
  );
}
