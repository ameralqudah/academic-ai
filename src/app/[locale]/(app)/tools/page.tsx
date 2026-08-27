import {
  AlignLeft,
  Compass,
  FlaskConical,
  HelpCircle,
  Languages,
  Lock,
  PenLine,
  Quote,
  Search,
  type LucideIcon,
} from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { TOOLS } from '@/config/research';
import { Link } from '@/i18n/navigation';
import { requirePageUser } from '@/server/auth/guards';
import { getSummary } from '@/server/services/usage.service';

const ICONS: Record<string, LucideIcon> = {
  'pen-line': PenLine,
  'align-left': AlignLeft,
  'help-circle': HelpCircle,
  'flask-conical': FlaskConical,
  search: Search,
  compass: Compass,
  languages: Languages,
  quote: Quote,
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'tools' });
  return { title: t('title') };
}

export default async function ToolsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const user = await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'tools' });
  const tc = await getTranslations({ locale, namespace: 'common' });
  const summary = await getSummary(user.id);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-ink">{t('title')}</h1>
        <p className="text-sm text-muted">{t('subtitle')}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {TOOLS.map((tool) => {
          const Icon = ICONS[tool.icon] ?? PenLine;
          const unlocked = summary.toolAccess[tool.key] === true;

          const body = (
            <>
              <div className="flex items-start justify-between gap-3">
                <span
                  className={
                    unlocked
                      ? 'grid size-10 place-items-center rounded-lg bg-primary-soft text-primary'
                      : 'grid size-10 place-items-center rounded-lg bg-surface-2 text-muted'
                  }
                >
                  <Icon className="size-5" aria-hidden />
                </span>
                {unlocked ? (
                  <Badge tone="accent">{tc('learnMore')}</Badge>
                ) : (
                  <Badge tone="upgrade">
                    <Lock className="size-3" aria-hidden />
                    Pro
                  </Badge>
                )}
              </div>

              <h2 className="text-base font-semibold text-ink">{t(`${tool.key}.name`)}</h2>
              <p className="text-sm leading-relaxed text-ink-soft">{t(`${tool.key}.description`)}</p>
            </>
          );

          return unlocked ? (
            <Link
              key={tool.key}
              href={`/tools/${tool.key}`}
              className="surface-card flex flex-col gap-3 p-5 transition-colors hover:border-line-strong sm:p-6"
            >
              {body}
            </Link>
          ) : (
            <Card key={tool.key} className="flex flex-col gap-3">
              {body}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
