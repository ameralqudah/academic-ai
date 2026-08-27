import {
  BookOpenCheck,
  FileStack,
  ListChecks,
  PencilRuler,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';

const FEATURES = [
  { key: 'titles', icon: Sparkles },
  { key: 'plan', icon: ListChecks },
  { key: 'wizard', icon: FileStack },
  { key: 'editor', icon: PencilRuler },
  { key: 'thesis', icon: BookOpenCheck },
  { key: 'tools', icon: Wrench },
  { key: 'integrity', icon: ShieldCheck },
] as const;

export async function Features({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: 'landing' });

  return (
    <section id="features" className="border-b border-line py-16 lg:py-24">
      <div className="container-page flex flex-col gap-10">
        <header className="flex max-w-2xl flex-col gap-3">
          <h2 className="text-[1.75rem] font-bold text-ink sm:text-[2.1rem]">
            {t('featuresTitle')}
          </h2>
          <p className="text-ink-soft">{t('featuresSubtitle')}</p>
        </header>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ key, icon: Icon }, index) => (
            <article
              key={key}
              className={[
                'surface-card flex flex-col gap-3 p-6 transition-colors hover:border-line-strong',
                // The integrity card is the product's differentiator — it gets the wide slot.
                index === FEATURES.length - 1 ? 'sm:col-span-2 lg:col-span-1' : '',
              ].join(' ')}
            >
              <span className="grid size-10 place-items-center rounded-lg bg-primary-soft text-primary">
                <Icon className="size-5" aria-hidden />
              </span>
              <h3 className="text-base font-semibold text-ink">
                {t(`features.${key}.title`)}
              </h3>
              <p className="text-sm leading-relaxed text-ink-soft">{t(`features.${key}.body`)}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
