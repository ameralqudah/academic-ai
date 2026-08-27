import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { BuildNextSection, DocTypeSwitch } from '@/components/documents/document-actions';
import { SectionList } from '@/components/documents/section-list';
import { Progress } from '@/components/ui/progress';
import { PROPOSAL_SECTIONS, stepsForDocType } from '@/config/research';
import { Link } from '@/i18n/navigation';
import { requirePageUser } from '@/server/auth/guards';
import { requireProjectWithSectionsPage } from '@/server/pages/project-page';
import { computeProgress } from '@/server/services/project.service';

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'documents' });
  return { title: t('proposalTitle') };
}

export default async function ProposalPage({ params }: Props) {
  const { locale, id } = await params;
  const user = await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'documents' });

  const { project, sections } = await requireProjectWithSectionsPage(id, user.id);
  const relevant = sections.filter((section) =>
    (PROPOSAL_SECTIONS as string[]).includes(section.sectionKey),
  );
  const nextEmpty =
    PROPOSAL_SECTIONS.find(
      (key) => (relevant.find((row) => row.sectionKey === key)?.status ?? 'EMPTY') === 'EMPTY',
    ) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href={`/projects/${id}`} className="text-sm text-muted transition-colors hover:text-ink">
          {project.title}
        </Link>
        <h1 className="text-2xl font-bold text-ink">{t('proposalTitle')}</h1>
        <p className="max-w-[62ch] text-sm text-muted">{t('proposalSubtitle')}</p>
      </header>

      {project.docType !== 'PROPOSAL' ? (
        <DocTypeSwitch projectId={id} current={project.docType} target="PROPOSAL" />
      ) : null}

      <div className="flex max-w-md flex-col gap-2">
        <Progress value={computeProgress(relevant)} label={t('proposalTitle')} />
      </div>

      <BuildNextSection projectId={id} nextSection={nextEmpty} />

      <SectionList
        locale={locale}
        projectId={id}
        order={[...PROPOSAL_SECTIONS]}
        stepOrder={stepsForDocType(project.docType)}
        sections={relevant}
      />
    </div>
  );
}
