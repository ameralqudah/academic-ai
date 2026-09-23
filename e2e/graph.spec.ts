import { expect, test } from '@playwright/test';

import { createProject, registerAndLogin } from './helpers';

/**
 * The Research Graph API (P1-A) over HTTP. With `FF_GRAPH` off — the default —
 * the routes must not exist. With it on (set for the server under test), the
 * full flow runs: create, link, dry-run impact, acknowledged update, stale list,
 * resolve, trace.
 */
test.describe('research graph API', () => {
  test('does not exist while the flag is off, and requires a session when on', async ({ request }) => {
    const response = await request.get('/api/v1/projects/any/nodes');
    // The flag is checked before authentication, so a disabled API reveals nothing.
    expect(response.status()).toBe(process.env.FF_GRAPH === 'true' ? 401 : 404);
  });

  test('follows the feature flag', async ({ page }) => {
    await registerAndLogin(page, 'graph');
    await createProject(page);
    await page.waitForURL(/\/en\/projects\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const projectId = page.url().split('/').pop()!;
    const api = page.request;
    const base = `/api/v1/projects/${projectId}`;

    if (process.env.FF_GRAPH !== 'true') {
      expect((await api.get(`${base}/nodes`)).status()).toBe(404);
      return;
    }

    const create = async (type: string, data: Record<string, unknown>) => {
      const response = await api.post(`${base}/nodes`, { data: { type, label: type, data } });
      expect(response.status()).toBe(201);
      return (await response.json()).data as { id: string; currentVersion: number };
    };

    const construct = await create('construct', { name: 'Trust', kind: 'reflective' });
    const element = await create('model_element', { kind: 'latent' });
    const block = await create('block', { text: 'Trust is…' });

    expect((await api.post(`${base}/edges`, { data: { srcId: element.id, rel: 'represents', dstId: construct.id } })).status()).toBe(201);
    expect((await api.post(`${base}/edges`, { data: { srcId: block.id, rel: 'describes', dstId: construct.id } })).status()).toBe(201);
    expect((await api.post(`${base}/edges`, { data: { srcId: block.id, rel: 'measures', dstId: construct.id } })).status()).toBe(422);

    const change = { name: 'Trust', kind: 'formative' };
    const preview = (await (await api.post(`${base}/nodes/${construct.id}/impact`, { data: { data: change } })).json()).data;
    expect(preview.counts).toEqual({ info: 0, review: 1, invalidates: 1 });

    const refused = await api.patch(`${base}/nodes/${construct.id}`, { data: { data: change, expectedVersion: 1 } });
    expect(refused.status()).toBe(428);
    expect((await refused.json()).error.details.report.hash).toBe(preview.hash);

    const accepted = await api.patch(`${base}/nodes/${construct.id}`, {
      headers: { 'If-Match': '1' },
      data: { data: change, impactAcknowledged: preview.hash },
    });
    expect(accepted.status()).toBe(200);
    expect((await accepted.json()).data.node.currentVersion).toBe(2);

    const conflict = await api.patch(`${base}/nodes/${construct.id}`, { data: { data: { name: 'x' }, expectedVersion: 1 } });
    expect(conflict.status()).toBe(409);

    const stale = (await (await api.get(`${base}/stale`)).json()).data as { nodeId: string; severity: string; causeNodeId: string; causeVersion: number; kind: string }[];
    expect(stale.map((mark) => mark.severity).sort()).toEqual(['invalidates', 'review']);

    // Resolving must name exactly the open marks; an empty list is refused.
    const elementMarks = stale
      .filter((mark) => mark.nodeId === element.id)
      .map(({ causeNodeId, causeVersion, kind }) => ({ causeNodeId, causeVersion, kind }));
    const unnamed = await api.post(`${base}/stale/${element.id}/resolve`, { data: { resolution: 'accepted', marks: [] } });
    expect(unnamed.status()).toBe(409);
    expect((await unnamed.json()).error.details.reason).toBe('marks_changed');
    expect((await api.post(`${base}/stale/${element.id}/resolve`, { data: { resolution: 'accepted', marks: elementMarks } })).status()).toBe(200);
    expect(((await (await api.get(`${base}/stale`)).json()).data as unknown[]).length).toBe(1);

    // Provenance over HTTP: a typed-in value is manual; only the engine links values to runs.
    const typed = await create('result_value', { stat: 'beta', value: 0.3 });
    expect((await (await api.get(`${base}/nodes/${typed.id}`)).json()).data.provenance).toBe('manual');
    expect((await api.post(`${base}/nodes`, { data: { type: 'analysis_run', data: {} } })).status()).toBe(403);
    const claim = await create('claim', { text: 'β = .30' });
    expect((await api.post(`${base}/edges`, { data: { srcId: claim.id, rel: 'reports', dstId: typed.id } })).status()).toBe(201);
    const currency = (await (await api.get(`${base}/nodes/${claim.id}/currency`)).json()).data;
    expect(currency.verification).toBe('manual');

    const trace = (await (await api.get(`${base}/nodes/${block.id}/trace?direction=up`)).json()).data;
    expect(trace.nodes.map((node: { id: string }) => node.id)).toContain(construct.id);

    const versions = (await (await api.get(`${base}/nodes/${construct.id}/versions`)).json()).data;
    expect(versions.map((version: { version: number }) => version.version)).toEqual([2, 1]);

    // Another project's id in the path answers like a missing one.
    expect((await api.get(`/api/v1/projects/00000000-0000-0000-0000-000000000000/nodes`)).status()).toBe(404);
  });
});
