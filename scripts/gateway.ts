/**
 * Model Gateway unit suite (P1-B). Deterministic: no network, no database, no
 * keys. Real adapters run against a mocked `fetch`; the gateway runs with fake
 * quota, meter, clock and scope.
 *
 *   npm run test:gateway
 *
 * Letters refer to the test areas of the P1-B brief (A contract … T isolation).
 */

import { z } from 'zod';

import { AnthropicAdapter } from '@/server/ai/gateway/adapters/anthropic';
import { FakeAdapter } from '@/server/ai/gateway/adapters/fake';
import { GoogleAdapter } from '@/server/ai/gateway/adapters/google';
import { OpenAIAdapter } from '@/server/ai/gateway/adapters/openai';
import type { ProviderAdapter } from '@/server/ai/gateway/adapters/types';
import type { Provider, StreamEvent } from '@/server/ai/gateway/contract';
import { classifyHttp, GatewayError, redact, toAppError } from '@/server/ai/gateway/errors';
import { createGateway, type CallScope, type GatewayDeps, type PlanInfo } from '@/server/ai/gateway/gateway';
import { attemptCost, type AttemptRecord } from '@/server/ai/gateway/metering';
import { backoffMs, MAX_ATTEMPTS, type Clock } from '@/server/ai/gateway/policy';
import type { Reservation } from '@/server/ai/gateway/quota';
import { modelClass, route } from '@/server/ai/gateway/routing';
import { capabilityTool, defineTool, validateToolCalls } from '@/server/ai/gateway/tools';

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         expected ${JSON.stringify(expected)}\n         got      ${JSON.stringify(actual)}`}`);
}
async function errorClass(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'no error';
  } catch (error) {
    return error instanceof GatewayError ? error.errorClass : `other: ${(error as Error)?.message ?? String(error)}`;
  }
}

/* ------------------------------ fake deps ------------------------------- */

interface Harness {
  deps: GatewayDeps;
  meter: AttemptRecord[];
  toolRows: unknown[];
  reservations: (Reservation & { idempotencyKey: string; committed?: { countsAsRequest: boolean; tokensIn: number; tokensOut: number; costMicroUsd: number; outputText: string } })[];
  sleeps: number[];
  notices: string[];
  setScope(scope: CallScope | null): void;
  setPlan(plan: Partial<PlanInfo> | 'throw'): void;
}

const FREE: PlanInfo = { tier: 'free', limits: { maxAiRequests: 20, maxGeneratedWords: 5000 }, unlimited: (n) => n === -1 };

function harness(adapters: Partial<Record<Provider, ProviderAdapter>>, options: { models?: { provider: Provider; model: string }[]; defaultProvider?: Provider } = {}): Harness {
  let scope: CallScope | null = { userId: 'user-1', projectId: null };
  let plan: PlanInfo | 'throw' = FREE;
  const h: Harness = {
    meter: [],
    toolRows: [],
    reservations: [],
    sleeps: [],
    notices: [],
    setScope: (s) => (scope = s),
    setPlan: (p) => (plan = p === 'throw' ? 'throw' : { ...FREE, ...p }),
    deps: undefined as unknown as GatewayDeps,
  };
  const clock: Clock = {
    now: (() => {
      let t = 1_000_000;
      return () => (t += 7);
    })(),
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      h.sleeps.push(ms);
    },
    random: () => 0.5,
  };
  h.deps = {
    adapters: () => adapters,
    models: async () => ({
      configured: options.models ?? [
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        { provider: 'openai', model: 'gpt-4.1' },
        { provider: 'google', model: 'gemini-2.5-pro' },
      ],
      defaultProvider: options.defaultProvider ?? 'anthropic',
      siblings: { google: 'gemini-3.5-flash' },
    }),
    plan: async () => {
      if (plan === 'throw') throw new Error('plan lookup failed');
      return plan;
    },
    checkProject: async (projectId) => {
      if (projectId === 'foreign') throw new GatewayError('entitlement', 'not your project');
    },
    quota: {
      reserve: async (input) => {
        const existing = h.reservations.find((r) => r.idempotencyKey === input.idempotencyKey);
        if (existing) return existing;
        const r = { id: `res-${h.reservations.length + 1}`, userId: input.userId, periodKey: '2026-09', requests: input.requests, words: input.words, status: 'reserved', idempotencyKey: input.idempotencyKey } as Harness['reservations'][number] & { idempotencyKey: string };
        h.reservations.push(r);
        return r;
      },
      commit: async (input) => {
        const r = h.reservations.find((x) => x.id === input.reservation.id)!;
        r.status = 'committed';
        r.committed = { countsAsRequest: input.countsAsRequest, tokensIn: input.tokensIn, tokensOut: input.tokensOut, costMicroUsd: input.costMicroUsd, outputText: input.outputText };
      },
      release: async (reservation) => {
        h.reservations.find((x) => x.id === reservation.id)!.status = 'released';
      },
    },
    meter: {
      attempt: async (record) => void h.meter.push(record),
      toolCalls: async (input) => {
        h.toolRows.push(input);
        return new Map([...input.accepted, ...input.rejected].map((c, i) => [c.id, `tc-${i}`]));
      },
    },
    clock,
    scope: () => scope,
    notify: (n) => void h.notices.push(n),
  };
  return h;
}

