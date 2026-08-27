import { logger } from '@/lib/logger';

import type { EmailMessage, EmailProvider } from './provider';

/**
 * Writes the message to the log instead of sending it.
 *
 * Deliberately the default: a developer running `npm run dev` can complete a
 * password reset by copying the link out of the terminal. It refuses to be the
 * active provider in production (see `index.ts`).
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console' as const;

  isConfigured(): boolean {
    return true;
  }

  async send(message: EmailMessage): Promise<void> {
    logger.info('email.console', {
      to: message.to,
      subject: message.subject,
      body: message.text,
    });
  }
}
