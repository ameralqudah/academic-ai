/**
 * Google Gemini (generateContent) adapter.
 *
 * - The key travels in the `x-goog-api-key` header, never in the URL (P1-B G-9).
 * - Native tools: `functionDeclarations` / `functionCall` / `functionResponse`.
 * - Structured output: `responseMimeType: application/json` + `responseJsonSchema`.
 * - Embeddings: `batchEmbedContents`.
 * - The minimal-thinking setting is an optimisation: a model that rejects it is
 *   asked again without it, once, and not offered it again.
 */

import { adapterResultSchema, type AdapterResult, type FinishReason, type GatewayMessage } from '../contract';
import { classifyThrown, GatewayError } from '../errors';
import { isUsableApiKey } from '@/ai/key';
import { logger } from '@/lib/logger';
import { parseJsonArguments, partsOf, post, readSSE } from './shared';
import { defaultFetcher, type AdapterCall, type AdapterStreamEvent, type Fetcher, type ModelCapabilities, type ProviderAdapter } from './types';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Models that refused the thinking setting, so it is not sent to them twice. */
const thinkingRejected = new Set<string>();

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  /** Reasoning tokens: not shown, billed as output. */
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiPart {
  text?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
  thought?: boolean;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: GeminiUsage;
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
}

function finish(reason: string | undefined, hasCalls: boolean): FinishReason {
  if (hasCalls) return 'tool_calls';
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function withoutMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

function toContent(message: GatewayMessage) {
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: partsOf(message).map((part) => {
      switch (part.type) {
        case 'text':
          return { text: part.text };
        case 'image':
          return { inlineData: { mimeType: part.mediaType, data: part.data } };
        case 'tool_call':
          return { functionCall: { id: part.id, name: part.name, args: part.arguments } };
        case 'tool_result':
          return { functionResponse: { id: part.toolCallId, name: part.name, response: { content: part.content, isError: part.isError } } };
      }
    }),
  };
}

