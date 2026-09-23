import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { VerifyEmailPanel } from '@/components/auth/verify-email-panel';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ uid?: string; token?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'auth' });
  return { title: t('verifyTitle'), robots: { index: false } };
}

export default async function VerifyEmailPage({ searchParams }: Props) {
  const { uid, token } = await searchParams;
  return <VerifyEmailPanel uid={uid ?? ''} token={token ?? ''} />;
}
