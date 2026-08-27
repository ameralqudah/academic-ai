import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ResetPasswordForm } from '@/components/auth/reset-password-form';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ uid?: string; token?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'auth' });
  return { title: t('resetTitle'), robots: { index: false } };
}

export default async function ResetPasswordPage({ searchParams }: Props) {
  const { uid, token } = await searchParams;
  return <ResetPasswordForm uid={uid ?? ''} token={token ?? ''} />;
}
