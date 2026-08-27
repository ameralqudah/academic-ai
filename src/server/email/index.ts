import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';

import { ConsoleEmailProvider } from './console';
import type { EmailProvider } from './provider';
import { ResendEmailProvider } from './resend';

let cached: EmailProvider | null = null;

export function emailProvider(): EmailProvider {
  if (cached) return cached;

  const env = getEnv();

  if (env.EMAIL_PROVIDER === 'resend') {
    const resend = new ResendEmailProvider();
    if (resend.isConfigured()) {
      cached = resend;
      return cached;
    }
    logger.warn('email.resend.unconfigured', {
      detail: 'EMAIL_PROVIDER=resend but RESEND_API_KEY or EMAIL_FROM is missing.',
    });
  }

  if (env.NODE_ENV === 'production') {
    logger.warn('email.console.inProduction', {
      detail:
        'No email provider is configured; password-reset links are only written to the log. Set EMAIL_PROVIDER=resend with RESEND_API_KEY and EMAIL_FROM.',
    });
  }

  cached = new ConsoleEmailProvider();
  return cached;
}

export type { EmailMessage, EmailProvider } from './provider';
