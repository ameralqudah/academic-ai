import { getFormatter, getTranslations } from 'next-intl/server';

import { ProjectActions } from '@/components/app/project-actions';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Link } from '@/i18n/navigation';
import type { ResearchProject } from '@/server/db/schema';

export async function ProjectCard({
  project,
  locale,
}: {
  project: ResearchProject;
  locale: string;
}) {
  const t = await getTranslations({ locale, namespace: 'projects' });
  const format = await getFormatter({ locale });
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US');

  /*
   * Content that would be lost, so the delete confirmation can say so. A
   * project with chapters written is not the same as an empty one created by
   * mistake.
   */
  const hasContent = project.progressPercent > 0;

  return (
    /*
     * The link wraps the body rather than the whole card, so the action buttons
     * are not inside an anchor — a button inside a link is activated by the
     * link on keyboard navigation, and deleting a project by pressing Enter on
     * its title is not a mistake anyone should be able to make.
     */
    <div className="surface-card group relative flex flex-col gap-3.5 p-5 transition-colors hover:border-line-strong">
      <div className="absolute end-3 top-3 z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <ProjectActions projectId={project.id} title={project.title} hasContent={hasContent} />
      </div>

      <Link href={`/projects/${project.id}`} className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="primary">{t(`degrees.${project.degree}`)}</Badge>
        <Badge tone="accent">{t(`researchTypes.${project.researchType}`)}</Badge>
        <Badge>{t(`languages.${project.language}`)}</Badge>
      </div>

      <h3 className="line-clamp-2 text-[1.05rem] leading-snug font-semibold text-ink group-hover:text-primary">
        {project.title}
      </h3>

      <p className="text-xs text-muted">
        {t(`fields.${project.academicField}`)}
        {project.specialization ? ` · ${project.specialization}` : ''}
      </p>

      <div className="mt-auto flex flex-col gap-2 pt-1">
        <div className="flex items-center justify-between gap-2 text-xs text-muted">
          <span className="tabular">
            {t('progress', { percent: number.format(project.progressPercent) })}
          </span>
          <span className="tabular">
            {t('lastEdited', {
              date: format.relativeTime(project.lastEditedAt, new Date()),
            })}
          </span>
        </div>
        <Progress value={project.progressPercent} label={project.title} />
      </div>
      </Link>
    </div>
  );
}
