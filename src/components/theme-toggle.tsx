'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useSyncExternalStore } from 'react';

import { cn } from '@/lib/cn';

type Theme = 'LIGHT' | 'DARK' | 'SYSTEM';

const STORAGE_KEY = 'theme';
const CHANGE_EVENT = 'academic-ai:themechange';

const OPTIONS: { value: Theme; icon: typeof Sun; labelKey: 'light' | 'dark' | 'system' }[] = [
  { value: 'LIGHT', icon: Sun, labelKey: 'light' },
  { value: 'DARK', icon: Moon, labelKey: 'dark' },
  { value: 'SYSTEM', icon: Monitor, labelKey: 'system' },
];

/**
 * The stored theme is external state (localStorage), not React state, so it is
 * read through `useSyncExternalStore`. Holding it in `useState` and seeding it
 * from an effect would render once with the wrong value and then cascade.
 *
 * Every toggle instance subscribes to the same store, so the control in the
 * sidebar and the one on the settings page stay in step.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'LIGHT' || stored === 'DARK' || stored === 'SYSTEM' ? stored : 'SYSTEM';
  } catch {
    // Private mode, or site data blocked — fall back to following the OS.
    return 'SYSTEM';
  }
}

/** The server has no localStorage; the pre-hydration script fixes the class. */
function serverTheme(): Theme {
  return 'SYSTEM';
}

function applyTheme(theme: Theme): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'DARK' || (theme === 'SYSTEM' && prefersDark);
  document.documentElement.classList.toggle('dark', dark);
}

export function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations('common');
  const theme = useSyncExternalStore(subscribe, readTheme, serverTheme);

  // Follow the OS while the choice is "system".
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (readTheme() === 'SYSTEM') applyTheme('SYSTEM');
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  function select(next: Theme) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the choice still applies for this page view.
    }
    applyTheme(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return (
    <div
      className={cn('inline-flex rounded-lg border border-line bg-surface p-0.5', className)}
      role="group"
      aria-label={t('theme')}
    >
      {OPTIONS.map(({ value, icon: Icon, labelKey }) => (
        <button
          key={value}
          type="button"
          onClick={() => select(value)}
          aria-pressed={theme === value}
          title={t(labelKey)}
          className={cn(
            'rounded-md p-1.5 transition-colors',
            theme === value ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink',
          )}
        >
          <Icon className="size-4" aria-hidden />
          <span className="sr-only">{t(labelKey)}</span>
        </button>
      ))}
    </div>
  );
}
