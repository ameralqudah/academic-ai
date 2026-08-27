import type { Metadata } from 'next';

import { LegalDocumentView } from '@/components/marketing/legal-document';
import { PRIVACY } from '@/content/legal';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return { title: (PRIVACY[locale === 'en' ? 'en' : 'ar'] ?? PRIVACY.ar).title };
}

export default async function PrivacyPage({ params }: Props) {
  const { locale } = await params;
  const key = locale === 'en' ? 'en' : 'ar';
  return <LegalDocumentView locale={locale} document={PRIVACY[key]} />;
}
