import { redirect } from 'next/navigation';

import type { Locale } from '@/i18n/routing';
import { auth } from '@/server/auth';
import { AppError } from '@/server/http/errors';

import { hasAdminAccess } from './owner';

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: 'USER' | 'ADMIN';
  locale: Locale;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  return {
    id: session.user.id,
    email: session.user.email ?? '',
    name: session.user.name ?? null,
    image: session.user.image ?? null,
    role: session.user.role,
    locale: session.user.locale,
  };
}

/** For server components and layouts — redirects instead of throwing. */
export async function requirePageUser(locale: string, returnTo?: string): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    const target = returnTo ? `?callbackUrl=${encodeURIComponent(returnTo)}` : '';
    redirect(`/${locale}/login${target}`);
  }
  return user;
}

export async function requirePageAdmin(locale: string): Promise<CurrentUser> {
  const user = await requirePageUser(locale);
  if (!hasAdminAccess(user)) redirect(`/${locale}/dashboard`);
  return user;
}

/** For server actions and service code reached outside `withApi`. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw AppError.unauthorized();
  return user;
}
