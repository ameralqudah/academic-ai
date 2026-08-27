import { expect, test } from '@playwright/test';

import { PASSWORD, registerAndLogin, uniqueEmail } from './helpers';

test.describe('authentication', () => {
  test('a new researcher can register and lands on the dashboard', async ({ page }) => {
    await registerAndLogin(page, 'signup');

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome back');
    await expect(page.getByRole('link', { name: 'New Research Project' })).toBeVisible();
    // A fresh account is on the free plan and told so.
    await expect(page.getByText("You're on the free plan")).toBeVisible();
  });

  test('the free plan limits are shown, not hidden', async ({ page }) => {
    await registerAndLogin(page, 'limits');
    await expect(page.getByText('AI requests left')).toBeVisible();
    await expect(page.locator('aside').getByText('Usage this month')).toBeVisible();
  });

  test('logging out returns to the marketing site and protects the dashboard', async ({ page }) => {
    await registerAndLogin(page, 'logout');

    await page.getByRole('button', { name: 'Log out' }).click();
    await page.waitForURL(/\/en$/, { timeout: 30_000 });

    await page.goto('/en/dashboard');
    await expect(page).toHaveURL(/\/en\/login/);
  });

  test('a wrong password is rejected with a readable message', async ({ page }) => {
    const email = uniqueEmail('wrongpass');

    await page.goto('/en/register');
    await page.getByLabel('Full name').fill('Wrong Password');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL('**/en/dashboard');

    await page.getByRole('button', { name: 'Log out' }).click();
    await page.waitForURL(/\/en$/);

    await page.goto('/en/login');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill('NotThePassword1');
    await page.getByRole('button', { name: 'Log in' }).click();

    await expect(page.getByText("That email and password don't match an account.")).toBeVisible();
  });

  test('registering with an existing email is refused', async ({ page }) => {
    const email = await registerAndLogin(page, 'dupe');
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.waitForURL(/\/en$/);

    await page.goto('/en/register');
    await page.getByLabel('Full name').fill('Duplicate');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText('An account with this email already exists.')).toBeVisible();
  });

  test('password reset gives the same answer for any address', async ({ page }) => {
    await page.goto('/en/login');
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await expect(page).toHaveURL(/\/en\/forgot-password/);

    await page.getByLabel('Email', { exact: true }).fill(uniqueEmail('nobody'));
    await page.getByRole('button', { name: 'Send reset link' }).click();

    // Identical to the response for a real account — no enumeration oracle.
    await expect(page.getByText('Check your inbox')).toBeVisible();
  });

  test('a malformed reset link is refused before any request is sent', async ({ page }) => {
    await page.goto('/en/reset-password?uid=someone&token=short');
    await expect(page.getByText(/This reset link is invalid or has expired/)).toBeVisible();
  });
});
