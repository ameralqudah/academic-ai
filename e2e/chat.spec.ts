import { expect, test } from '@playwright/test';

import { registerAndLogin } from './helpers';

/**
 * The chat workspace, and the locale behaviour underneath it.
 *
 * These assert the shape of the change rather than the styling: that an
 * unprefixed path picks English, that Arabic stays reachable, and that the
 * conversation survives a reload — which is the thing the persistence layer was
 * built for and the thing a user notices immediately when it is missing.
 *
 * Not run in this session. Playwright needs a running application and a
 * database, and neither is available where these were written. They are
 * type-checked and follow the conventions of the existing specs; whether they
 * pass is something the first real run will say.
 */

test.describe('English is the default', () => {
  test('an unprefixed path resolves to English', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('an unprefixed inner path resolves to English too', async ({ page }) => {
    /*
     * This is what the middleware fixes. Before it existed, `/pricing` was a
     * 404 and every working link in the product had to carry a locale.
     */
    await page.goto('/pricing');
    await expect(page).toHaveURL(/\/en\/pricing/);
  });

  test('Arabic stays reachable rather than being redirected away', async ({ page }) => {
    /*
     * The distinction the whole locale decision turned on. Making English the
     * default must not make Arabic unreachable — a permanent redirect from
     * /ar to /en would leave the language switcher with nowhere to go.
     */
    await page.goto('/ar');
    await expect(page).toHaveURL(/\/ar$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});

test.describe('the chat workspace', () => {
  test('opens, sends a message, and keeps it after a reload', async ({ page }) => {
    await registerAndLogin(page, 'chat', 'en');

    await page.goto('/en/chat');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const composer = page.getByRole('textbox');
    await expect(composer).toBeVisible();

    await composer.fill('What is the difference between Pearson and Spearman?');
    await composer.press('Enter');

    // The user's own message appears immediately, before any reply arrives.
    await expect(
      page.getByText('What is the difference between Pearson and Spearman?'),
    ).toBeVisible({ timeout: 15_000 });

    /*
     * The assertion the persistence work exists for. Before it, a reload
     * emptied the conversation — the thread lived in browser state and nowhere
     * else.
     */
    await page.reload();
    await expect(
      page.getByText('What is the difference between Pearson and Spearman?'),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('a project can be selected without being required', async ({ page }) => {
    await registerAndLogin(page, 'chat-project', 'en');
    await page.goto('/en/chat');

    /*
     * "No project" is the default state, and that is deliberate: most of what
     * the assistant does needs no project, and requiring one would tax every
     * user with an empty container before they could ask anything.
     */
    await expect(page.getByRole('button', { name: /no project/i })).toBeVisible();
  });

  test('a file can be attached', async ({ page }) => {
    await registerAndLogin(page, 'chat-file', 'en');
    await page.goto('/en/chat');

    // The input is hidden behind a button, so its presence is checked directly.
    await expect(page.locator('input[type="file"]')).toBeAttached();
    await expect(page.getByRole('button', { name: /attach/i })).toBeVisible();
  });
});

test.describe('switching language', () => {
  test('moves between locales and keeps the page', async ({ page }) => {
    await registerAndLogin(page, 'chat-locale', 'en');
    await page.goto('/en/chat');

    await page.getByRole('button', { name: /العربية|Arabic/i }).click();

    await expect(page).toHaveURL(/\/ar\/chat/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    /* And back, so the switch is not one-way. */
    await page.getByRole('button', { name: /English|الإنجليزية/i }).click();
    await expect(page).toHaveURL(/\/en\/chat/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });
});
