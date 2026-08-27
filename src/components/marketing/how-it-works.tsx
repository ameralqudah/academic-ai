import { getTranslations } from 'next-intl/server';

const STEPS = ['step1', 'step2', 'step3', 'step4'] as const;

export async function HowItWorks({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: 'landing' });

  return (
    <section id="how-it-works" className="border-b border-line bg-surface py-16 lg:py-24">
      <div className="container-page flex flex-col gap-10">
        <header className="flex max-w-2xl flex-col gap-3">
          <h2 className="text-[1.75rem] font-bold text-ink sm:text-[2.1rem]">{t('howTitle')}</h2>
          <p className="text-ink-soft">{t('howSubtitle')}</p>
        </header>

        {/* Numbered because these steps genuinely run in order — the platform
            will not open the wizard before a title has been selected. */}
        <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li key={step} className="flex flex-col gap-3 border-t-2 border-primary/25 pt-5">
              <span className="tabular text-sm font-semibold text-accent">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="text-base font-semibold text-ink">{t(`how.${step}.title`)}</h3>
              <p className="text-sm leading-relaxed text-ink-soft">{t(`how.${step}.body`)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
