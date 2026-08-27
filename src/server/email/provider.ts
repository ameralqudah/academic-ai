/**
 * Transactional email behind one interface — the same shape as the AI and
 * billing providers, for the same reason: the feature ships and can be tested
 * before anyone signs up for a mail vendor.
 *
 * `ConsoleEmailProvider` is the default and prints the message (including the
 * reset link) to the server log, so the whole password-reset flow works in
 * development with no credentials at all.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  readonly name: 'console' | 'resend';
  isConfigured(): boolean;
  send(message: EmailMessage): Promise<void>;
}
