import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

type Tone = 'info' | 'success' | 'warning' | 'danger' | 'upgrade';

const TONES: Record<Tone, string> = {
  info: 'border-s-accent bg-accent-soft/60 text-ink',
  success: 'border-s-success bg-success/8 text-ink',
  warning: 'border-s-warning bg-warning/8 text-ink',
  danger: 'border-s-danger bg-danger/8 text-ink',
  upgrade: 'border-s-upgrade bg-upgrade-soft/70 text-ink',
};

export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-line border-s-4 px-4 py-3 sm:flex-row sm:items-center sm:justify-between',
        TONES[tone],
        className,
      )}
    >
      <div className="flex flex-col gap-0.5">
        {title ? <p className="text-sm font-semibold">{title}</p> : null}
        {children ? <div className="text-sm text-ink-soft">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}
