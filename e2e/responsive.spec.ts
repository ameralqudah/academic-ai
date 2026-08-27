import { expect, test } from '@playwright/test';

import { registerAndLogin } from './helpers';

/**
 * Runs on a phone viewport. The thing that actually breaks bilingual layouts is
 * horizontal overflow — an Arabic RTL page that scrolls sideways on a phone is
 * unusable, and it is invisible on a desktop viewport.
 */
async function horizontalOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('mobile layout', () => {
  test('the Arabic landing page does not scroll sideways', async ({ page }) => {
    await page.goto('/ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('the English landing page does not scroll sideways', async ({ page }) => {
    await page.goto('/en');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('the mobile menu opens and navigates', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('link', { name: 'Create account' })).toBeVisible();
  });

  test('the dashboard fits a phone and its drawer works', async ({ page }) => {
    await registerAndLogin(page, 'mobile');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('link', { name: 'AI Tools' })).toBeVisible();
    await page.getByRole('link', { name: 'AI Tools' }).click();
    await expect(page).toHaveURL(/\/en\/tools$/);
  });

  test('dark mode applies and survives a reload', async ({ page }) => {
    await page.goto('/en');
    // On a phone the theme control lives inside the collapsed menu.
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('button', { name: 'Dark' }).first().click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.reload();
    // The pre-hydration script must apply the stored theme before first paint.
    await expect(page.locator('html')).toHaveClass(/dark/);
  });
});
