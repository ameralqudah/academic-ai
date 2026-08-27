import { estimateTokens, readSSE, type AIProvider } from '../provider';
import {
  AIProviderError,
  type AIChunk,
  type AIRequest,
  type AIResult,
  type TokenUsage,
} from '../types';
import { isUsableApiKey } from '@/ai/key';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * USD per million tokens. Adjust when pricing changes — used for admin cost
 * reporting only. Cache writes cost 1.25× input; cache reads cost 0.1×, which is
 * why the system block is cached.
 */
const PRICE_PER_MTOK = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

/**
 * Anthropic caches a prefix only above a model-dependent minimum (~1024 tokens).
 * A short system prompt simply is not cached — no error, no penalty.
 */
const CACHE_MIN_CHARS = 2500;

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  isConfigured(): boolean {
    return isUsableApiKey(this.apiKey);
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  estimateCostMicroUsd(usage: TokenUsage): number {
    const dollars =
      (usage.tokensIn / 1_000_000) * PRICE_PER_MTOK.input +
      (usage.tokensOut / 1_000_000) * PRICE_PER_MTOK.output +
      ((usage.cacheWriteTokens ?? 0) / 1_000_000) * PRICE_PER_MTOK.cacheWrite +
      ((usage.cacheReadTokens ?? 0) / 1_000_000) * PRICE_PER_MTOK.cacheRead;
    return Math.round(dollars * 1_000_000);
  }

  private systemBlocks(request: AIRequest) {
    const cache = request.cacheSystem !== false && request.system.length >= CACHE_MIN_CHARS;
    return [
      {
        type: 'text' as const,
        text: request.system,
        ...(cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
      },
    ];
  }

  private payload(request: AIRequest, stream: boolean) {
    return {
      model: this.model,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
      system: this.systemBlocks(request),
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream,
    };
  }

  private headers() {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': API_VERSION,
    };
  }

  async complete(request: AIRequest): Promise<AIResult> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.payload(request, false)),
    });

    if (!response.ok) {
      throw new AIProviderError(this.name, await response.text(), response.status);
    }

    const data = (await response.json()) as {
      content?: { type: string; text?: string }[];
      usage?: AnthropicUsage;
      stop_reason?: string;
    };

    const text = (data.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    return {
      text,
      usage: {
        tokensIn: data.usage?.input_tokens ?? 0,
        tokensOut: data.usage?.output_tokens ?? 0,
        cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
        cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
      },
      provider: this.name,
      model: this.model,
      stopReason: data.stop_reason,
    };
  }

  async *stream(request: AIRequest): AsyncIterable<AIChunk> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.payload(request, true)),
    });

    if (!response.ok) {
      throw new AIProviderError(this.name, await response.text(), response.status);
    }

    const usage: TokenUsage = {
      tokensIn: 0,
      tokensOut: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    };

    for await (const payload of readSSE(response)) {
      let event: {
        type?: string;
        delta?: { text?: string };
        message?: { usage?: AnthropicUsage };
        usage?: AnthropicUsage;
      };

      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      if (event.type === 'message_start' && event.message?.usage) {
        usage.tokensIn = event.message.usage.input_tokens ?? 0;
        usage.cacheWriteTokens = event.message.usage.cache_creation_input_tokens ?? 0;
        usage.cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
      }

      if (event.type === 'content_block_delta' && event.delta?.text) {
        yield { delta: event.delta.text, done: false };
      }

      if (event.type === 'message_delta' && event.usage) {
        usage.tokensOut = event.usage.output_tokens ?? usage.tokensOut;
      }
    }

    yield { delta: '', done: true, usage };
  }
}
