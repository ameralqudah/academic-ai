import { expect, test } from '@playwright/test';

import { registerAndLogin } from './helpers';

/**
 * WS4 PR #4: limits and idempotency, against the running server.
 *
 * The global write limit is the environment's `RATE_LIMIT_MAX_REQUESTS` per
 * `RATE_LIMIT_WINDOW_SECONDS` (60 per 60 s by default), per signed-in user,
 * for every write whose route names no limit of its own.
 */

test.describe('limits and idempotency', () => {
  test('a write route with no limit of its own is limited per user; reads are not', async ({ page }) => {
    await registerAndLogin(page, 'limits');

    let refusedAt = 0;
    let retryAfter: string | undefined;
    for (let attempt = 1; attempt <= 65; attempt += 1) {
      const response = await page.request.patch('/api/settings', { data: { theme: 'LIGHT' } });
      if (response.status() === 429) {
        refusedAt = attempt;
        retryAfter = response.headers()['retry-after'];
        break;
      }
      expect(response.ok()).toBe(true);
    }
    /* Sixty allowed by default; the 61st refused (a little earlier if the sign-in flow itself wrote). */
    expect(refusedAt).toBeGreaterThan(50);
    expect(refusedAt).toBeLessThanOrEqual(61);
    expect(Number(retryAfter)).toBeGreaterThan(0);

    /* A read route with no limit of its own (the same route) still answers after the write bucket is spent. */
    for (let read = 0; read < 70; read += 1) {
      expect((await page.request.get('/api/settings')).ok()).toBe(true);
    }
  });

  test('an artifact request retried with the same Idempotency-Key returns the first artifact', async ({ page }) => {
    await registerAndLogin(page, 'artifact-key');
    const body = { kind: 'md', filename: 'notes.md', title: 'Notes', sections: [{ heading: 'One', paragraphs: ['A paragraph of text.'] }] };
    const key = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const first = await page.request.post('/api/artifacts', { data: body, headers: { 'Idempotency-Key': key } });
    expect(first.ok()).toBe(true);
    const second = await page.request.post('/api/artifacts', { data: body, headers: { 'Idempotency-Key': key } });
    expect(second.ok()).toBe(true);
    const firstId = (await first.json()).data.artifact.id;
    expect((await second.json()).data.artifact.id).toBe(firstId);

    const reused = await page.request.post('/api/artifacts', { data: { ...body, filename: 'other.md' }, headers: { 'Idempotency-Key': key } });
    expect(reused.status()).toBe(409);

    /* Without a key, the same request with the same bytes moments later is the same artifact too. */
    const plain = await page.request.post('/api/artifacts', { data: { ...body, filename: 'plain.md' } });
    const again = await page.request.post('/api/artifacts', { data: { ...body, filename: 'plain.md' } });
    expect((await again.json()).data.artifact.id).toBe((await plain.json()).data.artifact.id);
  });
});
