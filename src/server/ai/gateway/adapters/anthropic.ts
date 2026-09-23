/**
 * Anthropic Messages API adapter.
 *
 * - Native tools: `tools` / `tool_use` / `tool_result` content blocks.
 * - Structured output: a single forced tool whose input schema is the target
 *   schema; the tool's input is the structured result.
 * - The system block is cached (`cache_control`) above the provider's minimum.
 */

import { adapterResultSchema, type AdapterResult, type FinishReason, type GatewayMessage } from '../contract';
import { classifyThrown } from '../errors';
import { isUsableApiKey } from '@/ai/key';
import { parseJsonArguments, partsOf, post, readSSE } from './shared';
import { defaultFetcher, type AdapterCall, type AdapterStreamEvent, type Fetcher, type ModelCapabilities, type ProviderAdapter } from './types';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
/** Anthropic caches a prefix only above a model-dependent minimum; shorter prompts are simply not cached. */
const CACHE_MIN_CHARS = 2500;
export const STRUCTURED_TOOL = 'structured_output';

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: string; [key: string]: unknown };

function finish(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function withoutMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

function toMessage(message: GatewayMessage) {
  return {
    role: message.role,
    content: partsOf(message).map((part) => {
      switch (part.type) {
        case 'text':
          return { type: 'text', text: part.text };
        case 'image':
          return { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } };
        case 'tool_call':
          return { type: 'tool_use', id: part.id, name: part.name, input: part.arguments };
        case 'tool_result':
          return { type: 'tool_result', tool_use_id: part.toolCallId, content: part.content, is_error: part.isError };
      }
    }),
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = 'anthropic' as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = defaultFetcher,
  ) {}

  configured(): boolean {
    return isUsableApiKey(this.apiKey);
  }

  capabilities(): ModelCapabilities {
    return { tools: true, structured: true, images: true, contextTokens: 200_000 };
  }

  private headers() {
    return { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': API_VERSION };
  }

  payload(call: AdapterCall, stream: boolean) {
    const { request } = call;
    const cache = request.cacheSystem && request.system.length >= CACHE_MIN_CHARS;
    const tools = call.responseSchema
      ? [{ name: STRUCTURED_TOOL, description: `Return the result as ${call.responseSchema.name}.`, input_schema: withoutMeta(call.responseSchema.schema) }]
      : call.tools?.map((tool) => ({ name: tool.name, description: tool.description, input_schema: withoutMeta(tool.parameters) }));
    const choice = call.responseSchema
      ? { type: 'tool', name: STRUCTURED_TOOL }
      : call.toolChoice === undefined || !tools?.length
        ? undefined
        : call.toolChoice === 'auto'
          ? { type: 'auto' }
          : call.toolChoice === 'required'
            ? { type: 'any' }
            : call.toolChoice === 'none'
              ? { type: 'none' }
              : { type: 'tool', name: call.toolChoice.name };

    return {
      model: call.model,
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      ...(request.system ? { system: [{ type: 'text', text: request.system, ...(cache ? { cache_control: { type: 'ephemeral' } } : {}) }] } : {}),
      messages: request.messages.map(toMessage),
      ...(tools?.length ? { tools } : {}),
      ...(choice ? { tool_choice: choice } : {}),
      stream,
    };
  }

  static normalise(data: { content?: Block[]; usage?: AnthropicUsage; stop_reason?: string; model?: string }, model: string, structured: boolean): AdapterResult {
    const blocks = data.content ?? [];
    const toolUses = blocks.filter((block): block is Extract<Block, { type: 'tool_use' }> => block.type === 'tool_use');
    const text = structured
      ? JSON.stringify(toolUses.find((block) => block.name === STRUCTURED_TOOL)?.input ?? null)
      : blocks
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map((block) => block.text)
          .join('');
    return adapterResultSchema.parse({
      text,
      toolCalls: structured ? [] : toolUses.map((block) => ({ id: block.id, name: block.name, arguments: block.input })),
      finishReason: structured && data.stop_reason === 'tool_use' ? 'stop' : finish(data.stop_reason),
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
        cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
      },
      model: data.model ?? model,
    });
  }

  async send(call: AdapterCall): Promise<AdapterResult> {
    const response = await post(this.provider, this.fetcher, ENDPOINT, this.headers(), this.payload(call, false), call.signal);
    let data: Parameters<typeof AnthropicAdapter.normalise>[0];
    try {
      data = (await response.json()) as typeof data;
    } catch (error) {
      throw classifyThrown(this.provider, error, call.signal.aborted);
    }
    return AnthropicAdapter.normalise(data, call.model, Boolean(call.responseSchema));
  }

  async *stream(call: AdapterCall): AsyncIterable<AdapterStreamEvent> {
    const response = await post(this.provider, this.fetcher, ENDPOINT, this.headers(), this.payload(call, true), call.signal);
    const usage: AnthropicUsage = {};
    const blocks: Block[] = [];
    const partialJson = new Map<number, string>();
    let stopReason: string | undefined;
    let model = call.model;

    for await (const payload of readSSE(response, this.provider, call.signal)) {
      let event: {
        type?: string;
        index?: number;
        delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
        content_block?: Block;
        message?: { usage?: AnthropicUsage; model?: string };
        usage?: AnthropicUsage;
      };
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      if (event.type === 'message_start') {
        Object.assign(usage, event.message?.usage ?? {});
        model = event.message?.model ?? model;
      } else if (event.type === 'content_block_start' && event.content_block && event.index !== undefined) {
        blocks[event.index] = { ...event.content_block };
      } else if (event.type === 'content_block_delta' && event.index !== undefined) {
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          const block = blocks[event.index] as { type: 'text'; text: string } | undefined;
          if (block) block.text = (block.text ?? '') + event.delta.text;
          yield { type: 'text', text: event.delta.text };
        } else if (event.delta?.type === 'input_json_delta') {
          partialJson.set(event.index, (partialJson.get(event.index) ?? '') + (event.delta.partial_json ?? ''));
        }
      } else if (event.type === 'message_delta') {
        stopReason = event.delta?.stop_reason ?? stopReason;
        if (event.usage?.output_tokens !== undefined) usage.output_tokens = event.usage.output_tokens;
      }
    }

    for (const [index, json] of partialJson) {
      const block = blocks[index] as { type: 'tool_use'; input: unknown } | undefined;
      if (block) block.input = parseJsonArguments(json);
    }
    yield { type: 'final', result: AnthropicAdapter.normalise({ content: blocks.filter(Boolean), usage, stop_reason: stopReason, model }, call.model, false) };
  }
}
