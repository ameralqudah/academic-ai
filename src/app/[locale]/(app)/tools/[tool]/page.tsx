import { Lock } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { ToolRunner } from '@/components/tools/tool-runner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TOOLS, type ToolKey } from '@/config/research';
import { Link } from '@/i18n/navigation';
import { requirePageUser } from '@/server/auth/guards';
import { listProjects } from '@/server/services/project.service';
import { getSummary } from '@/server/services/usage.service';

type Props = { params: Promise<{ locale: string; tool: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, tool } = await params;
  const definition = TOOLS.find((entry) => entry.key === tool);
  if (!definition) return {};
  const t = await getTranslations({ locale, namespace: 'tools' });
  return { title: t(`${definition.key}.name`) };
}

export default async function ToolPage({ params }: Props) {
  const { locale, tool } = await params;
  const definition = TOOLS.find((entry) => entry.key === tool);
  if (!definition) notFound();

  const user = await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'tools' });
  const tu = await getTranslations({ locale, namespace: 'usage' });

  const [summary, projects] = await Promise.all([getSummary(user.id), listProjects(user.id, 20)]);
  const unlocked = summary.toolAccess[definition.key as ToolKey] === true;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href="/tools" className="text-sm text-muted transition-colors hover:text-ink">
          {t('title')}
        </Link>
        <h1 className="text-2xl font-bold text-ink">{t(`${definition.key}.name`)}</h1>
        <p className="max-w-[62ch] text-sm text-muted">{t(`${definition.key}.description`)}</p>
      </header>

      {unlocked ? (
        <ToolRunner
          tool={definition}
          projects={projects.map((project) => ({ id: project.id, title: project.title }))}
        />
      ) : (
        <Alert
          tone="upgrade"
          title={t('locked')}
          action={
            <Button asChild variant="upgrade" size="sm">
              <Link href="/billing">
                <Lock className="size-3.5" aria-hidden />
                {tu('limitReachedAction')}
              </Link>
            </Button>
          }
        >
          {tu('limitReachedBody')}
        </Alert>
      )}
    </div>
  );
}
