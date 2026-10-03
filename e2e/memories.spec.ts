import { expect, test } from '@playwright/test';

import { createProject, registerAndLogin } from './helpers';

/**
 * Memories (P1-E, PR #5) over HTTP and in the browser. With `FF_CONTEXT_V2`
 * off — the default — neither the API nor the pages exist. With it on, a
 * signed-in user manages their own memories, a stranger reaches nothing of
 * theirs, bodies are strict, and the write limit holds.
 */
const enabled = process.env.FF_CONTEXT_V2 === 'true';

test.describe('memories', () => {
  test('the API does not exist while the flag is off, and requires a session when on', async ({ request }) => {
    // The flag is checked before authentication, so a disabled API reveals nothing.
    expect((await request.get('/api/v1/me/memories')).status()).toBe(enabled ? 401 : 404);
    expect((await request.get('/api/v1/projects/any/memories')).status()).toBe(enabled ? 401 : 404);
    expect((await request.post('/api/v1/me/memories', { data: { kind: 'fact', content: 'x' } })).status()).toBe(enabled ? 401 : 404);
  });

  test('your own memories over HTTP, invisible to a stranger', async ({ page, browser }) => {
    await registerAndLogin(page, 'mem-owner');
    await createProject(page);
    await page.waitForURL(/\/en\/projects\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const projectId = page.url().split('/').pop()!;
    const api = page.request;

    if (!enabled) {
      expect((await api.get('/api/v1/me/memories')).status()).toBe(404);
      expect((await api.get(`/api/v1/projects/${projectId}/memories`)).status()).toBe(404);
      expect((await page.goto(`/en/projects/${projectId}/memories`))!.status()).toBe(404);
      await page.goto('/en/settings');
      await expect(page.getByTestId('memories-panel')).toHaveCount(0);
      return;
    }

    const created = await api.post('/api/v1/me/memories', { data: { kind: 'preference', content: 'Cite in APA 7th edition.' } });
    expect(created.status()).toBe(201);
    const memory = (await created.json()).data.memory as { id: string; status: string; source: string; editable: boolean };
    expect(memory).toMatchObject({ status: 'confirmed', source: 'user', editable: true });

    // Strict bodies: unknown fields, a status, and empty content are refused.
    expect((await api.post('/api/v1/me/memories', { data: { kind: 'fact', content: 'x', extra: 1 } })).status()).toBe(422);
    expect((await api.post('/api/v1/me/memories', { data: { kind: 'fact', content: 'x', status: 'confirmed' } })).status()).toBe(422);
    expect((await api.post('/api/v1/me/memories', { data: { kind: 'fact', content: '   ' } })).status()).toBe(422);
    expect((await api.patch(`/api/v1/me/memories/${memory.id}`, { data: { status: 'confirmed' } })).status()).toBe(422);

    const listed = (await (await api.get('/api/v1/me/memories')).json()).data.memories as { id: string }[];
    expect(listed.map((entry) => entry.id)).toContain(memory.id);

    const edited = await api.patch(`/api/v1/me/memories/${memory.id}`, { data: { content: 'Cite in APA 7.', pinned: true } });
    expect(edited.status()).toBe(200);
    expect((await edited.json()).data.memory).toMatchObject({ content: 'Cite in APA 7.', pinned: true });

    const archived = await api.post(`/api/v1/me/memories/${memory.id}/archive`);
    expect((await archived.json()).data.memory.status).toBe('archived');
    expect(((await (await api.get('/api/v1/me/memories?status=confirmed')).json()).data.memories as { id: string }[]).map((m) => m.id)).not.toContain(memory.id);
    const restored = await api.post(`/api/v1/me/memories/${memory.id}/confirm`);
    expect((await restored.json()).data.memory.status).toBe('confirmed');

    const project = await api.post(`/api/v1/projects/${projectId}/memories`, { data: { kind: 'decision', content: 'Sample: 120 teachers.' } });
    expect(project.status()).toBe(201);
    const projectMemory = (await project.json()).data.memory as { id: string };
    // A project memory is not one of yours through /me.
    expect((await api.patch(`/api/v1/me/memories/${projectMemory.id}`, { data: { pinned: true } })).status()).toBe(404);

    // A stranger: none of it exists for them.
    const context = await browser.newContext();
    const strangerPage = await context.newPage();
    await registerAndLogin(strangerPage, 'mem-stranger');
    const stranger = strangerPage.request;
    expect(((await (await stranger.get('/api/v1/me/memories')).json()).data.memories as unknown[]).length).toBe(0);
    expect((await stranger.patch(`/api/v1/me/memories/${memory.id}`, { data: { content: 'mine now' } })).status()).toBe(404);
    expect((await stranger.post(`/api/v1/me/memories/${memory.id}/archive`)).status()).toBe(404);
    expect((await stranger.delete(`/api/v1/me/memories/${memory.id}`)).status()).toBe(404);
    expect((await stranger.get(`/api/v1/projects/${projectId}/memories`)).status()).toBe(404);
    expect((await stranger.post(`/api/v1/projects/${projectId}/memories`, { data: { kind: 'fact', content: 'x' } })).status()).toBe(404);
    expect((await stranger.delete(`/api/v1/projects/${projectId}/memories/${projectMemory.id}`)).status()).toBe(404);
    expect((await strangerPage.goto(`/en/projects/${projectId}/memories`))!.status()).toBe(404);
    await context.close();

    // Still the owner's, unchanged.
    expect(((await (await api.get('/api/v1/me/memories')).json()).data.memories as { id: string; content: string }[]).find((m) => m.id === memory.id)?.content).toBe('Cite in APA 7.');

    await page.goto(`/en/projects/${projectId}/memories`);
    await expect(page.getByTestId('memories-panel')).toContainText('Sample: 120 teachers.');

    expect((await api.delete(`/api/v1/me/memories/${memory.id}`)).status()).toBe(200);
    expect((await api.delete(`/api/v1/me/memories/${memory.id}`)).status()).toBe(404);
  });

  test('settings: add, archive and restore a memory', async ({ page }) => {
    test.skip(!enabled, 'FF_CONTEXT_V2 is off');
    await registerAndLogin(page, 'mem-ui');
    await page.goto('/en/settings');
    const panel = page.getByTestId('memories-panel');
    await expect(panel).toContainText('What Academic AI remembers');

    await panel.getByLabel('What should be remembered?').fill('Write in a formal register.');
    await panel.getByRole('button', { name: 'Add a memory' }).click();
    const item = panel.locator('li', { hasText: 'Write in a formal register.' });
    await expect(item).toHaveAttribute('data-memory-status', 'confirmed');

    await item.getByRole('button', { name: 'Archive' }).click();
    await expect(item).toHaveAttribute('data-memory-status', 'archived');
    await item.getByRole('button', { name: 'Restore' }).click();
    await expect(item).toHaveAttribute('data-memory-status', 'confirmed');

    // The server kept it: a reload shows it.
    await page.reload();
    await expect(page.getByTestId('memories-panel').locator('li', { hasText: 'Write in a formal register.' })).toHaveAttribute('data-memory-status', 'confirmed');
  });

  test('Arabic: the panel reads right to left', async ({ page }) => {
    test.skip(!enabled, 'FF_CONTEXT_V2 is off');
    await registerAndLogin(page, 'mem-ar', 'ar');
    await page.goto('/ar/settings');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('memories-panel')).toContainText('ما يتذكّره Academic AI');
  });

  // Last: it spends this address's write budget.
  test('the write limit holds', async ({ page }) => {
    test.skip(!enabled, 'FF_CONTEXT_V2 is off');
    await registerAndLogin(page, 'mem-limit');
    const statuses: number[] = [];
    for (let i = 0; i < 70; i += 1) {
      const response = await page.request.post('/api/v1/me/memories', { data: { kind: 'fact', content: '' } });
      statuses.push(response.status());
      if (response.status() === 429) break;
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status !== 429 && status !== 422)).toEqual([]);
  });
});
