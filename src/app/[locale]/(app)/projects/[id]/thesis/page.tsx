import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { BuildNextSection, DocTypeSwitch } from '@/components/documents/document-actions';
import { SectionList } from '@/components/documents/section-list';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { stepsForDocType, THESIS_CHAPTERS } from '@/config/research';
import { Link } from '@/i18n/navigation';
import { requirePageUser } from '@/server/auth/guards';
import { requireProjectWithSectionsPage } from '@/server/pages/project-page';
import { computeProgress } from '@/server/services/project.service';

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'documents' });
  return { title: t('thesisTitle') };
}

export default async function ThesisPage({ params }: Props) {
  const { locale, id } = await params;
  const user = await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'documents' });
  const tp = await getTranslations({ locale, namespace: 'projects' });

  const { project, sections } = await requireProjectWithSectionsPage(id, user.id);
  const order = THESIS_CHAPTERS.map((chapter) => chapter.key);
  const relevant = sections.filter((section) => (order as string[]).includes(section.sectionKey));
  const nextEmpty =
    order.find(
      (key) => (relevant.find((row) => row.sectionKey === key)?.status ?? 'EMPTY') === 'EMPTY',
    ) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href={`/projects/${id}`} className="text-sm text-muted transition-colors hover:text-ink">
          {project.title}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-ink">{t('thesisTitle')}</h1>
          <Badge tone="primary">{tp(`degrees.${project.degree}`)}</Badge>
        </div>
        <p className="max-w-[62ch] text-sm text-muted">{t('thesisSubtitle')}</p>
      </header>

      {project.docType !== 'THESIS' ? (
        <DocTypeSwitch projectId={id} current={project.docType} target="THESIS" />
      ) : null}

      <div className="flex max-w-md flex-col gap-2">
        <Progress value={computeProgress(relevant)} label={t('thesisTitle')} />
      </div>

      <BuildNextSection projectId={id} nextSection={nextEmpty} />

      <SectionList
        locale={locale}
        projectId={id}
        order={order}
        stepOrder={stepsForDocType(project.docType)}
        sections={relevant}
      />
    </div>
  );
}
