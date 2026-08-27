import type { Metadata } from 'next';

import { LegalDocumentView } from '@/components/marketing/legal-document';
import { TERMS } from '@/content/legal';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return { title: (TERMS[locale === 'en' ? 'en' : 'ar'] ?? TERMS.ar).title };
}

export default async function TermsPage({ params }: Props) {
  const { locale } = await params;
  const key = locale === 'en' ? 'en' : 'ar';
  return <LegalDocumentView locale={locale} document={TERMS[key]} />;
}
