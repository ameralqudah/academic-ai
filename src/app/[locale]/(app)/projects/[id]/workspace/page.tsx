import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SectionWorkspace } from '@/components/wizard/section-workspace';
import { Badge } from '@/components/ui/badge';
import { isSectionKey, SECTION_BY_KEY, stepsForDocType } from '@/config/research';
import { Link } from '@/i18n/navigation';
import { sectionI18nKey } from '@/lib/sections';
import { requirePageUser } from '@/server/auth/guards';
import { getConversation } from '@/server/services/ai.service';
import { requireProjectWithSectionsPage } from '@/server/pages/project-page';
import { dependentsOf } from '@/server/services/section.service';

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ section?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'documents' });
  return { title: t('workspaceTitle') };
}

export default async function WorkspacePage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  const { section: requested } = await searchParams;
  const user = await requirePageUser(locale);

  const t = await getTranslations({ locale, namespace: 'documents' });
  const ts = await getTranslations({ locale, namespace: 'sections' });
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US');

  const { project, sections } = await requireProjectWithSectionsPage(id, user.id);
  const order = stepsForDocType(project.docType);

  const activeKey =
    requested && isSectionKey(requested) && order.includes(requested)
      ? requested
      : (order.find(
          (key) => sections.find((row) => row.sectionKey === key)?.status !== 'APPROVED',
        ) ?? order[0]!);

  const active = sections.find((row) => row.sectionKey === activeKey);
  const { messages } = await getConversation(user.id, id, activeKey);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <Link href={`/projects/${id}`} className="text-sm text-muted transition-colors hover:text-ink">
          {project.title}
        </Link>
        <h1 className="text-xl font-bold text-ink">{t('workspaceTitle')}</h1>
      </header>

      <div className="grid gap-5 xl:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label={t('outline')} className="xl:sticky xl:top-6 xl:self-start">
          <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
            {t('outline')}
          </p>
          <ol className="scrollbar-slim flex gap-1 overflow-x-auto pb-1 xl:flex-col xl:overflow-visible">
            {order.map((key) => {
              const row = sections.find((entry) => entry.sectionKey === key);
              const isActive = key === activeKey;
              return (
                <li key={key} className="shrink-0 xl:shrink">
                  <Link
                    href={`/projects/${id}/workspace?section=${key}`}
                    aria-current={isActive ? 'page' : undefined}
                    className={[
                      'flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs whitespace-nowrap transition-colors xl:whitespace-normal',
                      isActive
                        ? 'bg-primary-soft font-medium text-primary'
                        : 'text-ink-soft hover:bg-surface-2',
                    ].join(' ')}
                  >
                    <span className="truncate">{ts(sectionI18nKey(key))}</span>
                    {row && row.wordCount > 0 ? (
                      <span className="tabular text-[0.65rem] text-muted">
                        {number.format(row.wordCount)}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ol>

          <p className="mt-3 hidden xl:block">
            <Badge tone="neutral">
              {number.format(project.totalWords)} {ts('status.DRAFT')}
            </Badge>
          </p>
        </nav>

        <SectionWorkspace
          key={activeKey}
          projectId={id}
          sectionKey={activeKey}
          heading={ts(sectionI18nKey(activeKey))}
          initialContent={active?.content ?? ''}
          initialStatus={active?.status ?? 'EMPTY'}
          initialMessages={messages
            .filter((message) => message.role !== 'SYSTEM')
            .map((message) => ({
              id: message.id,
              role: message.role === 'ASSISTANT' ? ('ASSISTANT' as const) : ('USER' as const),
              content: message.content,
              flags: message.flags,
            }))}
          requiresUserData={SECTION_BY_KEY[activeKey]?.requiresUserData ?? false}
          dependents={dependentsOf(activeKey).map((key) => sectionI18nKey(key))}
        />
      </div>
    </div>
  );
}
