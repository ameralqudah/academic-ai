import { ArrowLeft, ArrowRight, Check, Circle, MessagesSquare, PenLine, Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ExportButton } from '@/components/documents/export-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Link } from '@/i18n/navigation';
import { requirePageUser } from '@/server/auth/guards';
import { computeProgress } from '@/server/services/project.service';
import { requireProjectWithSectionsPage } from '@/server/pages/project-page';
import { getSummary } from '@/server/services/usage.service';
import { sectionI18nKey } from '@/lib/sections';

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, id } = await params;
  const user = await requirePageUser(locale);
  const { project } = await requireProjectWithSectionsPage(id, user.id);
  return { title: project.title };
}

export default async function ProjectPage({ params }: Props) {
  const { locale, id } = await params;
  const user = await requirePageUser(locale);

  const t = await getTranslations({ locale, namespace: 'workspace' });
  const td = await getTranslations({ locale, namespace: 'documents' });
  const tp = await getTranslations({ locale, namespace: 'projects' });
  const ts = await getTranslations({ locale, namespace: 'sections' });
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US');
  const Arrow = locale === 'ar' ? ArrowLeft : ArrowRight;

  const [{ project, sections }, summary] = await Promise.all([
    requireProjectWithSectionsPage(id, user.id),
    getSummary(user.id),
  ]);
  const progress = computeProgress(sections);
  const done = sections.filter((section) => section.status !== 'EMPTY').length;
  const canExport = summary.toolAccess.export === true;

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="primary">{tp(`degrees.${project.degree}`)}</Badge>
          <Badge tone="accent">{tp(`researchTypes.${project.researchType}`)}</Badge>
          <Badge>{tp(`languages.${project.language}`)}</Badge>
          <Badge>{tp(`docTypes.${project.docType}`)}</Badge>
        </div>

        <h1 className="max-w-[46ch] text-2xl leading-snug font-bold text-ink sm:text-[1.7rem]">
          {project.title}
        </h1>

        <div className="flex max-w-md flex-col gap-2">
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span className="tabular">
              {t('sectionsDone', { done: number.format(done), total: number.format(sections.length) })}
            </span>
            <span className="tabular">{number.format(progress)}%</span>
          </div>
          <Progress value={progress} label={project.title} />
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="flex flex-col gap-4">
          <CardHeader title={t('outline')} description={t('outlineHint')} />

          <ol className="flex flex-col">
            {sections.map((section, index) => (
              <li
                key={section.id}
                className={[
                  'flex items-center justify-between gap-3 py-3 text-sm',
                  index === sections.length - 1 ? '' : 'border-b border-line',
                ].join(' ')}
              >
                <span className="flex min-w-0 items-center gap-3">
                  {section.status === 'APPROVED' ? (
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-success/15 text-success">
                      <Check className="size-3.5" aria-hidden />
                    </span>
                  ) : (
                    <span className="tabular grid size-6 shrink-0 place-items-center rounded-full border border-line text-[0.7rem] text-muted">
                      {section.status === 'EMPTY' ? (
                        <Circle className="size-2 fill-current" aria-hidden />
                      ) : (
                        number.format(index + 1)
                      )}
                    </span>
                  )}
                  <span className={section.status === 'EMPTY' ? 'text-muted' : 'text-ink'}>
                    {ts(sectionI18nKey(section.sectionKey))}
                  </span>
                </span>

                <span className="flex shrink-0 items-center gap-3">
                  {section.wordCount > 0 ? (
                    <span className="tabular text-xs text-muted">
                      {number.format(section.wordCount)}
                    </span>
                  ) : null}
                  <Badge tone={section.status === 'APPROVED' ? 'success' : 'neutral'}>
                    {ts(`status.${section.status}`)}
                  </Badge>
                </span>
              </li>
            ))}
          </ol>
        </Card>

        <div className="flex flex-col gap-5">
          <Card className="flex flex-col gap-4">
            <CardHeader title={t('nextStep')} />
            <div className="flex flex-col gap-2">
              <Button asChild className="justify-between">
                <Link href={`/projects/${project.id}/titles`}>
                  <span className="flex items-center gap-2">
                    <Sparkles className="size-4" aria-hidden />
                    {t('generateTitles')}
                  </span>
                  <Arrow className="size-4 opacity-60" aria-hidden />
                </Link>
              </Button>
              <Button asChild variant="outline" className="justify-between">
                <Link href={`/projects/${project.id}/wizard/1`}>
                  <span className="flex items-center gap-2">
                    <PenLine className="size-4" aria-hidden />
                    {t('openWizard')}
                  </span>
                  <Arrow className="size-4 opacity-60" aria-hidden />
                </Link>
              </Button>
              <Button asChild variant="outline" className="justify-between">
                <Link href={`/projects/${project.id}/workspace`}>
                  <span className="flex items-center gap-2">
                    <PenLine className="size-4" aria-hidden />
                    {t('openEditor')}
                  </span>
                  <Arrow className="size-4 opacity-60" aria-hidden />
                </Link>
              </Button>
              {/*
                The assistant, opened already pointed at this project.
                
                A plain link, because the chat reads its project from the query
                string. That was the point of putting the selection in the URL:
                the shortcut costs one anchor tag rather than a second code path.
              */}
              <Button asChild variant="outline" className="justify-between">
                <Link href={`/chat?project=${project.id}`}>
                  <span className="flex items-center gap-2">
                    <MessagesSquare className="size-4" aria-hidden />
                    {t('openAssistant')}
                  </span>
                  <Arrow className="size-4 opacity-60" aria-hidden />
                </Link>
              </Button>

              <div className="mt-2 flex flex-wrap gap-2 border-t border-line pt-3">
                <Link
                  href={`/projects/${project.id}/proposal`}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
                >
                  {td('proposalTitle')}
                </Link>
                <Link
                  href={`/projects/${project.id}/thesis`}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
                >
                  {td('thesisTitle')}
                </Link>
                <Link
                  href={`/projects/${project.id}/references`}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
                >
                  {td('references')}
                </Link>
              </div>

              <div className="mt-2 border-t border-line pt-3">
                <ExportButton projectId={project.id} allowed={canExport} />
              </div>
            </div>
          </Card>

          <Card className="flex flex-col gap-4">
            <CardHeader title={t('projectInfo')} />
            <dl className="flex flex-col gap-3 text-sm">
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted">{tp('create.academicField')}</dt>
                <dd className="text-ink">{tp(`fields.${project.academicField}`)}</dd>
              </div>
              {project.specialization ? (
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs text-muted">{tp('create.specialization')}</dt>
                  <dd className="text-ink">{project.specialization}</dd>
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted">{t('keywords')}</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {project.keywords.map((keyword) => (
                    <Badge key={keyword}>{keyword}</Badge>
                  ))}
                </dd>
              </div>
              {project.problemArea ? (
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs text-muted">{t('problemArea')}</dt>
                  <dd className="leading-relaxed text-ink-soft">{project.problemArea}</dd>
                </div>
              ) : null}
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
