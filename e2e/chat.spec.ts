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

  test('an attached file is still there when the conversation is reopened', async ({ page }) => {
    await registerAndLogin(page, 'chat-file-kept', 'en');
    await page.goto('/en/chat');

    const csv = ['score,gender', ...Array.from({ length: 30 }, (_, i) => `${3 + (i % 3)},${i % 2 ? 'f' : 'm'}`)].join('\n');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'kept-survey.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await expect(page.getByText('kept-survey.csv', { exact: true })).toBeVisible({ timeout: 20_000 });

    /* The answer itself does not matter here — only that the turn reached the server. */
    await page.route('**/api/chat', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    const composer = page.getByRole('textbox');
    await composer.fill('Describe this data');
    await composer.press('Enter');
    await page.waitForURL(/[?&]c=/, { timeout: 20_000 });
    await page.waitForResponse('**/api/chat', { timeout: 30_000 }).catch(() => undefined);

    /* Reopened, the way the sidebar opens it: the file was held in the browser and is not any more. */
    await page.goto(page.url());
    await expect(page.getByText('kept-survey.csv', { exact: true })).toBeVisible({ timeout: 20_000 });
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

  test('keeps the research shortcuts one click away, behind More', async ({ page }) => {
    await registerAndLogin(page, 'sidebar-more', 'en');
    await page.goto('/en/chat');

    /*
     * Web search and deep research were once unbuilt and shown as plain,
     * disabled text. They are built now, and they are links like the rest —
     * folded behind "More" so the sidebar's first screen belongs to the places a
     * researcher returns to and to their conversations.
     */
    const sidebar = page.locator('aside');
    await expect(sidebar.getByRole('link', { name: 'Web search' })).toHaveCount(0);

    await sidebar.getByRole('button', { name: 'More' }).click();

    await expect(sidebar.getByRole('link', { name: 'Web search' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Deep research' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Literature review' })).toBeVisible();
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

  test('a conversation appears under Today after it is started', async ({ page }) => {
    await registerAndLogin(page, 'sidebar-recent', 'en');
    await page.goto('/en/chat');

    const composer = page.getByRole('textbox');
    await composer.fill('What is a p-value?');
    await composer.press('Enter');

    await expect(page.getByText('What is a p-value?')).toBeVisible({ timeout: 15_000 });

    /* The sidebar list is rendered by the server layout, so it needs a reload. */
    await page.reload();
    /* Conversations are grouped by date now; a new one lands under Today. */
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  });

  test('a conversation can be pinned and unpinned', async ({ page }) => {
    await registerAndLogin(page, 'sidebar-pin', 'en');
    await page.goto('/en/chat');

    const composer = page.getByRole('textbox');
    await composer.fill('What is a confidence interval?');
    await composer.press('Enter');
    await expect(page.getByText('What is a confidence interval?').first()).toBeVisible({
      timeout: 15_000,
    });

    await page.reload();

    const sidebar = page.locator('aside');
    const row = sidebar.getByRole('link', { name: /confidence interval/i });
    await row.hover();
    /* The actions sit behind one button, so that they exist on a touch screen too. */
    await sidebar.getByRole('button', { name: 'Conversation options' }).click();
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();

    /* Moved, not copied: it is under Pinned and no longer under Today. */
    await expect(sidebar.getByRole('heading', { name: 'Pinned' })).toBeVisible();
    await expect(sidebar.getByRole('heading', { name: 'Today' })).toHaveCount(0);

    /* It survives a reload, which is the difference between pinned and highlighted. */
    await page.reload();
    await expect(sidebar.getByRole('heading', { name: 'Pinned' })).toBeVisible();

    await sidebar.getByRole('link', { name: /confidence interval/i }).hover();
    await sidebar.getByRole('button', { name: 'Conversation options' }).click();
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click();
    await expect(sidebar.getByRole('heading', { name: 'Pinned' })).toHaveCount(0);
    await expect(sidebar.getByRole('heading', { name: 'Today' })).toBeVisible();
  });
});

test.describe('a direct answer, as it is written', () => {
  /*
   * The stream is supplied by the test, because there is no model behind a test
   * run. What is being checked is the reader: that it assembles the pieces,
   * shows why it is waiting, swaps a refusal for the task that replaced it, and
   * reports a failure that arrives after the first byte.
   */
  const frames = (events: object[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

  const answerWith = async (page: import('@playwright/test').Page, events: object[]) => {
    await page.route('**/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body: frames(events),
      });
    });
  };

  test('the pieces become one answer', async ({ page }) => {
    await registerAndLogin(page, 'stream-text', 'en');
    await page.goto('/en/chat');

    await answerWith(page, [
      { type: 'notice', kind: 'failover' },
      { type: 'delta', text: 'Pearson measures ' },
      { type: 'delta', text: 'linear association.' },
      { type: 'done' },
    ]);

    const composer = page.getByRole('textbox');
    await composer.fill('Pearson or Spearman?');
    await composer.press('Enter');

    await expect(page.getByText('Pearson measures linear association.')).toBeVisible({ timeout: 15_000 });
    /* Finished: the busy line is gone and the answer can be copied. */
    await expect(page.getByText('The model is busy')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy' }).last()).toBeVisible();
  });

  test('a refusal is replaced by the task that took over', async ({ page }) => {
    await registerAndLogin(page, 'stream-task', 'en');
    await page.goto('/en/chat');

    await answerWith(page, [
      { type: 'delta', text: 'I cannot produce a file here.' },
      { type: 'task', task: { id: 'task-that-does-not-exist', status: 'QUEUED' }, restatement: 'Writing your chapter.' },
    ]);

    const composer = page.getByRole('textbox');
    await composer.fill('Write chapter one as a Word file');
    await composer.press('Enter');

    await expect(page.getByText('Writing your chapter.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('I cannot produce a file here.')).toHaveCount(0);
  });

  test('a finished task shows what it wrote, not the request handed back', async ({ page }) => {
    await registerAndLogin(page, 'task-result', 'en');
    await page.goto('/en/chat');

    const request = 'Act as an academic researcher and write a complete paper on hospital supply chains';
    const step = (ordinal: number, capability: string, label: string, legacy: object, warnings: object[] = []) => ({
      id: `s${ordinal}`,
      ordinal,
      capability,
      label,
      status: 'COMPLETED',
      attempts: 1,
      errorReasonKey: null,
      dynamic: false,
      durationMs: 1200,
      artifactIds: [],
      output: { legacy, observation: { warnings } },
    });

    /*
     * Refused outright, which is what makes EventSource give up and the panel
     * fall back to the poll mocked below. An aborted connection is retried.
     */
    await page.route('**/api/tasks/finished-paper/stream', (route) => route.fulfill({ status: 404 }));
    await page.route('**/api/tasks/finished-paper', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            task: {
              id: 'finished-paper',
              status: 'COMPLETED',
              request,
              pendingQuestion: null,
              pauseReasonKey: null,
              errorReasonKey: null,
              context: {},
            },
            steps: [
              step(0, 'document.write', 'Write the paper', { text: '## Abstract\n\nSupply chains decide what is on the shelf.' }),
              step(1, 'quality.check', 'Quality check', { warnings: 1 }, [
                { code: 'format.emptySection', message: 'format.emptySection', metadata: { count: 1 } },
              ]),
            ],
          },
        }),
      }),
    );

    await answerWith(page, [
      { type: 'task', task: { id: 'finished-paper', status: 'QUEUED' }, restatement: request.slice(0, 40) },
    ]);

    const composer = page.getByRole('textbox');
    await composer.fill(request);
    await composer.press('Enter');

    await expect(page.getByRole('heading', { name: 'Abstract' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Supply chains decide what is on the shelf.')).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Result' }).getByRole('button', { name: 'Copy' }),
    ).toBeVisible();

    /* The code is for the replanner; the researcher reads a sentence. */
    await expect(page.getByText('format.emptySection')).toHaveCount(0);
    await expect(page.getByText('One heading has no text under it.')).toBeVisible();

    /* Their own words appear once — in their message — not again under the panel. */
    await expect(page.getByText(request.slice(0, 40), { exact: true })).toHaveCount(0);
  });

  test('an Arabic result reads right to left in the English interface, under what was understood', async ({
    page,
  }) => {
    await registerAndLogin(page, 'task-direction', 'en');
    await page.goto('/en/chat');

    await page.route('**/api/tasks/arabic-answer/stream', (route) => route.fulfill({ status: 404 }));
    await page.route('**/api/tasks/arabic-answer', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            task: {
              id: 'arabic-answer',
              status: 'COMPLETED',
              request: 'اعطيني اياه ملف وورد',
              pendingQuestion: null,
              pauseReasonKey: null,
              errorReasonKey: null,
              context: {},
            },
            steps: [
              {
                id: 's0',
                ordinal: 0,
                capability: 'general.answer',
                label: 'Answering',
                status: 'COMPLETED',
                attempts: 1,
                errorReasonKey: null,
                dynamic: false,
                durationMs: 900,
                artifactIds: [],
                output: { legacy: { text: 'الملف بصيغة Word جاهز للتنزيل.' } },
              },
            ],
          },
        }),
      }),
    );

    await answerWith(page, [
      { type: 'task', task: { id: 'arabic-answer', status: 'QUEUED' }, restatement: 'تريد البحث ملف وورد.' },
    ]);

    const composer = page.getByRole('textbox');
    await composer.fill('اعطيني اياه ملف وورد');
    await composer.press('Enter');

    const answer = page.getByText('الملف بصيغة Word جاهز للتنزيل.');
    await expect(answer).toBeVisible({ timeout: 20_000 });

    /* The sentence with "Word" in the middle of it is the one that came out scrambled. */
    expect(await answer.evaluate((node) => getComputedStyle(node).direction)).toBe('rtl');
    expect(await page.locator('html').getAttribute('dir')).toBe('ltr');

    /* What was understood comes first, then the panel, then the work. */
    const understood = await page.getByText('تريد البحث ملف وورد.').boundingBox();
    const panel = await page.getByText('Completed').boundingBox();
    expect(understood!.y).toBeLessThan(panel!.y);
    expect(panel!.y).toBeLessThan((await answer.boundingBox())!.y);
  });

  test('a drawn model is shown in the thread and downloads as PNG', async ({ page }) => {
    await registerAndLogin(page, 'task-diagram', 'en');
    await page.goto('/en/chat');

    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">' +
      '<rect width="100%" height="100%" fill="#fff"/><ellipse cx="100" cy="100" rx="80" ry="40" fill="#eef5f2" stroke="#0b4a3b"/>' +
      '<text x="100" y="105" text-anchor="middle">Digital Transformation</text></svg>';

    await page.route('**/api/artifacts/figure-svg', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: svg }),
    );
    await page.route('**/api/tasks/drawn-model/stream', (route) => route.fulfill({ status: 404 }));
    await page.route('**/api/tasks/drawn-model', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            task: {
              id: 'drawn-model',
              status: 'COMPLETED',
              request: 'draw the research model',
              pendingQuestion: null,
              pauseReasonKey: null,
              errorReasonKey: null,
              context: {},
            },
            steps: [
              {
                id: 's0',
                ordinal: 0,
                capability: 'diagram.draw',
                label: 'Drawing the model',
                status: 'COMPLETED',
                attempts: 1,
                errorReasonKey: null,
                dynamic: false,
                durationMs: 1800,
                artifactIds: ['figure-svg', 'figure-pptx'],
                output: {
                  outputs: [
                    { type: 'artifact.v1', data: { artifactId: 'figure-svg', filename: 'Research Model.svg', kind: 'svg' } },
                    { type: 'artifact.v1', data: { artifactId: 'figure-pptx', filename: 'Research Model.pptx', kind: 'pptx' } },
                  ],
                  legacy: { filename: 'Research Model.pptx', kind: 'pptx' },
                },
              },
            ],
          },
        }),
      }),
    );

    await answerWith(page, [{ type: 'task', task: { id: 'drawn-model', status: 'QUEUED' } }]);

    const composer = page.getByRole('textbox');
    await composer.fill('draw the research model');
    await composer.press('Enter');

    /* The figure itself, not a file row: it is the answer. */
    const figure = page.getByRole('img', { name: 'Research Model.svg' });
    await expect(figure).toBeVisible({ timeout: 20_000 });
    expect(await figure.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    /* Each file under its own name — the step made two, and both were once listed as the second. */
    await expect(page.getByText('Research Model.pptx')).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'PNG image' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('Research Model.png');

    const path = await file.path();
    const { readFileSync } = await import('node:fs');
    const bytes = readFileSync(path);
    /* A PNG signature, drawn at three times the figure's size for print. */
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(bytes.readUInt32BE(16)).toBe(1200);
  });

  test('an abandoned question can be dismissed from the top of the chat', async ({ page }) => {
    await registerAndLogin(page, 'dismiss-task', 'en');

    let cancelled = false;
    await page.route('**/api/tasks/active', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            tasks: [
              {
                id: 'abandoned',
                status: 'WAITING_FOR_INPUT',
                request: 'Suggest research titles',
                conversationId: 'another-conversation',
                pendingQuestion: 'Which field?',
                progress: { total: 2, completed: 0, current: null },
              },
            ],
          },
        }),
      }),
    );
    await page.route('**/api/tasks/abandoned', async (route) => {
      cancelled = route.request().method() === 'DELETE';
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { cancelled: true } }) });
    });

    await page.goto('/en/chat');
    await expect(page.getByText('Suggest research titles')).toBeVisible();

    await page.getByRole('button', { name: 'Dismiss this task' }).click();
    await expect(page.getByText('Suggest research titles')).toHaveCount(0);
    expect(cancelled).toBe(true);
  });

  test('a failure after the first byte is still reported', async ({ page }) => {
    await registerAndLogin(page, 'stream-error', 'en');
    await page.goto('/en/chat');

    await answerWith(page, [
      { type: 'error', code: 'AI_UNAVAILABLE', message: 'The AI provider quota has been used up.', messageAr: 'انتهت الحصة' },
    ]);

    const composer = page.getByRole('textbox');
    await composer.fill('Anything');
    await composer.press('Enter');

    await expect(page.getByText('The AI provider quota has been used up.')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('switching language', () => {
  test('moves between locales and keeps the page', async ({ page }) => {
    await registerAndLogin(page, 'chat-locale', 'en');
    await page.goto('/en/chat');

    /* Language sits in the account menu, which closes when the page changes locale. */
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('button', { name: /العربية|Arabic/i }).click();

    await expect(page).toHaveURL(/\/ar\/chat/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    /* And back, so the switch is not one-way. */
    await page.getByRole('button', { name: 'قائمة الحساب' }).click();
    await page.getByRole('button', { name: /English|الإنجليزية/i }).click();
    await expect(page).toHaveURL(/\/en\/chat/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });
});