export class GoogleAdapter implements ProviderAdapter {
  readonly provider = 'google' as const;
  readonly embeddingModel = 'gemini-embedding-001';

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = defaultFetcher,
  ) {}

  configured(): boolean {
    return isUsableApiKey(this.apiKey);
  }

  capabilities(): ModelCapabilities {
    return { tools: true, structured: true, images: true, contextTokens: 1_000_000 };
  }

  private headers() {
    return { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey };
  }

  private minimalThinking(model: string): Record<string, unknown> | null {
    if (thinkingRejected.has(model)) return null;
    if (/^gemini-3/.test(model)) return { thinkingLevel: 'minimal' };
    if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
    return null;
  }

  payload(call: AdapterCall, thinking = true) {
    const { request } = call;
    const think = request.reasoning === false && thinking ? this.minimalThinking(call.model) : null;
    const mode =
      call.toolChoice === undefined || call.toolChoice === 'auto'
        ? 'AUTO'
        : call.toolChoice === 'required' || typeof call.toolChoice === 'object'
          ? 'ANY'
          : 'NONE';
    return {
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
      contents: request.messages.map(toContent),
      ...(call.tools?.length
        ? {
            tools: [{ functionDeclarations: call.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: withoutMeta(tool.parameters) })) }],
            toolConfig: {
              functionCallingConfig: {
                mode,
                ...(typeof call.toolChoice === 'object' ? { allowedFunctionNames: [call.toolChoice.name] } : {}),
              },
            },
          }
        : {}),
      generationConfig: {
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        ...(call.responseSchema ? { responseMimeType: 'application/json', responseJsonSchema: withoutMeta(call.responseSchema.schema) } : {}),
        ...(think ? { thinkingConfig: think } : {}),
      },
    };
  }

  /** Sends; if the thinking setting is refused, sends once more without it. */
  private async request(call: AdapterCall, method: 'generateContent' | 'streamGenerateContent'): Promise<Response> {
    const url = `${BASE}/${encodeURIComponent(call.model)}:${method}${method === 'streamGenerateContent' ? '?alt=sse' : ''}`;
    try {
      return await post(this.provider, this.fetcher, url, this.headers(), this.payload(call), call.signal);
    } catch (error) {
      const retryWithout =
        error instanceof GatewayError &&
        error.status === 400 &&
        call.request.reasoning === false &&
        this.minimalThinking(call.model) !== null &&
        /thinking/i.test(error.detail ?? '');
      if (!retryWithout) throw error;
      thinkingRejected.add(call.model);
      logger.warn('ai.google.thinkingRejected', { model: call.model });
      return post(this.provider, this.fetcher, url, this.headers(), this.payload(call, false), call.signal);
    }
  }

  static normalise(data: GeminiResponse, model: string): AdapterResult {
    if (data.promptFeedback?.blockReason) {
      throw new GatewayError('refusal', 'The model declined the request.', { provider: 'google', detail: data.promptFeedback.blockReason });
    }
    const candidate = data.candidates?.[0];
    const parts = (candidate?.content?.parts ?? []).filter((part) => !part.thought);
    const calls = parts.filter((part) => part.functionCall);
    return adapterResultSchema.parse({
      text: parts.map((part) => part.text ?? '').join(''),
      toolCalls: calls.map((part, index) => ({
        id: part.functionCall?.id ?? `call_${index}`,
        name: part.functionCall?.name ?? '',
        arguments: parseJsonArguments(part.functionCall?.args ?? {}),
      })),
      finishReason: finish(candidate?.finishReason, calls.length > 0),
      usage: GoogleAdapter.usage(data.usageMetadata),
      model: data.modelVersion ?? model,
    });
  }

  static usage(raw: GeminiUsage | undefined) {
    const cached = raw?.cachedContentTokenCount ?? 0;
    return {
      inputTokens: Math.max(0, (raw?.promptTokenCount ?? 0) - cached),
      outputTokens: (raw?.candidatesTokenCount ?? 0) + (raw?.thoughtsTokenCount ?? 0),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
  }

  async send(call: AdapterCall): Promise<AdapterResult> {
    const response = await this.request(call, 'generateContent');
    let data: GeminiResponse;
    try {
      data = (await response.json()) as GeminiResponse;
    } catch (error) {
      throw classifyThrown(this.provider, error, call.signal.aborted);
    }
    return GoogleAdapter.normalise(data, call.model);
  }

  async *stream(call: AdapterCall): AsyncIterable<AdapterStreamEvent> {
    const response = await this.request(call, 'streamGenerateContent');
    let text = '';
    const calls: GeminiPart[] = [];
    let reason: string | undefined;
    let usage: GeminiUsage | undefined;
    let model = call.model;

    for await (const payload of readSSE(response, this.provider, call.signal)) {
      let event: GeminiResponse;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      if (event.promptFeedback?.blockReason) GoogleAdapter.normalise(event, model);
      model = event.modelVersion ?? model;
      const candidate = event.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.thought) continue;
        if (part.functionCall) calls.push(part);
        if (part.text) {
          text += part.text;
          yield { type: 'text', text: part.text };
        }
      }
      reason = candidate?.finishReason ?? reason;
      if (event.usageMetadata) usage = event.usageMetadata;
    }

    yield {
      type: 'final',
      result: GoogleAdapter.normalise(
        { candidates: [{ content: { parts: [{ text }, ...calls] }, finishReason: reason }], usageMetadata: usage, modelVersion: model },
        call.model,
      ),
    };
  }

  async embed(input: { inputs: string[]; model: string; signal: AbortSignal }) {
    const url = `${BASE}/${encodeURIComponent(input.model)}:batchEmbedContents`;
    const response = await post(
      this.provider,
      this.fetcher,
      url,
      this.headers(),
      { requests: input.inputs.map((text) => ({ model: `models/${input.model}`, content: { parts: [{ text }] } })) },
      input.signal,
    );
    const data = (await response.json()) as { embeddings?: { values: number[] }[] };
    return {
      vectors: (data.embeddings ?? []).map((row) => row.values),
      model: input.model,
      /* Gemini's batch embedding response carries no token count; estimated upstream. */
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: true },
    };
  }
}
