import { z } from 'zod';

import { agentStream } from '@/agents/orchestrator';
import { availableModes, MODE_KEYS, MODES } from '@/agents/modes';
import { availableCapabilities, plannedCapabilities } from '@/agents/registry';
import { ok, withApi } from '@/server/http/api';
import { modelAccessFor, resolveRequestedModel } from '@/server/services/model-access.service';

const agentSchema = z.object({
  message: z.string().min(1).max(4000),
  locale: z.enum(['ar', 'en']).default('ar'),
  datasetId: z.string().optional(),
  projectId: z.string().optional(),
  conversationId: z.string().optional(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
    .max(20)
    .optional(),
  roles: z
    .array(
      z.object({
        column: z.string(),
        role: z.enum(['dependent', 'independent', 'grouping', 'covariate', 'paired']),
      }),
    )
    .max(30)
    .optional(),
  test: z.string().optional(),
  mode: z.string().optional(),
  /**
   * A model the user picked. Validated against their plan on the server —
   * whatever the composer offered, this body could say anything.
   */
  modelId: z.string().max(120).optional(),
});

type Body = z.infer<typeof agentSchema>;

/**
 * The agent endpoint: one natural-language request in, a stream of progress out.
 *
 * Streams Server-Sent Events in the same `data: {…}` shape the existing chat
 * uses, with additional event types for the stages of a task. The existing chat
 * panel is untouched — this is an extension of the transport, not a change to it.
 *
 * The rate limit is on tasks rather than on model calls, which is the same unit
 * the user sees. A request that runs eight completions internally is one thing
 * they asked for, and counting it as eight would be both confusing and unfair.
 */
export const POST = withApi<Body>(
  { schema: agentSchema, rateLimit: { max: 30, windowSeconds: 300, key: 'agent.run' } },
  async ({ user, body }) => {
    /*
     * Checked before any work starts. A model outside the caller's plan is
     * refused here rather than downgraded silently — answering with a different
     * model than the interface showed would leave the user unable to say which
     * one produced their result.
     */
    await resolveRequestedModel(user.id, body.modelId);

    const stream = agentStream({
      userId: user.id,
      message: body.message,
      locale: body.locale,
      datasetId: body.datasetId ?? null,
      projectId: body.projectId ?? null,
      conversationId: body.conversationId ?? null,
      history: body.history,
      roles: body.roles,
      test: body.test as Parameters<typeof agentStream>[0]['test'],
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Render and most proxies buffer streamed responses without this.
        'x-accel-buffering': 'no',
      },
    });
  },
);

/**
 * What the agent can and cannot do, straight from the capability catalogue.
 *
 * Exposed so the interface can tell a user what is possible before they ask,
 * and so "not built yet" is a documented state rather than something they
 * discover by being refused.
 */
export const GET = withApi({}, async ({ user }) => {
  const access = await modelAccessFor(user.id);

  return ok({
    modes: availableModes().map((mode) => ({
      key: mode.key,
      requiresDataset: mode.requiresDataset,
    })),
    plannedModes: MODE_KEYS.map((key) => MODES[key])
      .filter((mode) => !mode.available)
      .map((mode) => ({ key: mode.key, reasonKey: mode.unavailableReason })),
    models: access.models.map((model) => ({ id: model.id, isDefault: model.isDefault })),
    showModelSelector: access.showSelector,
    available: availableCapabilities().map((capability) => ({
      intent: capability.intent,
      agent: capability.agent,
      requiresDataset: capability.requiresDataset,
      units: capability.units,
    })),
    planned: plannedCapabilities().map((capability) => ({
      intent: capability.intent,
      reasonKey: capability.unavailableReason,
    })),
  });
});
