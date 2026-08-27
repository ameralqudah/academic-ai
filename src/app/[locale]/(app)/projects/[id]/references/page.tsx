import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ReferencesManager } from '@/components/references/references-manager';
import { Link } from '@/i18n/navigation';
import { requirePageUser } from '@/server/auth/guards';
import { requireProjectPage } from '@/server/pages/project-page';
import { listReferences } from '@/server/services/reference.service';
import * as usersRepo from '@/server/repositories/users.repository';

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'documents' });
  return { title: t('references') };
}

export default async function ReferencesPage({ params }: Props) {
  const { locale, id } = await params;
  const user = await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'documents' });

  const [project, items, settings] = await Promise.all([
    requireProjectPage(id, user.id),
    listReferences(id, user.id),
    usersRepo.ensureSettings(user.id),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href={`/projects/${id}`} className="text-sm text-muted transition-colors hover:text-ink">
          {project.title}
        </Link>
        <h1 className="text-2xl font-bold text-ink">{t('references')}</h1>
      </header>

      <ReferencesManager
        projectId={id}
        initial={items}
        defaultStyle={settings.citationStyle}
      />
    </div>
  );
}
