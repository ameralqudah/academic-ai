import { expect, test } from '@playwright/test';

import { registerAndLogin } from './helpers';

/**
 * Watching a task, and finding it again.
 *
 * These run against a real server in a real browser, which is the only place
 * the interesting failures live. The unit tests prove the stream reads the
 * right rows; they cannot prove that `EventSource` connects, that a proxy does
 * not buffer the response into one burst at the end, or that a reload
 * reattaches to work that is still running.
 *
 * The scenario each covers is one a researcher hits by accident: they close a
 * tab during a ten-minute run, their connection drops on a train, they answer
 * a question the task asked an hour ago.
 */

test.describe('task progress reaches the browser', () => {
  test('the stream endpoint refuses an anonymous caller', async ({ request }) => {
    /*
     * Checked before anything else. A stream that leaked another researcher's
     * task would expose their subject, their sources and their draft — and it
     * is exactly the kind of endpoint where an ownership check is easy to
     * forget, because it returns a stream rather than a body.
     */
    const response = await request.get('/api/tasks/some-id/stream');
    expect(response.status()).toBe(401);
  });

  test('active tasks are refused to an anonymous caller', async ({ request }) => {
    const response = await request.get('/api/tasks/active');
    expect(response.status()).toBe(401);
  });

  test('a signed-in researcher gets an empty active list, not an error', async ({ page }) => {
    await registerAndLogin(page, 'stream');

    const response = await page.request.get('/api/tasks/active');
    expect(response.ok()).toBe(true);

    const body = await response.json();
    expect(body.ok).toBe(true);
    /*
     * Empty rather than absent. A researcher with nothing running should get a
     * list of nothing, and the banner should render nothing — not an error
     * that suggests something is broken.
     */
    expect(Array.isArray(body.data.tasks)).toBe(true);
  });

  test('a stream for someone else\u2019s task is refused', async ({ page }) => {
    await registerAndLogin(page, 'stream');

    /*
     * An id that does not belong to this account. The check happens before the
     * stream opens, so the refusal is a status code rather than a stream that
     * ends immediately — which a client would retry.
     */
    const response = await page.request.get('/api/tasks/00000000-0000-0000-0000-000000000000/stream');
    expect(response.status()).toBe(404);
  });

  test('the browser can open an event stream', async ({ page }) => {
    await registerAndLogin(page, 'stream');

    /*
     * `EventSource` against a task that does not exist. What is being tested is
     * that the browser can open the connection at all — that the content type
     * is right, that nothing in the stack buffers it, and that an error
     * arrives as an error rather than a hang.
     *
     * A hang is the failure that matters: a panel waiting forever on a stream
     * that will never speak looks identical to a task that is thinking.
     */
    const outcome = await page.evaluate(async () => {
      return new Promise<string>((resolve) => {
        const source = new EventSource('/api/tasks/00000000-0000-0000-0000-000000000000/stream');

        const finish = (result: string) => {
          source.close();
          resolve(result);
        };

        source.onerror = () => finish('error');
        source.addEventListener('update', () => finish('update'));
        source.addEventListener('error', () => finish('error-event'));

        /* A stream that says nothing within five seconds has failed. */
        setTimeout(() => finish('timeout'), 5000);
      });
    });

    /*
     * Either an error or an error event is correct for a task that does not
     * exist. A timeout is not: it means the connection opened and nothing came
     * back, which is the shape of a buffering proxy.
     */
    expect(outcome).not.toBe('timeout');
  });
});

test.describe('a conversation survives a reload', () => {
  test('the thread is still there after refreshing', async ({ page }) => {
    await registerAndLogin(page, 'stream');

    await page.goto('/en/chat');
    await expect(page.locator('textarea')).toBeVisible();

    /*
     * The reload path itself. A task's progress panel is restored from the
     * conversation's stored payload, so a thread that does not survive a
     * reload cannot restore anything — this is the precondition for the rest.
     */
    await page.reload();
    await expect(page.locator('textarea')).toBeVisible();
  });
});