const ask = (text = 'Hello', extra: Record<string, unknown> = {}) => ({ purpose: 'chat', messages: [{ role: 'user' as const, content: text }], ...extra });

/* ------------------------------ fake fetch ------------------------------ */

function fetcher(responses: (Response | Error)[]) {
  const seen: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    seen.push({ url, init, body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error('no scripted response');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, seen };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
const signal = () => new AbortController().signal;
const KEY_A = 'sk-ant-test-0123456789abcdefghij';
const KEY_O = 'sk-test-0123456789abcdefghijklmnop';
const KEY_G = 'AIzaTest0123456789abcdefghijklmnopqrs';

async function main() {
  const request = (text = 'Hi') => ({
    purpose: 'chat',
    system: 'You are helpful.',
    messages: [{ role: 'user' as const, content: text }],
    maxOutputTokens: 100,
    temperature: 0.2,
    cacheSystem: true,
    jsonMode: false,
    needsReasoning: false,
    latencySensitive: true,
    countsAsRequest: true,
    continuation: false,
  });

  /* ============================ B. adapters ============================ */
  console.log('\nB. Provider adapters: normalised requests and responses');
  {
    const { fn, seen } = fetcher([
      json({ model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5 } }),
      json({ content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { query: 'trust' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 3 } }),
      json({ content: [{ type: 'tool_use', id: 'tu_2', name: 'structured_output', input: { intent: 'chat' } }], stop_reason: 'tool_use', usage: {} }),
    ]);
    const a = new AnthropicAdapter(KEY_A, fn);
    const r = await a.send({ request: request(), model: 'claude-sonnet-5', signal: signal() });
    check('anthropic: text joined, usage and cache read normalised', [r.text, r.finishReason, r.usage.inputTokens, r.usage.cacheReadTokens], ['Hello there', 'stop', 10, 5]);
    check('anthropic: key in x-api-key header only', [(seen[0]!.init.headers as Record<string, string>)['x-api-key'] === KEY_A, seen[0]!.url.includes(KEY_A)], [true, false]);
    const tool = defineTool('web_search', 'Search', z.object({ query: z.string() }));
    const t = await a.send({ request: request(), model: 'claude-sonnet-5', tools: [tool], toolChoice: 'required', signal: signal() });
    check('anthropic: native tool_use normalised', [t.finishReason, t.toolCalls], ['tool_calls', [{ id: 'tu_1', name: 'web_search', arguments: { query: 'trust' } }]]);
    check('anthropic: tools and tool_choice sent natively', [seen[1]!.body.tool_choice, (seen[1]!.body.tools as { input_schema: { type: string } }[])[0]!.input_schema.type], [{ type: 'any' }, 'object']);
    const s = await a.send({ request: request(), model: 'claude-sonnet-5', responseSchema: { name: 'intent', schema: { type: 'object' } }, signal: signal() });
    check('anthropic: structured output via a forced tool', [s.text, (seen[2]!.body.tool_choice as { name: string }).name], ['{"intent":"chat"}', 'structured_output']);
  }
  {
    const { fn, seen } = fetcher([
      json({ model: 'gpt-4.1-2025', choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 } } }),
      json({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    ]);
    const o = new OpenAIAdapter(KEY_O, fn);
    const tool = defineTool('web_search', 'Search', z.object({ query: z.string() }));
    const img = { ...request(), messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'What is this?' }, { type: 'image' as const, mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }] }] };
    const r = await o.send({ request: img, model: 'gpt-4.1', tools: [tool], signal: signal() });
    check('openai: tool call arguments parsed, cached tokens split out', [r.toolCalls[0], r.usage.inputTokens, r.usage.cacheReadTokens, r.model], [{ id: 'c1', name: 'web_search', arguments: { query: 'x' } }, 12, 8, 'gpt-4.1-2025']);
    check('openai: images sent as image_url data URLs', ((seen[0]!.body.messages as { content: { type: string }[] }[])[1]!.content[1]!.type), 'image_url');
    check('openai: bearer auth, never in the URL', [(seen[0]!.init.headers as Record<string, string>).authorization, seen[0]!.url.includes('sk-')], [`Bearer ${KEY_O}`, false]);
    await o.send({ request: request(), model: 'gpt-4.1', responseSchema: { name: 'thing', schema: { $schema: 'x', type: 'object' } }, signal: signal() });
    check('openai: structured output via json_schema, $schema stripped', [(seen[1]!.body.response_format as { type: string }).type, JSON.stringify(seen[1]!.body.response_format).includes('$schema')], ['json_schema', false]);
    const toolTurn = {
      ...request(),
      messages: [
        { role: 'user' as const, content: 'find' },
        { role: 'assistant' as const, content: [{ type: 'tool_call' as const, id: 'c1', name: 'web_search', arguments: { query: 'x' } }] },
        { role: 'user' as const, content: [{ type: 'tool_result' as const, toolCallId: 'c1', name: 'web_search', content: '[]', isError: false }] },
      ],
    };
    const payload = o.payload({ request: toolTurn, model: 'gpt-4.1', signal: signal() }, false) as unknown as { messages: { role: string }[] };
    check('openai: tool results become role "tool" messages', payload.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  }
  {
    const { fn, seen } = fetcher([
      json({ modelVersion: 'gemini-2.5-pro', candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { functionCall: { name: 'web_search', args: { query: 'q' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 4, thoughtsTokenCount: 6 } }),
      json({ promptFeedback: { blockReason: 'SAFETY' } }),
    ]);
    const g = new GoogleAdapter(KEY_G, fn);
    const tool = defineTool('web_search', 'Search', z.object({ query: z.string() }));
    const r = await g.send({ request: request(), model: 'gemini-2.5-pro', tools: [tool], signal: signal() });
    check('google: functionCall normalised, thoughts hidden but billed', [r.finishReason, r.toolCalls[0]!.name, r.text, r.usage.outputTokens], ['tool_calls', 'web_search', '', 10]);
    check('google: key in x-goog-api-key header, never in the URL (G-9)', [(seen[0]!.init.headers as Record<string, string>)['x-goog-api-key'] === KEY_G, seen[0]!.url.includes('key=')], [true, false]);
    check('google: a blocked prompt is a refusal', await errorClass(() => g.send({ request: request(), model: 'gemini-2.5-pro', signal: signal() })), 'refusal');
  }
  {
    const { fn } = fetcher([
      sse([
        { type: 'message_start', message: { usage: { input_tokens: 12 }, model: 'claude-sonnet-5' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      ]),
    ]);
    const events: string[] = [];
    let final: import('@/server/ai/gateway/contract').AdapterResult | undefined;
    for await (const e of new AnthropicAdapter(KEY_A, fn).stream({ request: request(), model: 'claude-sonnet-5', signal: signal() })) {
      if (e.type === 'text') events.push(e.text);
      else final = e.result;
    }
    check('anthropic stream: deltas then a final result with usage', [events, final?.text, final?.usage.inputTokens, final?.usage.outputTokens], [['Hel', 'lo'], 'Hello', 12, 2]);
  }
  {
    const { fn } = fetcher([
      sse([
        { choices: [{ delta: { content: 'A' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'web_', arguments: '{"que' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search', arguments: 'ry":"z"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      ]),
    ]);
    let final: import('@/server/ai/gateway/contract').AdapterResult | undefined;
    for await (const e of new OpenAIAdapter(KEY_O, fn).stream({ request: request(), model: 'gpt-4.1', signal: signal() })) if (e.type === 'final') final = e.result;
    check('openai stream: tool call reassembled from fragments', [final?.toolCalls[0], final?.usage.outputTokens], [{ id: 'c9', name: 'web_search', arguments: { query: 'z' } }, 2]);
  }

  /* ======================= P. error classification ======================= */
  console.log('\nP. Error classification (status and provider type, not message words)');
  const cls = (status: number, body: unknown, headers?: Record<string, string>) => classifyHttp('openai', status, JSON.stringify(body), new Headers(headers)).errorClass;
  check('401 → auth', cls(401, { error: { type: 'invalid_request_error', message: 'bad key' } }), 'auth');
  check('429 → rate_limit (retry-after kept)', [cls(429, { error: { type: 'rate_limit_error' } }), classifyHttp('anthropic', 429, '{}', new Headers({ 'retry-after': '3' })).retryAfterSeconds], ['rate_limit', 3]);
  check('529 overloaded → outage', classifyHttp('anthropic', 529, JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } })).errorClass, 'outage');
  check('503 → outage', cls(503, {}), 'outage');
  check('504 → timeout', cls(504, {}), 'timeout');
  check('400 context_length_exceeded → context_length', cls(400, { error: { code: 'context_length_exceeded', message: 'too long' } }), 'context_length');
  check('400 "prompt is too long" → context_length', classifyHttp('anthropic', 400, JSON.stringify({ error: { type: 'invalid_request_error', message: 'prompt is too long: 300000 tokens' } })).errorClass, 'context_length');
  check('400 other → invalid_request', cls(400, { error: { type: 'invalid_request_error', message: 'temperature' } }), 'invalid_request');
  check('google RESOURCE_EXHAUSTED → rate_limit', classifyHttp('google', 429, JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } })).errorClass, 'rate_limit');
  check('a network failure → network', await errorClass(() => new OpenAIAdapter(KEY_O, async () => { throw new TypeError('fetch failed'); }).send({ request: request(), model: 'gpt-4.1', signal: signal() })), 'network');
  check('provider bodies are redacted before logging', redact('bad key sk-live-abcdefghijklmnop and ?key=AIzaSyA0123456789012345678901234567 bearer abc.def'), 'bad key [redacted] and ?key=[redacted] bearer [redacted]');
  check('the client never sees a provider body', JSON.stringify(toAppError(new GatewayError('invalid_request', 'x', { detail: 'secret sk-abcdefghijk' }))).includes('sk-'), false);

  /* ============================ H/M. routing ============================ */
  console.log('\nH/M. Routing within the entitlement');
  const all = [
    { provider: 'anthropic' as const, model: 'claude-sonnet-5' },
    { provider: 'openai' as const, model: 'gpt-4.1' },
    { provider: 'google' as const, model: 'gemini-2.5-pro' },
  ];
  const base = { configured: all, defaultProvider: 'anthropic' as const, needsReasoning: true, latencySensitive: false, contextTokens: 1000, siblingModels: { google: 'gemini-3.5-flash' } };
  const free = route({ ...base, tier: 'free' });
  check('free: never premium, and no premium substitute', [free.chosen.modelClass, free.fallbacks.some((f) => f.modelClass === 'premium')], ['standard', false]);
  check('unknown tier routes as free (fail closed)', route({ ...base, tier: undefined }).chosen.provider === free.chosen.provider && route({ ...base, tier: undefined }).tier, 'free');
  const paid = route({ ...base, tier: 'paid' });
  check('paid: premium first for reasoning work', paid.chosen.provider, 'anthropic');
  const economyFirst = route({ ...base, tier: 'free', latencySensitive: true, needsReasoning: false, siblingModels: {}, configured: [{ provider: 'google', model: 'gemini-3.5-flash' }, all[1]!] });
  check('a substitute is never above the chosen class', [economyFirst.chosen.modelClass, economyFirst.fallbacks.map((f) => f.modelClass)], ['economy', []]);
  check('free user requesting the premium model is refused', await Promise.resolve().then(() => { try { route({ ...base, tier: 'free', requested: all[0] }); return 'routed'; } catch (e) { return (e as GatewayError).errorClass; } }), 'entitlement');
  const chosen = route({ ...base, tier: 'paid', requested: all[1] });
  check('an explicit choice is honoured with no cross-provider substitute', [chosen.chosen.provider, chosen.fallbacks.length, chosen.reason], ['openai', 0, 'user_selected']);
  const only = route({ ...base, tier: 'free', configured: [all[0]!] });
  check('only premium configured: served, and named as such', [only.chosen.provider, only.reason.startsWith('only_model_configured')], ['anthropic', true]);
  check('google sibling offered as an economy substitute', route({ ...base, tier: 'free', configured: [all[2]!] }).fallbacks.map((f) => `${f.provider}:${f.model}`), ['google:gemini-3.5-flash']);
  check('model classes', [modelClass('anthropic', 'claude-haiku-4-5'), modelClass('google', 'gemini-3.5-flash'), modelClass('openai', 'gpt-4.1-mini'), modelClass('openai', 'gpt-4.1')], ['premium', 'economy', 'economy', 'standard']);

  /* ======================== A. contract, T. scope ======================== */
  console.log('\nA/T. Contract, call context and isolation');
  {
    const a = new FakeAdapter('anthropic');
    const o = new FakeAdapter('openai');
    const h = harness({ anthropic: a, openai: o });
    const gw = createGateway(h.deps);
    check('an invalid request is refused before any provider call', [await errorClass(() => gw.generate({ purpose: '', messages: [] })), a.calls.length + o.calls.length], ['invalid_request', 0]);
    h.setScope(null);
    check('no user in scope → refused, never routed as anonymous', [await errorClass(() => gw.generate(ask())), a.calls.length + o.calls.length], ['internal', 0]);
    h.setScope({ userId: 'user-1', projectId: 'foreign' });
    check('a project the user cannot see → refused', await errorClass(() => gw.generate(ask())), 'entitlement');
    h.setScope({ userId: 'user-1', projectId: 'p1', taskId: 't1', jobId: 'j1' });
    h.setPlan('throw');
    check('plan lookup failure → refused (fail closed), not premium', [await errorClass(() => gw.generate(ask())), a.calls.length], ['internal', 0]);
    h.setPlan({ tier: 'free' });
    const r = await gw.generate(ask('hello', { needsReasoning: true }));
    check('free user routed off the premium model even for reasoning work', r.provider, 'openai');
    check('usage row carries the user, project, task and job ids', [h.meter[0]!.userId, h.meter[0]!.projectId, h.meter[0]!.taskId, h.meter[0]!.jobId], ['user-1', 'p1', 't1', 'j1']);
  }

  /* ====================== G/H/R. retry and failover ====================== */
  console.log('\nG/H/R. Timeouts, retries and failover');
  {
    const o = new FakeAdapter('openai', [{ fail: new GatewayError('rate_limit', 'slow', { provider: 'openai', retryAfterSeconds: 2 }) }, { reply: { text: 'second' } }]);
    const g = new FakeAdapter('google');
    const h = harness({ openai: o, google: g }, { models: [{ provider: 'openai', model: 'gpt-4.1' }, { provider: 'google', model: 'gemini-2.5-pro' }], defaultProvider: 'openai' });
    const gw = createGateway(h.deps);
    const r = await gw.generate(ask('x', { needsReasoning: false, latencySensitive: false }));
    check('a rate limit fails over to the permitted alternative', [r.provider, r.attempts, h.notices], ['google', 2, ['failover']]);
    check('moving to a different model does not wait', h.sleeps, []);
    check('each attempt leaves a usage row', h.meter.map((m) => `${m.attempt}:${m.provider}:${m.status}:${m.errorClass ?? ''}`), ['1:openai:failed:rate_limit', '2:google:succeeded:']);
  }
  {
    const o = new FakeAdapter('openai', [{ fail: new GatewayError('rate_limit', 'slow', { provider: 'openai', retryAfterSeconds: 2 }) }, { reply: { text: 'second' } }]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    const r = await createGateway(h.deps).generate(ask());
    check('a retry of the same model honours retry-after (±20 % jitter, deterministic)', [r.attempts, h.sleeps, h.notices], [2, [2000], ['retry']]);
  }
  {
    for (const cls of ['auth', 'invalid_request', 'context_length', 'refusal'] as const) {
      const o = new FakeAdapter('openai', [{ fail: new GatewayError(cls, cls, { provider: 'openai' }) }]);
      const h = harness({ openai: o, google: new FakeAdapter('google') }, { models: [{ provider: 'openai', model: 'gpt-4.1' }, { provider: 'google', model: 'gemini-2.5-pro' }], defaultProvider: 'openai' });
      const got = await errorClass(() => createGateway(h.deps).generate(ask('x', { needsReasoning: false })));
      check(`${cls} is never retried`, [got, h.meter.length], [cls, 1]);
    }
  }
  {
    const outage = () => ({ fail: new GatewayError('outage', 'down', { provider: 'openai' }) });
    const o = new FakeAdapter('openai', [outage(), outage(), outage(), outage()]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    const got = await errorClass(() => createGateway(h.deps).generate(ask()));
    check(`an outage is retried at most ${MAX_ATTEMPTS} times in total`, [got, o.calls.length, h.sleeps.length], ['outage', MAX_ATTEMPTS, MAX_ATTEMPTS - 1]);
    check('a failed call with no usage releases its reservation', h.reservations[0]!.status, 'released');
  }
  {
    const hung = () => ({ reply: { text: 'late' }, delayMs: 5_000 });
    const o = new FakeAdapter('openai', [hung(), hung(), hung()]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    const started = Date.now();
    const got = await errorClass(() => createGateway(h.deps).generate(ask('x', { timeoutMs: 50 })));
    check('F: a hard timeout ends each hung attempt; timeouts are retried within the budget', [got, o.calls.length, h.meter.map((m) => m.errorClass), Date.now() - started < 2_000], ['timeout', 3, ['timeout', 'timeout', 'timeout'], true]);
  }
  {
    const o = new FakeAdapter('openai', [{ reply: { text: 'late' }, delayMs: 5_000 }]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const got = await errorClass(() => createGateway(h.deps).generate(ask(), { signal: controller.signal }));
    check('O: cancellation aborts the call, is not retried, and is recorded', [got, o.calls.length, h.meter[0]?.status], ['cancelled', 1, 'cancelled']);
  }
  {
    const paidPremium = new FakeAdapter('anthropic', [{ fail: new GatewayError('outage', 'down', { provider: 'anthropic' }) }, { fail: new GatewayError('outage', 'down', { provider: 'anthropic' }) }]);
    const o = new FakeAdapter('openai');
    const h = harness({ anthropic: paidPremium, openai: o });
    h.setPlan({ tier: 'free' });
    const gw = createGateway(h.deps);
    await gw.generate(ask('x', { needsReasoning: true }));
    check('M: a free user’s failover never reaches the premium model', paidPremium.calls.length, 0);
    const chosenByUser = new FakeAdapter('openai', [{ fail: new GatewayError('outage', 'down', { provider: 'openai' }) }, { reply: { text: 'ok' } }]);
    const other = new FakeAdapter('google');
    const h2 = harness({ openai: chosenByUser, google: other });
    const r = await createGateway(h2.deps).generate(ask('x', { requested: { provider: 'openai', model: 'gpt-4.1' } }));
    check('H: an explicit choice is retried, never swapped to another provider', [r.provider, other.calls.length, chosenByUser.calls.length], ['openai', 0, 2]);
  }
  {
    const o = new FakeAdapter('openai', [], 1000);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    check('S: a request over the context window fails before any provider call', [await errorClass(() => createGateway(h.deps).generate(ask('x'.repeat(8000)))), o.calls.length, h.reservations.length], ['context_length', 0, 0]);
  }
  check('backoff: 500 ms, then 1500 ms (jitter at midpoint = ×1)', [backoffMs(2, new GatewayError('outage', ''), { now: () => 0, sleep: async () => {}, random: () => 0.5 }), backoffMs(3, new GatewayError('outage', ''), { now: () => 0, sleep: async () => {}, random: () => 0.5 })], [500, 1500]);

  /* ======================= I/J. metering and cost ======================= */
  console.log('\nI/J. Metering and cost');
  {
    const o = new FakeAdapter('openai', [{ reply: { text: 'one two three', usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false } } }]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    await createGateway(h.deps).generate(ask('x', { estimatedWords: 10 }));
    check('J: cost at the serving model (gpt-4.1 input $2.50/M → 2,500,000 µ$)', h.meter[0]!.costMicroUsd, 2_500_000);
    check('I: the reservation is committed with the output and tokens', [h.reservations[0]!.status, h.reservations[0]!.committed?.countsAsRequest, h.reservations[0]!.committed?.tokensIn, h.reservations[0]!.committed?.outputText], ['committed', true, 1_000_000, 'one two three']);
    check('J: an unknown model is priced conservatively, never at zero', attemptCost('mystery-model', { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false }) > 0, true);
  }
  {
    const o = new FakeAdapter('openai', [{ reply: { text: 'internal' } }]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    await createGateway(h.deps).generate(ask('x', { countsAsRequest: false }));
    check('an internal step reserves no request and commits none', [h.reservations[0]!.requests, h.reservations[0]!.committed?.countsAsRequest], [0, false]);
  }
  {
    const o = new FakeAdapter('openai', [{ reply: { text: 'a' } }, { reply: { text: 'b' } }]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    const gw = createGateway(h.deps);
    await gw.generate(ask('x', { idempotencyKey: 'step-7:attempt-1' }));
    await gw.generate(ask('x', { idempotencyKey: 'step-7:attempt-1' }));
    check('the same idempotency key reserves once', h.reservations.length, 1);
  }

  /* ============================ E/O. streaming ============================ */
  console.log('\nE/O. Streaming');
  const drain = async (it: AsyncGenerator<StreamEvent>) => {
    const out: string[] = [];
    for await (const e of it) out.push(e.type === 'text_delta' ? e.text : e.type === 'notice' ? `[${e.notice}]` : '[done]');
    return out;
  };
  {
    const o = new FakeAdapter('openai', [{ fail: new GatewayError('outage', 'x', { provider: 'openai' }) }, { stream: ['Hel', 'lo'] }]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    check('a stream is retried before its first event, with a notice', await drain(createGateway(h.deps).stream(ask())), ['[retry]', 'Hel', 'lo', '[done]']);
    check('its usage is committed', h.reservations[0]!.status, 'committed');
  }
  {
    const o = new FakeAdapter('openai', [{ stream: ['partial '], failAfter: new GatewayError('outage', 'x', { provider: 'openai' }) }, { stream: ['never'] }]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    const pieces: string[] = [];
    const got = await errorClass(async () => {
      for await (const e of createGateway(h.deps).stream(ask())) if (e.type === 'text_delta') pieces.push(e.text);
    });
    check('after the first event a failure ends the stream (no repeated text)', [got, pieces, o.calls.length], ['outage', ['partial '], 1]);
    check('text already delivered is metered (estimated) and counted', [h.meter[0]!.usage.estimated, h.meter[0]!.usage.outputTokens > 0, h.reservations[0]!.committed?.countsAsRequest], [true, true, true]);
  }
  {
    const o = new FakeAdapter('openai', [{ stream: ['a', 'b', 'c', 'd'], delayMs: 20 }]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    const it = createGateway(h.deps).stream(ask());
    const first = await it.next();
    await it.return(undefined as never);
    check('O: abandoning a stream (client disconnect) aborts the provider and records a cancelled attempt', [first.value && (first.value as StreamEvent).type, o.calls[0]!.signal.aborted, h.meter[0]?.status], ['text_delta', true, 'cancelled']);
  }
  {
    const o = new FakeAdapter('openai', [{ stream: ['x'], hang: true }]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    const got = await errorClass(() => drain(createGateway(h.deps).stream(ask('x', { timeoutMs: 80 }))));
    check('F: a stalled stream ends at its timeout', got, 'timeout');
  }

  /* ======================== C/Q. tool calling ======================== */
  console.log('\nC/Q. Native tool calling and permissions');
  const search = capabilityTool('web.search', 'Search the web', z.object({ query: z.string().min(2).max(200) }).strict());
  const write = capabilityTool('document.write', 'Write a section', z.object({ section: z.string() }));
  check('capability tools come from the existing registry', [search.name, await errorClass(async () => capabilityTool('no.such', 'x', z.object({})))], ['web_search', 'invalid_request']);
  {
    const permitted = new Set(['web_search']);
    const v = validateToolCalls(
      [
        { id: '1', name: 'web_search', arguments: { query: 'trust in e-government' } },
        { id: '2', name: 'web_search', arguments: { query: 'x' } },
        { id: '3', name: 'web_search', arguments: { query: 'ok', extra: 'injected' } },
        { id: '4', name: 'document_write', arguments: { section: 'results' } },
        { id: '5', name: 'delete_everything', arguments: {} },
        { id: '6', name: 'web_search', arguments: '{not json' },
      ],
      [search, write],
      permitted,
    );
    check('Q: only schema-valid, permitted calls are accepted', v.accepted.map((c) => c.id), ['1']);
    check('Q: invalid, unpermitted and unknown calls are rejected with a reason', v.rejected.map((r) => `${r.id}:${r.reason}`), ['2:invalid_arguments', '3:invalid_arguments', '4:not_permitted', '5:not_permitted', '6:invalid_arguments']);
  }
  {
    const o = new FakeAdapter('openai', [{ reply: { finishReason: 'tool_calls', toolCalls: [{ id: 'a', name: 'web_search', arguments: { query: 'trust' } }, { id: 'b', name: 'document_write', arguments: { section: 's' } }] } }]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    const gw = createGateway(h.deps);
    const r = await gw.toolCall(ask('find sources'), { tools: [search, write], permittedTools: ['web_search'], toolChoice: 'auto' });
    check('C: the model is only offered permitted tools', o.calls[0]!.tools!.map((t) => t.name), ['web_search']);
    check('C: validated calls returned; a call to an unpermitted tool is rejected and recorded', [r.toolCalls.map((c) => c.id), r.rejectedToolCalls.map((c) => c.reason), Object.keys(r.toolCallRecords).length], [['a'], ['not_permitted'], 2]);
    check('C: forcing an unpermitted tool is refused', await errorClass(() => gw.toolCall(ask(), { tools: [search, write], permittedTools: ['web_search'], toolChoice: { name: 'document_write' } })), 'tool_validation');
    check('C: no permitted tools → refused', await errorClass(() => gw.toolCall(ask(), { tools: [write], permittedTools: [] })), 'tool_validation');
  }

  /* ======================== D. structured output ======================== */
  console.log('\nD. Structured output');
  const intent = z.object({ intent: z.enum(['chat', 'research']), confidence: z.number().min(0).max(1) });
  {
    const o = new FakeAdapter('openai', [{ reply: { text: '{"intent":"research","confidence":0.9}' } }]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    const r = await createGateway(h.deps).generateStructured(ask(), intent, { name: 'intent' });
    check('valid structured output is returned typed', [r.data, r.repaired, Boolean(o.calls[0]!.responseSchema)], [{ intent: 'research', confidence: 0.9 }, false, true]);
  }
  {
    const o = new FakeAdapter('openai', [{ reply: { text: '{"intent":"shopping","confidence":2}' } }, { reply: { text: '{"intent":"chat","confidence":0.4}' } }]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    const r = await createGateway(h.deps).generateStructured(ask(), intent);
    check('one bounded repair, metered as an internal call', [r.data.intent, r.repaired, o.calls.length, h.reservations.map((x) => x.requests)], ['chat', true, 2, [1, 0]]);
  }
  {
    const o = new FakeAdapter('openai', [{ reply: { text: 'Sure! The intent is research.' } }, { reply: { text: 'I think research.' } }]);
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    check('prose is never accepted as data', [await errorClass(() => createGateway(h.deps).generateStructured(ask(), intent)), o.calls.length], ['schema_validation', 2]);
  }

  /* ============================== embed ============================== */
  console.log('\nEmbeddings');
  {
    const o = new FakeAdapter('openai');
    const h = harness({ openai: o }, { models: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai' });
    const r = await createGateway(h.deps).embed({ purpose: 'retrieval', inputs: ['a', 'b'] });
    check('embeddings are returned and metered', [r.vectors.length, h.meter[0]?.kind, h.meter[0]?.status], [2, 'embed', 'succeeded']);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void (async () => {
  /* Tests assert on scripted fakes only; a stray real call would be a bug. */
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network access in the gateway unit suite');
  }) as typeof fetch;
  try {
    await main();
  } finally {
    globalThis.fetch = real;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

