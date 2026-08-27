import { expect, test } from '@playwright/test';

import { createProject, registerAndLogin } from './helpers';

test.describe('research projects', () => {
  test('creating a project builds the full section outline', async ({ page }) => {
    await registerAndLogin(page, 'project');
    await createProject(page);

    await page.waitForURL(/\/en\/projects\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    // The 13 wizard sections exist immediately, all empty — this is what makes
    // "come back later and continue" possible.
    await expect(page.getByRole('heading', { name: 'Research outline' })).toBeVisible();
    await expect(page.getByText('Research problem')).toBeVisible();
    await expect(page.getByText('Data analysis plan')).toBeVisible();
    await expect(page.getByText('References', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Not started').first()).toBeVisible();

    await expect(page.getByText('Master')).toBeVisible();
    // The keyword badge in the project-details card, not the generated title.
    await expect(page.getByText('active learning', { exact: true })).toBeVisible();
  });

  test('the project appears on the dashboard and reopens', async ({ page }) => {
    await registerAndLogin(page, 'reopen');
    await createProject(page);
    await page.waitForURL(/\/en\/projects\/[0-9a-f-]{36}$/);
    const projectUrl = page.url();

    await page.goto('/en/dashboard');
    await expect(page.getByRole('heading', { name: 'Recent projects' })).toBeVisible();
    await page.getByRole('link', { name: /active learning/ }).first().click();

    await expect(page).toHaveURL(projectUrl);
  });

  test('the free plan stops at one project and explains why', async ({ page }) => {
    await registerAndLogin(page, 'limit');
    await createProject(page);
    await page.waitForURL(/\/en\/projects\/[0-9a-f-]{36}$/);

    await page.goto('/en/projects/new');
    await expect(page.getByText("You've reached your plan limit")).toBeVisible();
    await expect(page.getByText('Upgrade to Pro to continue your research.')).toBeVisible();
  });

  test('the wizard opens on the selected step and can be walked', async ({ page }) => {
    await registerAndLogin(page, 'wizard');
    await createProject(page);
    await page.waitForURL(/\/en\/projects\/([0-9a-f-]{36})$/);

    await page.getByRole('link', { name: 'Open the research wizard' }).click();
    await expect(page).toHaveURL(/\/wizard\/1$/);
    await expect(page.getByText('Step 1 of 13')).toBeVisible();
    await expect(page.getByText('Select a research title first.')).toBeVisible();

    await page.getByRole('link', { name: 'Next step' }).click();
    await expect(page).toHaveURL(/\/wizard\/2$/);
    await expect(page.getByRole('heading', { name: 'Research problem' })).toBeVisible();
    // Editor on one side, assistant on the other.
    await expect(page.getByRole('heading', { name: 'Assistant' })).toBeVisible();
  });

  test('advanced tools are visibly locked on the free plan', async ({ page }) => {
    await registerAndLogin(page, 'tools');
    await page.goto('/en/tools');

    await expect(page.getByRole('heading', { name: 'AI research tools' })).toBeVisible();
    await expect(page.getByText('Academic rewriter')).toBeVisible();
    // The rewriter is free; the translator is not.
    await expect(page.getByRole('link', { name: /Academic rewriter/ })).toBeVisible();
    await expect(page.getByText('Academic translator')).toBeVisible();
    await expect(page.getByText('Pro').first()).toBeVisible();

    await page.goto('/en/tools/translator');
    await expect(page.getByText('This tool is part of Pro.')).toBeVisible();
  });

  test('one user cannot open another user\'s project', async ({ page, context }) => {
    await registerAndLogin(page, 'ownerA');
    await createProject(page);
    await page.waitForURL(/\/en\/projects\/[0-9a-f-]{36}$/);
    const victimUrl = page.url();

    const otherPage = await context.newPage();
    await otherPage.goto('/en/dashboard');
    await otherPage.getByRole('button', { name: 'Log out' }).click();
    await otherPage.waitForURL(/\/en$/);

    await registerAndLogin(otherPage, 'ownerB');
    await otherPage.goto(victimUrl);
    await expect(otherPage.getByText("We couldn't find that page.")).toBeVisible();
    await otherPage.close();
  });
});
