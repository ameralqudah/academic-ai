import { cn } from '@/lib/cn';

export function Progress({
  value,
  max = 100,
  tone = 'primary',
  className,
  label,
}: {
  value: number;
  max?: number;
  tone?: 'primary' | 'accent' | 'warning' | 'danger';
  className?: string;
  label?: string;
}) {
  const percent = max <= 0 ? 0 : Math.min(100, Math.max(0, Math.round((value / max) * 100)));
  const fill = {
    primary: 'bg-primary',
    accent: 'bg-accent',
    warning: 'bg-warning',
    danger: 'bg-danger',
  }[tone];

  return (
    <div
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-2', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', fill)}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
