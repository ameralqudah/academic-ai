import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { SectionWorkspace } from '@/components/wizard/section-workspace';
import { WizardSteps } from '@/components/wizard/wizard-steps';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SECTION_BY_KEY, stepsForDocType } from '@/config/research';
import { Link } from '@/i18n/navigation';
import { sectionI18nKey } from '@/lib/sections';
import { requirePageUser } from '@/server/auth/guards';
import { getConversation } from '@/server/services/ai.service';
import { requireProjectWithSectionsPage } from '@/server/pages/project-page';
import { dependentsOf } from '@/server/services/section.service';

type Props = { params: Promise<{ locale: string; id: string; step: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'wizard' });
  return { title: t('title') };
}

export default async function WizardStepPage({ params }: Props) {
  const { locale, id, step } = await params;
  const user = await requirePageUser(locale);

  const t = await getTranslations({ locale, namespace: 'wizard' });
  const ts = await getTranslations({ locale, namespace: 'sections' });
  const Arrow = locale === 'ar' ? ArrowLeft : ArrowRight;
  const Back = locale === 'ar' ? ArrowRight : ArrowLeft;

  const { project, sections } = await requireProjectWithSectionsPage(id, user.id);
  const order = stepsForDocType(project.docType);

  const stepNumber = Number.parseInt(step, 10);
  if (!Number.isFinite(stepNumber) || stepNumber < 1 || stepNumber > order.length) notFound();

  const sectionKey = order[stepNumber - 1]!;
  const section = sections.find((row) => row.sectionKey === sectionKey);
  const definition = SECTION_BY_KEY[sectionKey];
  const heading = ts(sectionI18nKey(sectionKey));

  const titleSection = sections.find((row) => row.sectionKey === 'TITLE');
  const titleReady = Boolean(titleSection?.content.trim());

  const { messages } = await getConversation(user.id, id, sectionKey);

  const stepStates = order.map((key, index) => ({
    key,
    order: index + 1,
    status: sections.find((row) => row.sectionKey === key)?.status ?? ('EMPTY' as const),
  }));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <Link
              href={`/projects/${id}`}
              className="text-sm text-muted transition-colors hover:text-ink"
            >
              {project.title}
            </Link>
            <p className="tabular text-xs text-muted">
              {t('stepOf', { current: stepNumber, total: order.length })}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {stepNumber > 1 ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={`/projects/${id}/wizard/${stepNumber - 1}`}>
                  <Back className="size-4" aria-hidden />
                  {t('previous')}
                </Link>
              </Button>
            ) : null}
            {stepNumber < order.length ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/projects/${id}/wizard/${stepNumber + 1}`}>
                  {t('next')}
                  <Arrow className="size-4" aria-hidden />
                </Link>
              </Button>
            ) : null}
          </div>
        </div>

        <WizardSteps projectId={id} steps={stepStates} current={stepNumber} />
      </header>

      {sectionKey === 'TITLE' && !titleReady ? (
        <Alert
          tone="info"
          title={t('needsTitle')}
          action={
            <Button asChild size="sm">
              <Link href={`/projects/${id}/titles`}>{t('goToTitles')}</Link>
            </Button>
          }
        />
      ) : null}

      <SectionWorkspace
        projectId={id}
        sectionKey={sectionKey}
        heading={heading}
        initialContent={section?.content ?? ''}
        initialStatus={section?.status ?? 'EMPTY'}
        initialMessages={messages
          .filter((message) => message.role !== 'SYSTEM')
          .map((message) => ({
            id: message.id,
            role: message.role === 'ASSISTANT' ? ('ASSISTANT' as const) : ('USER' as const),
            content: message.content,
            flags: message.flags,
          }))}
        requiresUserData={definition?.requiresUserData ?? false}
        dependents={dependentsOf(sectionKey).map((key) => sectionI18nKey(key))}
      />
    </div>
  );
}
