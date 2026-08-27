import { ArrowLeft, ArrowRight, Check, Circle, Sparkles } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

/** The pipeline preview is a static illustration of the real wizard, not a screenshot. */
const PIPELINE = [
  { key: 'title', state: 'done' },
  { key: 'problem', state: 'done' },
  { key: 'questions', state: 'done' },
  { key: 'objectives', state: 'active' },
  { key: 'hypotheses', state: 'todo' },
  { key: 'literatureReview', state: 'todo' },
  { key: 'methodology', state: 'todo' },
] as const;

export async function Hero({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: 'landing' });
  const ts = await getTranslations({ locale, namespace: 'sections' });
  const Arrow = locale === 'ar' ? ArrowLeft : ArrowRight;

  return (
    <section className="relative overflow-hidden border-b border-line">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_60%_at_75%_0%,var(--accent-soft),transparent_60%)] opacity-70"
      />
      <div className="container-page relative grid gap-12 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:py-24">
        <div className="flex flex-col items-start gap-6">
          <span className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent-soft px-3.5 py-1.5 text-xs font-medium text-accent">
            <Sparkles className="size-3.5" aria-hidden />
            {t('badge')}
          </span>

          <h1 className="text-[2.1rem] leading-[1.25] font-bold text-ink sm:text-[2.7rem] lg:text-[3.1rem]">
            {t('heroTitle')}
          </h1>

          <p className="max-w-[52ch] text-[1.05rem] leading-relaxed text-ink-soft">
            {t('heroSubtitle')}
          </p>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button asChild size="lg">
              <Link href="/register">
                {t('startResearch')}
                <Arrow className="size-4" aria-hidden />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/register?plan=free">{t('tryFree')}</Link>
            </Button>
          </div>

          <p className="text-sm text-muted">{t('heroNote')}</p>
        </div>

        <div className="relative">
          <div className="surface-card overflow-hidden shadow-[0_24px_60px_-40px_rgba(14,27,43,0.55)]">
            <div className="flex items-center justify-between border-b border-line bg-surface-2 px-5 py-3">
              <span className="text-xs font-medium tracking-wide text-muted uppercase">
                Research Wizard
              </span>
              <span className="tabular text-xs text-muted">4 / 13</span>
            </div>

            <ol className="flex flex-col">
              {PIPELINE.map((step, index) => (
                <li
                  key={step.key}
                  className={[
                    'flex items-center gap-3 px-5 py-3.5 text-sm',
                    index === PIPELINE.length - 1 ? '' : 'border-b border-line',
                    step.state === 'active' ? 'bg-primary-soft' : '',
                  ].join(' ')}
                >
                  {step.state === 'done' ? (
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-success/15 text-success">
                      <Check className="size-3.5" aria-hidden />
                    </span>
                  ) : step.state === 'active' ? (
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-on-primary text-[0.7rem] font-semibold">
                      {index + 1}
                    </span>
                  ) : (
                    <span className="grid size-6 shrink-0 place-items-center rounded-full border border-line text-muted">
                      <Circle className="size-2 fill-current" aria-hidden />
                    </span>
                  )}

                  <span
                    className={
                      step.state === 'todo' ? 'text-muted' : 'font-medium text-ink'
                    }
                  >
                    {ts(step.key)}
                  </span>
                </li>
              ))}
            </ol>

            <p className="border-t border-line bg-surface-2 px-5 py-3 text-xs leading-relaxed text-muted">
              {t('trustLine')}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
