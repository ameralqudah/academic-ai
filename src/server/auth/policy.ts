/**
 * Sign-in decisions, as pure functions.
 *
 * Kept apart from the Auth.js configuration so they can be tested without a
 * provider, a database or a request: the truth tables here are the security
 * boundary, and they should be readable and checkable on their own.
 */

export type OAuthSignInDecision =
  | { allow: true }
  | { allow: false; reason: 'provider-email-unverified' | 'local-account-unverified' | 'suspended' };

/**
 * Whether a Google sign-in may proceed.
 *
 * Linking a Google identity to an existing account by email is convenient and
 * safe only when both sides have proven the address. The dangerous case is an
 * account someone *registered* with a victim's address and never verified: if
 * the victim later signs in with Google and is linked into it, the registrant
 * still holds the password and shares the account.
 *
 * - The provider must say the address is verified.
 * - An existing account that is not yet linked to this identity may be linked
 *   only if it has no password (it was created by an OAuth sign-in) or its
 *   address is verified.
 * - A suspended account is refused whatever the provider.
 */
export function decideOAuthSignIn(input: {
  providerEmailVerified: boolean;
  /** The account already carries this provider identity — a normal sign-in. */
  alreadyLinked: boolean;
  existing: { hasPassword: boolean; emailVerified: boolean; suspended: boolean } | null;
}): OAuthSignInDecision {
  if (input.existing?.suspended) return { allow: false, reason: 'suspended' };
  if (!input.providerEmailVerified) return { allow: false, reason: 'provider-email-unverified' };
  if (input.alreadyLinked || !input.existing) return { allow: true };
  if (input.existing.hasPassword && !input.existing.emailVerified) {
    return { allow: false, reason: 'local-account-unverified' };
  }
  return { allow: true };
}

/** The error code the login page reads to explain a refused sign-in. */
export function signInErrorCode(reason: Exclude<OAuthSignInDecision, { allow: true }>['reason']): string {
  switch (reason) {
    case 'suspended':
      return 'AccountSuspended';
    case 'provider-email-unverified':
      return 'ProviderEmailUnverified';
    case 'local-account-unverified':
      return 'LinkRequiresVerification';
  }
}
