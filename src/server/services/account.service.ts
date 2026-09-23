import { createHash, randomBytes } from 'node:crypto';

import bcrypt from 'bcryptjs';

import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';
import { emailProvider } from '@/server/email';
import { emailVerificationEmail, passwordResetEmail } from '@/server/email/templates';
import { AppError } from '@/server/http/errors';
import * as tokensRepo from '@/server/repositories/tokens.repository';
import * as usersRepo from '@/server/repositories/users.repository';
import type { RegisterInput } from '@/server/validation/auth';

import { attachDefaultPlan } from './subscription.service';

export async function register(input: RegisterInput): Promise<{ id: string; email: string }> {
  const email = input.email.toLowerCase();

  const existing = await usersRepo.findByEmail(email);
  if (existing) {
    throw AppError.conflict(
      'An account with this email already exists.',
      'يوجد حساب مسجَّل بهذا البريد الإلكتروني.',
    );
  }

  const user = await usersRepo.createUser({
    email,
    name: input.name,
    passwordHash: await bcrypt.hash(input.password, 12),
    locale: input.locale,
  });

  await usersRepo.ensureSettings(user.id);
  await attachDefaultPlan(user.id);

  /*
   * The confirmation email goes out with the account, but registration never
   * waits on it or fails because of it: an unverified account works normally,
   * and only owner rights and account linking wait for the proof.
   */
  await requestEmailVerification(user.id, input.locale).catch((error: unknown) => {
    logger.error('auth.verify.sendOnRegisterFailed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return { id: user.id, email: user.email };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await usersRepo.findById(userId);
  if (!user?.passwordHash) {
    throw AppError.conflict(
      'This account signs in with a social provider.',
      'هذا الحساب يسجّل الدخول عبر مزوّد خارجي.',
    );
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    throw AppError.validation({ currentPassword: 'invalidCredentials' });
  }

  await usersRepo.updateUser(userId, { passwordHash: await bcrypt.hash(newPassword, 12) });
}

/* -------------------------------------------------------------------------- */
/*                              Password reset                                */
/* -------------------------------------------------------------------------- */

const RESET_TTL_MINUTES = 30;
const RESET_PREFIX = 'password-reset:';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function baseUrl(): string {
  const env = getEnv();
  return (env.APP_URL ?? env.AUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * Always resolves the same way, whether or not the address exists.
 *
 * Returning "no such user" here would turn the form into an account-enumeration
 * oracle, so the only observable difference is whether an email arrives. Send
 * failures are logged, never surfaced.
 */
export interface PasswordResetRequestResult {
  /**
   * Only populated outside production when the console email provider is active,
   * so local development and the integration tests can follow the link without a
   * mailbox. The API route never returns it.
   */
  devUrl?: string;
}

export async function requestPasswordReset(
  email: string,
  locale: 'ar' | 'en',
): Promise<PasswordResetRequestResult> {
  const user = await usersRepo.findByEmail(email);

  if (!user || !user.passwordHash || user.status === 'SUSPENDED') {
    logger.info('auth.reset.skipped', { reason: user ? 'no-password-or-suspended' : 'unknown' });
    return {};
  }

  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

  await tokensRepo.put(`${RESET_PREFIX}${user.id}`, hashToken(token), expires);

  const url = `${baseUrl()}/${locale}/reset-password?uid=${encodeURIComponent(user.id)}&token=${token}`;
  const provider = emailProvider();

  try {
    await provider.send(
      passwordResetEmail({
        to: user.email,
        name: user.name,
        url,
        locale,
        expiresMinutes: RESET_TTL_MINUTES,
      }),
    );
  } catch (error) {
    // Never surfaced: a send failure must not tell the caller the address exists.
    logger.error('auth.reset.emailFailed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const env = getEnv();
  return provider.name === 'console' && env.NODE_ENV !== 'production' ? { devUrl: url } : {};
}

export async function resetPassword(input: {
  userId: string;
  token: string;
  password: string;
}): Promise<void> {
  const valid = await tokensRepo.take(`${RESET_PREFIX}${input.userId}`, hashToken(input.token));

  if (!valid) {
    throw AppError.conflict(
      'This reset link is invalid or has expired. Request a new one.',
      'رابط إعادة التعيين غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.',
    );
  }

  const user = await usersRepo.findById(input.userId);
  if (!user || user.status === 'SUSPENDED') throw AppError.notFound('user');

  await usersRepo.updateUser(input.userId, {
    passwordHash: await bcrypt.hash(input.password, 12),
  });

  logger.info('auth.reset.completed', { userId: input.userId });
}

/* -------------------------------------------------------------------------- */
/*                             Email verification                             */
/* -------------------------------------------------------------------------- */

const VERIFY_TTL_HOURS = 24;
const VERIFY_PREFIX = 'email-verify:';

export interface EmailVerificationRequestResult {
  /** Already verified — nothing was sent. */
  alreadyVerified?: boolean;
  /** As with password reset: only outside production with the console provider. */
  devUrl?: string;
}

/**
 * Sends a link proving the user controls their address.
 *
 * The token is stored only as a SHA-256 hash in the same single-use table the
 * password reset uses, one live link per user: asking again invalidates the
 * previous link.
 */
export async function requestEmailVerification(
  userId: string,
  locale: 'ar' | 'en',
): Promise<EmailVerificationRequestResult> {
  const user = await usersRepo.findById(userId);
  if (!user || user.status === 'SUSPENDED') return {};
  if (user.emailVerified) return { alreadyVerified: true };

  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + VERIFY_TTL_HOURS * 3_600_000);
  await tokensRepo.put(`${VERIFY_PREFIX}${user.id}`, hashToken(token), expires);

  const url = `${baseUrl()}/${locale}/verify-email?uid=${encodeURIComponent(user.id)}&token=${token}`;
  const provider = emailProvider();

  try {
    await provider.send(
      emailVerificationEmail({ to: user.email, name: user.name, url, locale, expiresHours: VERIFY_TTL_HOURS }),
    );
  } catch (error) {
    logger.error('auth.verify.emailFailed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const env = getEnv();
  return provider.name === 'console' && env.NODE_ENV !== 'production' ? { devUrl: url } : {};
}

/** Consumes a verification link. The token works once, and not after it expires. */
export async function verifyEmail(input: { userId: string; token: string }): Promise<void> {
  const valid = await tokensRepo.take(`${VERIFY_PREFIX}${input.userId}`, hashToken(input.token));

  if (!valid) {
    throw AppError.conflict(
      'This confirmation link is invalid or has expired. Request a new one.',
      'رابط التأكيد غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.',
    );
  }

  const user = await usersRepo.findById(input.userId);
  if (!user || user.status === 'SUSPENDED') throw AppError.notFound('user');

  if (!user.emailVerified) {
    await usersRepo.updateUser(input.userId, { emailVerified: new Date() });
  }

  logger.info('auth.verify.completed', { userId: input.userId });
}
