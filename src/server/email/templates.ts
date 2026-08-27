import type { EmailMessage } from './provider';

/**
 * Emails are written in the recipient's interface language and rendered RTL for
 * Arabic — a left-aligned Arabic email reads as broken, and this is often the
 * first message a user gets from the product.
 */

interface ResetInput {
  to: string;
  name: string | null;
  url: string;
  locale: 'ar' | 'en';
  expiresMinutes: number;
}

const COPY = {
  ar: {
    subject: 'إعادة تعيين كلمة المرور — المساعد الأكاديمي للبحث العلمي',
    greeting: (name: string | null) => (name ? `مرحبًا ${name}،` : 'مرحبًا،'),
    body: 'وصلنا طلب لإعادة تعيين كلمة مرور حسابك. اضغط الزر أدناه لاختيار كلمة مرور جديدة.',
    action: 'إعادة تعيين كلمة المرور',
    expiry: (minutes: number) => `الرابط صالح لمدة ${minutes} دقيقة.`,
    ignore: 'إن لم تطلب ذلك، تجاهل هذه الرسالة — لن يتغيّر شيء في حسابك.',
    fallback: 'إن لم يعمل الزر، انسخ هذا الرابط والصقه في المتصفح:',
  },
  en: {
    subject: 'Reset your password — Academic AI Research Assistant',
    greeting: (name: string | null) => (name ? `Hi ${name},` : 'Hi,'),
    body: 'We received a request to reset your account password. Use the button below to choose a new one.',
    action: 'Reset password',
    expiry: (minutes: number) => `This link is valid for ${minutes} minutes.`,
    ignore: "If you didn't request this, ignore this email — nothing will change.",
    fallback: "If the button doesn't work, copy this link into your browser:",
  },
} as const;

export function passwordResetEmail(input: ResetInput): EmailMessage {
  const copy = COPY[input.locale];
  const dir = input.locale === 'ar' ? 'rtl' : 'ltr';
  const align = input.locale === 'ar' ? 'right' : 'left';

  const text = [
    copy.greeting(input.name),
    '',
    copy.body,
    '',
    input.url,
    '',
    copy.expiry(input.expiresMinutes),
    copy.ignore,
  ].join('\n');

  const html = `<!doctype html>
<html lang="${input.locale}" dir="${dir}">
  <body style="margin:0;padding:24px;background:#f4f6f9;font-family:'Segoe UI',system-ui,sans-serif;color:#0e1b2b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #dce3ec;border-radius:12px;">
      <tr>
        <td style="padding:32px;text-align:${align};">
          <p style="margin:0 0 16px;font-size:16px;font-weight:600;">${copy.greeting(input.name)}</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.8;color:#33445a;">${copy.body}</p>
          <p style="margin:0 0 24px;">
            <a href="${input.url}" style="display:inline-block;background:#12417a;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:500;">${copy.action}</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;color:#5d6b7f;">${copy.expiry(input.expiresMinutes)}</p>
          <p style="margin:0 0 24px;font-size:13px;color:#5d6b7f;">${copy.ignore}</p>
          <p style="margin:0 0 6px;font-size:12px;color:#5d6b7f;">${copy.fallback}</p>
          <p style="margin:0;font-size:12px;word-break:break-all;" dir="ltr"><a href="${input.url}" style="color:#12417a;">${input.url}</a></p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { to: input.to, subject: copy.subject, html, text };
}
