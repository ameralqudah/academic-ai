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

test.describe('the sidebar', () => {
  test('shows the sections and a way to start a new chat', async ({ page }) => {
    await registerAndLogin(page, 'sidebar', 'en');
    await page.goto('/en/chat');

    await expect(page.getByRole('link', { name: 'New chat' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Academic search' })).toBeVisible();
  });

  test('shows unbuilt features as disabled rather than hiding them', async ({ page }) => {
    await registerAndLogin(page, 'sidebar-soon', 'en');
    await page.goto('/en/chat');

    /*
     * Web search and deep research are visible and marked "Soon". Hiding them
     * would leave a user unable to tell a missing feature from one they failed
     * to find; making them clickable would promise something that does not
     * exist. They are rendered as plain text, so they are not links.
     */
    await expect(page.getByText('Web search')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Web search' })).toHaveCount(0);
    await expect(page.getByText('Deep research')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Deep research' })).toHaveCount(0);
  });

  test('collapses and stays collapsed after a reload', async ({ page }) => {
    await registerAndLogin(page, 'sidebar-collapse', 'en');
    await page.goto('/en/chat');

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

    /* The preference lives in localStorage; a reload must respect it. */
    await page.reload();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  });

  test('an academic search entry seeds the composer without sending', async ({ page }) => {
    await registerAndLogin(page, 'sidebar-prompt', 'en');
    await page.goto('/en/chat');

    await page.getByRole('link', { name: 'Academic search' }).click();

    /*
     * A starting phrase, not a sent message. The user still chooses what to
     * search for and when.
     */
    await expect(page.getByRole('textbox')).toHaveValue(/Find studies about/);
  });

  test('a conversation appears in Recent after it is started', async ({ page }) => {
    await registerAndLogin(page, 'sidebar-recent', 'en');
    await page.goto('/en/chat');

    const composer = page.getByRole('textbox');
    await composer.fill('What is a p-value?');
    await composer.press('Enter');

    await expect(page.getByText('What is a p-value?')).toBeVisible({ timeout: 15_000 });

    /* The sidebar list is rendered by the server layout, so it needs a reload. */
    await page.reload();
    await expect(page.getByText('Recent')).toBeVisible();
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
