import { FileText, FolderKanban, MessageSquare, Plus, Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';

import { ProjectCard } from '@/components/app/project-card';
import { StatTile } from '@/components/app/stat-tile';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { requirePageUser } from '@/server/auth/guards';
import { listProjects } from '@/server/services/project.service';
import { getSummary } from '@/server/services/usage.service';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'nav' });
  return { title: t('dashboard') };
}

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const user = await requirePageUser(locale);

  const t = await getTranslations({ locale, namespace: 'dashboard' });
  const format = await getFormatter({ locale });
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US');

  const [summary, projects] = await Promise.all([getSummary(user.id), listProjects(user.id, 6)]);

  const inProgress = projects.filter(
    (project) => project.progressPercent > 0 && project.progressPercent < 100,
  ).length;

  const planName = locale === 'ar' ? summary.plan.nameAr : summary.plan.nameEn;
  const unlimited = t('stats.unlimited');

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-ink sm:text-[1.75rem]">
            {user.name ? t('greeting', { name: user.name }) : t('greetingAnonymous')}
          </h1>
          <p className="text-sm text-muted">{t('subtitle')}</p>
        </div>

        <Button asChild>
          <Link href="/projects/new">
            <Plus className="size-4" aria-hidden />
            {t('newProject')}
          </Link>
        </Button>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label={t('stats.projects')}
          value={number.format(summary.projects.used)}
          hint={
            summary.projects.limit < 0
              ? unlimited
              : `${t('stats.projects')} · ${number.format(summary.projects.limit)}`
          }
          icon={FolderKanban}
          tone="primary"
        />
        <StatTile
          label={t('stats.activeProjects')}
          value={number.format(inProgress)}
          icon={FileText}
        />
        <StatTile
          label={t('stats.wordsUsed')}
          value={number.format(summary.generatedWords.used)}
          hint={
            summary.generatedWords.limit < 0
              ? unlimited
              : `${number.format(summary.generatedWords.limit)} ${t('stats.wordsUsed')}`
          }
          icon={Sparkles}
          tone="accent"
        />
        <StatTile
          label={t('stats.requestsLeft')}
          value={
            summary.aiRequests.limit < 0
              ? unlimited
              : number.format(Math.max(0, summary.aiRequests.remaining))
          }
          hint={t('stats.resetsOn', {
            date: format.dateTime(summary.resetsAt, { day: 'numeric', month: 'short' }),
          })}
          icon={MessageSquare}
        />
      </div>

      {!summary.plan.isPro ? (
        <Alert
          tone="upgrade"
          title={t('upgradeTitle')}
          action={
            <Button asChild variant="upgrade" size="sm">
              <Link href="/billing">{t('upgradeAction')}</Link>
            </Button>
          }
        >
          {t('upgradeBody')}
        </Alert>
      ) : (
        <p className="text-sm text-muted">
          {t('stats.plan')}: <span className="font-medium text-ink">{planName}</span>
        </p>
      )}

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">{t('recentTitle')}</h2>
          {projects.length > 0 ? (
            <Link href="/projects" className="text-sm font-medium text-primary hover:underline">
              {t('viewAll')}
            </Link>
          ) : null}
        </div>

        {projects.length === 0 ? (
          <div className="surface-card flex flex-col items-start gap-4 p-8">
            <div className="flex flex-col gap-2">
              <h3 className="text-base font-semibold text-ink">{t('emptyTitle')}</h3>
              <p className="max-w-[58ch] text-sm leading-relaxed text-ink-soft">{t('emptyBody')}</p>
            </div>
            <Button asChild>
              <Link href="/projects/new">
                <Plus className="size-4" aria-hidden />
                {t('emptyAction')}
              </Link>
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} locale={locale} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
