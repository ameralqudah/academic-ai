import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { LoginForm } from '@/components/auth/login-form';
import { getEnv } from '@/config/env';
import { getCurrentUser } from '@/server/auth/guards';
import { SIGNED_IN_HOME } from '@/config/home';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'auth' });
  return { title: t('loginAction') };
}

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { locale } = await params;
  const { error } = await searchParams;
  const user = await getCurrentUser();
  if (user) redirect(`/${locale}${SIGNED_IN_HOME}`);

  const env = getEnv();
  return (
    <LoginForm
      googleEnabled={Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET)}
      initialErrorCode={error}
    />
  );
}
