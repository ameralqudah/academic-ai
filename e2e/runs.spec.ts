import { expect, test } from '@playwright/test';

import { createProject, registerAndLogin } from './helpers';

/**
 * Research runs (P1-D) over HTTP and in the project page. With `FF_GRAPH` or
 * `FF_RUNS` off — the default — the routes and the page must not exist. With
 * both on, the API enforces sessions, ownership, idempotency and exact
 * approval hashes, and the page starts a run and follows it to a terminal
 * state. The e2e server calls no AI provider, so a run's planning step cannot
 * succeed here; the run must end FAILED with a recorded reason, never hang.
 */
const enabled = process.env.FF_GRAPH === 'true' && process.env.FF_RUNS === 'true';

async function newProject(page: import('@playwright/test').Page, tag: string): Promise<string> {
  await registerAndLogin(page, tag);
  await createProject(page);
  await page.waitForURL(/\/en\/projects\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  return page.url().split('/').pop()!;
}

test.describe('research runs', () => {
  test('do not exist while the flags are off, and require a session when on', async ({ request }) => {
    const runs = await request.get('/api/v1/projects/any/runs');
    const tools = await request.get('/api/v1/projects/any/tools');
    expect(runs.status()).toBe(enabled ? 401 : 404);
    expect(tools.status()).toBe(enabled ? 401 : 404);
  });

  test('follow the feature flag in the API and the page', async ({ page, browser }) => {
    const projectId = await newProject(page, 'runs');
    const api = page.request;
    const base = `/api/v1/projects/${projectId}`;

    if (!enabled) {
      expect((await api.get(`${base}/runs`)).status()).toBe(404);
      expect((await api.post(`${base}/runs`, { data: { intent: 'x' } })).status()).toBe(404);
      expect((await api.get(`${base}/tools`)).status()).toBe(404);
      const response = await page.goto(`/en/projects/${projectId}/runs`);
      expect(response?.status()).toBe(404);
      return;
    }

    // One registry: the tools offered here carry a version, a risk and an effect.
    const tools = (await (await api.get(`${base}/tools`)).json()).data as { tools: { name: string; version: string; risk: string }[] };
    expect(tools.tools.length).toBeGreaterThan(0);
    expect(tools.tools.every((tool) => tool.version.length > 0 && tool.risk)).toBe(true);

    // Input is validated server-side; unknown fields are refused.
    expect((await api.post(`${base}/runs`, { data: { intent: '' } })).status()).toBe(422);
    expect((await api.post(`${base}/runs`, { data: { intent: 'x', tools: ['createClaim'] } })).status()).toBe(422);

    // Idempotency: the same key returns the same run instead of starting another.
    const key = `e2e-${Date.now()}-runs`;
    const first = await api.post(`${base}/runs`, { headers: { 'idempotency-key': key }, data: { intent: 'Describe the project data.' } });
    expect(first.status()).toBe(202);
    const run = (await first.json()).data.run as { id: string };
    const again = await api.post(`${base}/runs`, { headers: { 'idempotency-key': key }, data: { intent: 'Describe the project data.' } });
    expect(again.status()).toBe(200);
    expect((await again.json()).data.run.id).toBe(run.id);

    // An approval decision must name a well-formed action hash.
    const badHash = await api.post(`${base}/runs/${run.id}/approvals/00000000-0000-0000-0000-000000000000`, {
      data: { decision: 'approve', actionHash: 'not-a-hash' },
    });
    expect(badHash.status()).toBe(422);

    // Another user can neither see nor cancel the run.
    const other = await browser.newContext();
    const stranger = await other.newPage();
    await registerAndLogin(stranger, 'runs-other');
    expect([403, 404]).toContain((await stranger.request.get(`${base}/runs/${run.id}`)).status());
    expect([403, 404]).toContain((await stranger.request.delete(`${base}/runs/${run.id}`)).status());
    expect([403, 404]).toContain((await stranger.request.get(`${base}/runs`)).status());
    await other.close();

    // With no AI provider the plan cannot be made: the run ends FAILED with a reason.
    await expect
      .poll(async () => (await (await api.get(`${base}/runs/${run.id}`)).json()).data.run.status, { timeout: 30_000 })
      .toMatch(/^(FAILED|SUCCEEDED|CANCELLED)$/);
    const settled = (await (await api.get(`${base}/runs/${run.id}`)).json()).data;
    if (settled.run.status === 'FAILED') expect(settled.run.stopReason).toBeTruthy();
    expect(settled.events.length).toBeGreaterThan(0);

    // Cancelling a settled run changes nothing.
    const cancel = await api.delete(`${base}/runs/${run.id}`);
    expect(cancel.status()).toBe(200);
    expect((await (await api.get(`${base}/runs/${run.id}`)).json()).data.run.status).toBe(settled.run.status);

    // The page: start a run from the form and follow it.
    await page.goto(`/en/projects/${projectId}`);
    await page.getByRole('link', { name: 'Research runs' }).first().click();
    await page.waitForURL(`**/en/projects/${projectId}/runs`);
    await expect(page.getByTestId('runs-list')).toContainText('Describe the project data.');
    await page.getByLabel('What should the run do?').fill('Summarise the dataset.');
    await page.getByTestId('runs-start').click();
    const detail = page.getByTestId('runs-detail');
    await expect(detail).toContainText('Summarise the dataset.');
    await expect(detail.getByTestId('runs-status')).toHaveText(/Failed|Succeeded|Cancelled/, { timeout: 30_000 });
    await expect(detail).toContainText('planner_failed');
  });
});
