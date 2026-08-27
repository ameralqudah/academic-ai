import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';

import type { EmailMessage, EmailProvider } from './provider';

const ENDPOINT = 'https://api.resend.com/emails';

/**
 * HTTP API, no SDK — same reasoning as the AI and Stripe providers.
 * To use a different vendor, copy this file, change `ENDPOINT` and the body
 * shape, and register it in `index.ts`. Nothing else in the app changes.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend' as const;

  private get apiKey(): string {
    return getEnv().RESEND_API_KEY ?? '';
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0 && Boolean(getEnv().EMAIL_FROM);
  }

  async send(message: EmailMessage): Promise<void> {
    const env = getEnv();

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });

    if (!response.ok) {
      // The caller must not surface this to the user — a failed send would
      // otherwise reveal whether an address exists.
      logger.error('email.resend.failed', {
        status: response.status,
        detail: (await response.text()).slice(0, 300),
      });
      throw new Error(`Email provider responded ${response.status}`);
    }
  }
}
