import { ChevronDown } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

const QUESTIONS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] as const;

export async function Faq({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: 'landing' });

  return (
    <section id="faq" className="border-b border-line py-16 lg:py-24">
      <div className="container-page flex flex-col gap-10 lg:flex-row lg:gap-16">
        <header className="flex max-w-sm flex-col gap-3">
          <h2 className="text-[1.75rem] font-bold text-ink sm:text-[2.1rem]">{t('faqTitle')}</h2>
        </header>

        {/* <details> keeps the accordion working without JavaScript. */}
        <div className="flex flex-1 flex-col">
          {QUESTIONS.map((question, index) => (
            <details
              key={question}
              className="group border-b border-line py-1"
              open={index === 0}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-[0.98rem] font-medium text-ink marker:content-none">
                {t(`faq.${question}`)}
                <ChevronDown
                  className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </summary>
              <p className="pb-5 text-sm leading-relaxed text-ink-soft">
                {t(`faq.a${question.slice(1)}`)}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
