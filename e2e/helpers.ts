import type { Page } from '@playwright/test';

/** Unique per run so specs can be re-run against the same database. */
export function uniqueEmail(tag: string): string {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

export const PASSWORD = 'Passw0rd123';

export async function registerAndLogin(
  page: Page,
  tag: string,
  locale: 'ar' | 'en' = 'en',
): Promise<string> {
  const email = uniqueEmail(tag);

  await page.goto(`/${locale}/register`);
  await page.getByLabel(locale === 'ar' ? 'الاسم الكامل' : 'Full name').fill(`E2E ${tag}`);
  await page.getByLabel(locale === 'ar' ? 'البريد الإلكتروني' : 'Email', { exact: true }).fill(email);
  await page
    .getByLabel(locale === 'ar' ? 'كلمة المرور' : 'Password', { exact: true })
    .fill(PASSWORD);
  await page
    .getByLabel(locale === 'ar' ? 'تأكيد كلمة المرور' : 'Confirm password')
    .fill(PASSWORD);
  await page.getByRole('button', { name: locale === 'ar' ? 'إنشاء الحساب' : 'Create account' }).click();

  await page.waitForURL(`**/${locale}/dashboard`, { timeout: 30_000 });
  return email;
}

/** Fills the seven Step 1 fields and submits. */
export async function createProject(page: Page, locale: 'ar' | 'en' = 'en') {
  await page.goto(`/${locale}/projects/new`);

  await page.getByLabel(locale === 'ar' ? 'التخصص الدقيق' : 'Specialisation').fill('E2E specialisation');
  await page.getByRole('radio', { name: locale === 'ar' ? 'ماجستير' : 'Master' }).check();

  const keywordInput = page.getByLabel(locale === 'ar' ? 'الكلمات المفتاحية' : 'Keywords');
  await keywordInput.fill('active learning');
  await keywordInput.press('Enter');
  await keywordInput.fill('achievement');
  await keywordInput.press('Enter');

  await page
    .getByLabel(
      locale === 'ar'
        ? 'المجال أو المشكلة التي تريد البحث فيها'
        : 'The area or problem you want to research',
    )
    .fill(
      'Student achievement in mathematics remains low despite the adoption of modern teaching strategies across the district.',
    );

  await page
    .getByRole('button', { name: locale === 'ar' ? 'ولّد عناوين البحث' : 'Generate research titles' })
    .click();
}
