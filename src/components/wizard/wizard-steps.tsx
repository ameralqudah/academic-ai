'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/cn';
import { sectionI18nKey } from '@/lib/sections';

export interface WizardStepState {
  key: string;
  order: number;
  status: 'EMPTY' | 'DRAFT' | 'AI_SUGGESTED' | 'USER_EDITED' | 'APPROVED';
}

export function WizardSteps({
  projectId,
  steps,
  current,
}: {
  projectId: string;
  steps: WizardStepState[];
  current: number;
}) {
  const ts = useTranslations('sections');

  return (
    <nav aria-label="steps" className="scrollbar-slim -mx-1 overflow-x-auto pb-1">
      <ol className="flex min-w-max gap-1 px-1">
        {steps.map((step) => {
          const active = step.order === current;
          const done = step.status === 'APPROVED';
          const started = step.status !== 'EMPTY';

          return (
            <li key={step.key}>
              <Link
                href={`/projects/${projectId}/wizard/${step.order}`}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs whitespace-nowrap transition-colors',
                  active
                    ? 'border-primary bg-primary-soft font-medium text-primary'
                    : started
                      ? 'border-line bg-surface text-ink-soft hover:border-line-strong'
                      : 'border-line bg-surface text-muted hover:border-line-strong',
                )}
              >
                <span
                  className={cn(
                    'tabular grid size-5 shrink-0 place-items-center rounded-full text-[0.65rem]',
                    done
                      ? 'bg-success/15 text-success'
                      : active
                        ? 'bg-primary text-on-primary'
                        : 'bg-surface-2 text-muted',
                  )}
                >
                  {done ? <Check className="size-3" aria-hidden /> : step.order}
                </span>
                {ts(sectionI18nKey(step.key))}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
