import { estimateTokens, readSSE, type AIProvider } from '../provider';
import {
  AIProviderError,
  type AIChunk,
  type AIRequest,
  type AIResult,
  type TokenUsage,
} from '../types';
import { isUsableApiKey } from '@/ai/key';
import { costMicroUsd, priceFor } from '@/ai/prices';
import { logger } from '@/lib/logger';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Models that refused the thinking setting, so it is not sent to them twice. */
const thinkingRejected = new Set<string>();
/** Used only for a model the price table does not know; see `@/ai/prices`. */
const FALLBACK_PRICE = { input: 1.25, output: 5 };

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  /** The model's reasoning. Not shown to the user, and billed as output all the same. */
  thoughtsTokenCount?: number;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: GeminiUsage;
}

export class GoogleProvider implements AIProvider {
  readonly name = 'google' as const;
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
    return costMicroUsd(priceFor(this.model, FALLBACK_PRICE), usage);
  }

  /**
   * The least deliberation this model offers, or nothing when it offers none.
   *
   * Gemini 3 takes a level and cannot be switched off entirely; the 2.5 Flash
   * family takes a token budget, where zero is off. Anything else is left at
   * its default rather than guessed at.
   */
  private minimalThinking(): Record<string, unknown> | null {
    if (thinkingRejected.has(this.model)) return null;
    if (/^gemini-3/.test(this.model)) return { thinkingLevel: 'minimal' };
    if (/^gemini-2\.5-flash/.test(this.model)) return { thinkingBudget: 0 };
    return null;
  }

  private payload(request: AIRequest, options: { thinking?: boolean } = {}) {
    const thinking =
      request.reasoning === false && options.thinking !== false ? this.minimalThinking() : null;

    return {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: request.messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })),
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.7,
        ...(request.json ? { responseMimeType: 'application/json' } : {}),
        ...(thinking ? { thinkingConfig: thinking } : {}),
      },
    };
  }

  /**
   * Sends the request, and if the API refuses the thinking setting, sends it
   * again without one and stops offering it to this model.
   *
   * The setting is an optimisation. A model that does not accept it — a new
   * release, a renamed field — must cost a slower answer, not every answer.
   */
  private async post(
    method: 'generateContent' | 'streamGenerateContent',
    request: AIRequest,
  ): Promise<Response> {
    const send = (thinking: boolean) =>
      fetch(this.url(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.payload(request, { thinking })),
      });

    const response = await send(true);
    if (response.status !== 400 || request.reasoning !== false || !this.minimalThinking()) {
      return response;
    }

    const body = await response.text();
    if (!/thinking/i.test(body)) {
      /* A 400 about something else: hand it back as it was. */
      return new Response(body, { status: 400 });
    }

    thinkingRejected.add(this.model);
    logger.warn('ai.google.thinkingRejected', { model: this.model, detail: body.slice(0, 200) });
    return send(false);
  }

  private url(method: 'generateContent' | 'streamGenerateContent'): string {
    const sse = method === 'streamGenerateContent' ? '&alt=sse' : '';
    return `${BASE}/${this.model}:${method}?key=${encodeURIComponent(this.apiKey)}${sse}`;
  }

  async complete(request: AIRequest): Promise<AIResult> {
    const response = await this.post('generateContent', request);

    if (!response.ok) {
      throw new AIProviderError(this.name, await response.text(), response.status);
    }

    const data = (await response.json()) as GeminiResponse;
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');

    return {
      text,
      usage: {
        tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
        tokensOut:
          (data.usageMetadata?.candidatesTokenCount ?? 0) +
          (data.usageMetadata?.thoughtsTokenCount ?? 0),
      },
      provider: this.name,
      model: this.model,
      stopReason: data.candidates?.[0]?.finishReason,
    };
  }

  async *stream(request: AIRequest): AsyncIterable<AIChunk> {
    const response = await this.post('streamGenerateContent', request);

    if (!response.ok) {
      throw new AIProviderError(this.name, await response.text(), response.status);
    }

    const usage: TokenUsage = { tokensIn: 0, tokensOut: 0 };

    for await (const payload of readSSE(response)) {
      let event: GeminiResponse;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = (event.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('');
      if (delta) yield { delta, done: false };

      if (event.usageMetadata) {
        usage.tokensIn = event.usageMetadata.promptTokenCount ?? usage.tokensIn;
        usage.tokensOut =
          event.usageMetadata.candidatesTokenCount === undefined
            ? usage.tokensOut
            : event.usageMetadata.candidatesTokenCount +
              (event.usageMetadata.thoughtsTokenCount ?? 0);
      }
    }

    yield { delta: '', done: true, usage };
  }
}
