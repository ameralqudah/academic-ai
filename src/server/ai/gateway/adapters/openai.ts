/**
 * OpenAI Chat Completions adapter.
 *
 * - Native tools: `tools` / `tool_calls`; tool results are `role: "tool"` messages.
 * - Structured output: `response_format: json_schema`.
 * - Embeddings: `/v1/embeddings`.
 */

import { adapterResultSchema, type AdapterResult, type FinishReason, type GatewayMessage } from '../contract';
import { classifyThrown } from '../errors';
import { isUsableApiKey } from '@/ai/key';
import { parseJsonArguments, partsOf, post, readSSE } from './shared';
import { defaultFetcher, type AdapterCall, type AdapterStreamEvent, type Fetcher, type ModelCapabilities, type ProviderAdapter } from './types';

const BASE = 'https://api.openai.com/v1';

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIToolCall {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
}

function finish(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function withoutMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

/** One gateway message can become several OpenAI messages (tool results are their own role). */
function toMessages(message: GatewayMessage): Record<string, unknown>[] {
  const parts = partsOf(message);
  const out: Record<string, unknown>[] = [];

  for (const part of parts.filter((p) => p.type === 'tool_result')) {
    if (part.type !== 'tool_result') continue;
    out.push({ role: 'tool', tool_call_id: part.toolCallId, content: part.content });
  }

  const visible = parts.filter((p) => p.type === 'text' || p.type === 'image');
  const calls = parts.filter((p) => p.type === 'tool_call');
  if (message.role === 'assistant') {
    if (visible.length || calls.length) {
      out.push({
        role: 'assistant',
        content: visible.map((p) => (p.type === 'text' ? p.text : '')).join('') || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((p) =>
                p.type === 'tool_call' ? { id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.arguments) } } : null,
              ),
            }
          : {}),
      });
    }
  } else if (visible.length) {
    const simple = visible.every((p) => p.type === 'text');
    out.push({
      role: 'user',
      content: simple
        ? visible.map((p) => (p.type === 'text' ? p.text : '')).join('')
        : visible.map((p) =>
            p.type === 'text' ? { type: 'text', text: p.text } : p.type === 'image' ? { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } } : null,
          ),
    });
  }
  return out;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider = 'openai' as const;
  readonly embeddingModel = 'text-embedding-3-small';

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = defaultFetcher,
  ) {}

  configured(): boolean {
    return isUsableApiKey(this.apiKey);
  }

  capabilities(model: string): ModelCapabilities {
    return { tools: true, structured: true, images: true, contextTokens: /^gpt-4\.1|^gpt-5/.test(model) ? 1_000_000 : 128_000 };
  }

  private headers() {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
  }

  payload(call: AdapterCall, stream: boolean) {
    const { request } = call;
    const choice =
      call.toolChoice === undefined || !call.tools?.length
        ? undefined
        : typeof call.toolChoice === 'string'
          ? call.toolChoice
          : { type: 'function', function: { name: call.toolChoice.name } };
    return {
      model: call.model,
      max_completion_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      messages: [...(request.system ? [{ role: 'system', content: request.system }] : []), ...request.messages.flatMap(toMessages)],
      ...(call.tools?.length
        ? { tools: call.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: withoutMeta(tool.parameters) } })) }
        : {}),
      ...(choice ? { tool_choice: choice } : {}),
      ...(call.responseSchema
        ? { response_format: { type: 'json_schema', json_schema: { name: call.responseSchema.name, schema: withoutMeta(call.responseSchema.schema), strict: false } } }
        : request.jsonMode
          ? { response_format: { type: 'json_object' } }
          : {}),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
  }

  static usage(raw: OpenAIUsage | undefined) {
    const cached = raw?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      /* OpenAI's prompt count includes cached tokens; they are reported separately so cost can discount them. */
      inputTokens: Math.max(0, (raw?.prompt_tokens ?? 0) - cached),
      outputTokens: raw?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
  }

  async send(call: AdapterCall): Promise<AdapterResult> {
    const response = await post(this.provider, this.fetcher, `${BASE}/chat/completions`, this.headers(), this.payload(call, false), call.signal);
    let data: {
      model?: string;
      choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCall[] }; finish_reason?: string }[];
      usage?: OpenAIUsage;
    };
    try {
      data = (await response.json()) as typeof data;
    } catch (error) {
      throw classifyThrown(this.provider, error, call.signal.aborted);
    }
    const choice = data.choices?.[0];
    return adapterResultSchema.parse({
      text: choice?.message?.content ?? '',
      toolCalls: (choice?.message?.tool_calls ?? []).map((tc, index) => ({
        id: tc.id ?? `call_${index}`,
        name: tc.function?.name ?? '',
        arguments: parseJsonArguments(tc.function?.arguments ?? '{}'),
      })),
      finishReason: finish(choice?.finish_reason),
      usage: OpenAIAdapter.usage(data.usage),
      model: data.model ?? call.model,
    });
  }

  async *stream(call: AdapterCall): AsyncIterable<AdapterStreamEvent> {
    const response = await post(this.provider, this.fetcher, `${BASE}/chat/completions`, this.headers(), this.payload(call, true), call.signal);
    let text = '';
    let usage: OpenAIUsage | undefined;
    let reason: string | undefined;
    let model = call.model;
    const calls = new Map<number, { id: string; name: string; args: string }>();

    for await (const payload of readSSE(response, this.provider, call.signal)) {
      let event: {
        model?: string;
        choices?: { delta?: { content?: string; tool_calls?: OpenAIToolCall[] }; finish_reason?: string | null }[];
        usage?: OpenAIUsage;
      };
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      model = event.model ?? model;
      const choice = event.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        yield { type: 'text', text: delta };
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const current = calls.get(index) ?? { id: '', name: '', args: '' };
        calls.set(index, {
          id: tc.id ?? current.id,
          name: current.name + (tc.function?.name ?? ''),
          args: current.args + (tc.function?.arguments ?? ''),
        });
      }
      if (choice?.finish_reason) reason = choice.finish_reason;
      if (event.usage) usage = event.usage;
    }

    yield {
      type: 'final',
      result: adapterResultSchema.parse({
        text,
        toolCalls: [...calls.values()].map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, arguments: parseJsonArguments(c.args || '{}') })),
        finishReason: finish(reason),
        usage: { ...OpenAIAdapter.usage(usage), estimated: !usage },
        model,
      }),
    };
  }

  async embed(input: { inputs: string[]; model: string; signal: AbortSignal }) {
    const response = await post(this.provider, this.fetcher, `${BASE}/embeddings`, this.headers(), { model: input.model, input: input.inputs }, input.signal);
    const data = (await response.json()) as { data?: { index: number; embedding: number[] }[]; usage?: { prompt_tokens?: number }; model?: string };
    const vectors = [...(data.data ?? [])].sort((a, b) => a.index - b.index).map((row) => row.embedding);
    return {
      vectors,
      model: data.model ?? input.model,
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false },
    };
  }
}
