import { getEnv } from '@/config/env';

/**
 * The account that runs the product.
 *
 * One place decides who the owner is, and everything else asks here. Scattering
 * an email literal through guards and services is how an override like this
 * quietly rots: one copy gets updated, another does not, and the difference is
 * invisible until somebody either loses access or gains it by accident.
 *
 * Configured through `OWNER_EMAIL` so it can change without a code change, and
 * so no personal address is committed to the repository.
 *
 * Comparison is case-insensitive and whitespace-tolerant: mail addresses are
 * case-insensitive in their domain part by standard and in practice everywhere,
 * and the value arrives from a hosting panel where a stray space is common.
 * More than one address may be listed, separated by commas.
 */
function ownerEmails(): string[] {
  return (getEnv().OWNER_EMAIL ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function isOwnerEmail(email: string | null | undefined): boolean {
  const normalised = (email ?? '').trim().toLowerCase();
  if (normalised.length === 0) return false;
  return ownerEmails().includes(normalised);
}

/**
 * Administrative access: granted by the stored role, or by being the owner.
 *
 * The owner is an administrator without needing a row in the database to say
 * so — which matters on a fresh deployment, or if the role is ever cleared by
 * accident from the admin panel.
 */
export function hasAdminAccess(user: { email?: string | null; role?: string | null }): boolean {
  return user.role === 'ADMIN' || isOwnerEmail(user.email);
}

/** True when the owner override is configured at all. */
export function ownerOverrideEnabled(): boolean {
  return ownerEmails().length > 0;
}
