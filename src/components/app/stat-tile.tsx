import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'neutral',
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: 'neutral' | 'primary' | 'accent' | 'upgrade';
  className?: string;
}) {
  const accent = {
    neutral: 'text-muted',
    primary: 'text-primary',
    accent: 'text-accent',
    upgrade: 'text-upgrade',
  }[tone];

  return (
    <div className={cn('surface-card flex flex-col gap-2 p-4 sm:p-5', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
        {Icon ? <Icon className={cn('size-4', accent)} aria-hidden /> : null}
      </div>
      <p className="tabular text-2xl leading-none font-semibold text-ink">{value}</p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
