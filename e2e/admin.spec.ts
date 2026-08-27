import { expect, test } from '@playwright/test';

import { PASSWORD, registerAndLogin } from './helpers';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? PASSWORD;

test.describe('admin access control', () => {
  test('an ordinary user has no admin link and cannot reach /admin', async ({ page }) => {
    await registerAndLogin(page, 'notadmin');

    await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);

    await page.goto('/en/admin');
    // The layout guard bounces non-admins back to their own dashboard.
    await expect(page).toHaveURL(/\/en\/dashboard$/);
  });

  test('an ordinary user gets a 403 envelope from the admin API', async ({ page }) => {
    await registerAndLogin(page, 'adminapi');

    const response = await page.request.get('/api/admin/stats');
    expect(response.status()).toBe(403);

    const body = (await response.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('the seeded admin sees the platform figures', async ({ page }) => {
    test.skip(!ADMIN_EMAIL, 'Set E2E_ADMIN_EMAIL to run the admin dashboard test.');

    await page.goto('/en/login');
    await page.getByLabel('Email', { exact: true }).fill(ADMIN_EMAIL!);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForURL('**/en/dashboard');

    await page.getByRole('link', { name: 'Admin' }).click();
    await expect(page).toHaveURL(/\/en\/admin$/);

    await expect(page.getByText('Total users')).toBeVisible();
    await expect(page.getByText('Monthly revenue')).toBeVisible();
    await expect(page.getByText('Estimated AI cost')).toBeVisible();

    await page.getByRole('link', { name: 'Plans' }).click();
    await expect(page).toHaveURL(/\/en\/admin\/plans$/);
    await expect(page.getByLabel('AI requests / month').first()).toBeVisible();

    await page.getByRole('link', { name: 'AI usage' }).click();
    await expect(page.getByRole('heading', { name: 'AI provider' })).toBeVisible();
  });
});
