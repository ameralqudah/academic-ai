import { estimateTokens, readSSE, type AIProvider } from '../provider';
import {
  AIProviderError,
  type AIChunk,
  type AIEffort,
  type AIRequest,
  type AIResult,
  type TokenUsage,
} from '../types';
import { isUsableApiKey } from '@/ai/key';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * USD per million input/output tokens, by model. Used for admin cost reporting
 * only. Cache writes cost 1.25× input and cache reads 0.1×, both derived rather
 * than listed, which is why the system block is cached.
 *
 * Keyed by model because the model is configurable: a single pair of constants
 * was wrong the moment anyone set `ANTHROPIC_MODEL` to something else, and it
 * reported Sonnet prices for whatever was actually billed.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
};

/** What an unlisted model is costed at. Opus rates, so a surprise reads high. */
const PRICE_FALLBACK = { input: 5, output: 25 };

/**
 * Models that reason adaptively: Claude 4.6 and everything after it.
 *
 * Two things follow from being on this list, and they are why it exists rather
 * than a config flag. These models take `thinking: {type: 'adaptive'}` and an
 * effort level instead of a fixed token budget, and they **reject
 * `temperature` with a 400** — so the per-call temperatures this app has always
 * sent have to be dropped, not passed through. Older models are unchanged.
 *
 * Note the `4-5` exclusions: `claude-sonnet-4-5` and `claude-haiku-4-5` are not
 * on this list and still take `temperature`.
 */
function reasonsAdaptively(model: string): boolean {
  return /^claude-(?:opus-(?:5|4-[678])|sonnet-(?:5|4-6)|fable-5|mythos-5)/.test(model);
}

/**
 * Room for the model to think inside `max_tokens`.
 *
 * Reasoning tokens count against the same ceiling as the answer, and every
 * caller in this app sized `maxTokens` for the answer alone — the 600-token
 * budget for structured extraction was chosen when nothing reasoned first. Left
 * as-is, thinking would eat the budget and the caller would get an empty
 * string back with no error to explain it.
 *
 * Headroom is added rather than the caller's number being scaled, because the
 * caller's number is a real statement about the answer's length. Unused
 * headroom costs nothing: billing counts tokens generated, not tokens allowed.
 */
const THINKING_HEADROOM: Record<AIEffort, number> = {
  low: 2_000,
  medium: 4_000,
  high: 8_000,
  xhigh: 16_000,
  max: 32_000,
};

/** The output ceiling on the models this applies to. */
const MAX_OUTPUT_TOKENS = 128_000;

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
    const price = PRICE_PER_MTOK[this.model] ?? PRICE_FALLBACK;
    const dollars =
      (usage.tokensIn / 1_000_000) * price.input +
      (usage.tokensOut / 1_000_000) * price.output +
      ((usage.cacheWriteTokens ?? 0) / 1_000_000) * (price.input * 1.25) +
      ((usage.cacheReadTokens ?? 0) / 1_000_000) * (price.input * 0.1);
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
    const base = {
      model: this.model,
      system: this.systemBlocks(request),
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream,
    };

    const answerTokens = request.maxTokens ?? 4096;

    /*
     * Older models: unchanged. Temperature is still how they are steered, and
     * they have no notion of effort.
     */
    if (!reasonsAdaptively(this.model)) {
      return {
        ...base,
        max_tokens: answerTokens,
        temperature: request.temperature ?? 0.7,
      };
    }

    /*
     * Adaptive models. `temperature` is deliberately absent — sending it is a
     * 400, not a warning — and the effort level takes its place.
     */
    const effort: AIEffort = request.effort ?? 'high';

    return {
      ...base,
      max_tokens: Math.min(answerTokens + THINKING_HEADROOM[effort], MAX_OUTPUT_TOKENS),
      thinking: { type: 'adaptive' as const },
      output_config: { effort },
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
