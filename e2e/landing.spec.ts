import { expect, test } from '@playwright/test';

test.describe('locale negotiation', () => {
  test.describe('an Arabic-speaking visitor', () => {
    test.use({ locale: 'ar-JO' });

    test('lands on the Arabic site, rendered right-to-left', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/\/ar$/);

      const html = page.locator('html');
      await expect(html).toHaveAttribute('dir', 'rtl');
      await expect(html).toHaveAttribute('lang', 'ar');

      await expect(page.getByRole('heading', { level: 1 })).toContainText('رسالة مكتملة');
      // The call to action appears in the hero and again at the foot of the page.
      await expect(page.getByRole('link', { name: 'ابدأ البحث' }).first()).toBeVisible();
    });
  });

  test('an English-speaking visitor lands on the English site', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });
});

test.describe('landing page', () => {
  test('the Arabic page is reachable directly and reads right-to-left', async ({ page }) => {
    await page.goto('/ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('رسالة مكتملة');
  });

  test('switches to English and flips direction', async ({ page }) => {
    await page.goto('/ar');
    await page.getByRole('button', { name: /English/ }).click();

    await expect(page).toHaveURL(/\/en$/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('finished thesis');
  });

  test('shows both plans with the real prices', async ({ page }) => {
    await page.goto('/en');

    const pricing = page.locator('#pricing');
    await expect(pricing.getByRole('heading', { name: 'Free', exact: true })).toBeVisible();
    await expect(pricing.getByRole('heading', { name: 'Pro', exact: true })).toBeVisible();
    await expect(pricing).toContainText('$15');
    await expect(pricing).toContainText('1 research project');
  });

  test('the FAQ opens and answers without JavaScript state', async ({ page }) => {
    await page.goto('/en');

    const question = page.getByText('Will it invent references?', { exact: true });
    await question.click();
    await expect(
      page.getByText(/Any citation it suggests is stored as unverified/),
    ).toBeVisible();
  });

  test('the integrity promise is on the page', async ({ page }) => {
    await page.goto('/en');
    await expect(page.getByText('Sources you can defend')).toBeVisible();
    await expect(page.getByText(/never invents references or DOIs/)).toBeVisible();
  });
});
