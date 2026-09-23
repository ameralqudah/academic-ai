import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { createProject, registerAndLogin } from './helpers';

/**
 * The deterministic analysis workbench (P1-C), in the browser. With `FF_GRAPH`
 * off the page and its API do not exist. With it on: upload → version →
 * quality report → specification → engine run → verified result → manuscript
 * claim rendered from the stored value → provenance.
 */
test.describe('analysis workbench', () => {
  test('runs a verified analysis and inserts it into the manuscript', async ({ page }) => {
    test.setTimeout(120_000);
    await registerAndLogin(page, 'stats');
    await createProject(page);
    await page.waitForURL(/\/en\/projects\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const projectId = page.url().split('/').pop()!;
    const api = page.request;

    if (process.env.FF_GRAPH !== 'true') {
      expect((await api.get(`/api/v1/projects/${projectId}/datasets`)).status()).toBe(404);
      const response = await page.goto(`/en/projects/${projectId}/analysis`);
      expect(response?.status()).toBe(404);
      return;
    }

    const upload = await api.post('/api/datasets', {
      multipart: {
        file: { name: 'survey.csv', mimeType: 'text/csv', buffer: readFileSync('evals/fixtures/datasets/engine_survey.csv') },
        projectId,
      },
    });
    expect(upload.status()).toBe(201);
    const datasetId = (await upload.json()).data.dataset.id as string;

    await page.goto(`/en/projects/${projectId}/analysis`);
    await expect(page.getByRole('heading', { name: 'Analysis workbench' })).toBeVisible();
    await page.getByLabel('Dataset').selectOption(datasetId);
    await expect(page.getByTestId('stats-quality')).toContainText('missing', { timeout: 15_000 });

    await page.getByLabel('Analysis').selectOption('regression');
    await page.getByLabel('Outcome').fill('y');
    await page.getByLabel('Predictors').fill('x, m, bin');
    await page.getByTestId('stats-run').click();

    const result = page.getByTestId('stats-result');
    await expect(result.getByText('Verified by the engine')).toBeVisible({ timeout: 30_000 });
    await expect(result.getByText('Regression coefficients')).toBeVisible();

    await result.getByText(/All \d+ values/).click();
    await page.getByTestId('stats-cite-coef:x').click();
    await expect(page.getByTestId('stats-claim')).toContainText('b = ');

    await result.getByRole('button', { name: 'Where did these numbers come from?' }).click();
    await expect(page.getByTestId('stats-provenance')).toContainText('academic-ai-ts-core');
    await expect(page.getByTestId('stats-provenance')).toContainText('"operation": "import"');

    /* Over the API: a typed number is refused, the stored value is not. */
    const runs = (await (await api.get(`/api/v1/projects/${projectId}/analyses/runs`)).json()).data.runs as { id: string }[];
    const typed = await api.post(`/api/v1/projects/${projectId}/analyses/runs/${runs[0]!.id}/claims`, { data: { keys: ['coef:x'], text: 'x predicts y (b = 0.99).' } });
    expect(typed.status()).toBe(422);
    expect((await typed.json()).error.details.reason).toBe('untraced_statistics');
  });
});
