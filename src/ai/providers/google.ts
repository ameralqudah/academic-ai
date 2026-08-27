import { estimateTokens, readSSE, type AIProvider } from '../provider';
import {
  AIProviderError,
  type AIChunk,
  type AIRequest,
  type AIResult,
  type TokenUsage,
} from '../types';
import { isUsableApiKey } from '@/ai/key';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const PRICE_PER_MTOK = { input: 1.25, output: 5 };

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
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
    const dollars =
      (usage.tokensIn / 1_000_000) * PRICE_PER_MTOK.input +
      (usage.tokensOut / 1_000_000) * PRICE_PER_MTOK.output;
    return Math.round(dollars * 1_000_000);
  }

  private payload(request: AIRequest) {
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
      },
    };
  }

  private url(method: 'generateContent' | 'streamGenerateContent'): string {
    const sse = method === 'streamGenerateContent' ? '&alt=sse' : '';
    return `${BASE}/${this.model}:${method}?key=${encodeURIComponent(this.apiKey)}${sse}`;
  }

  async complete(request: AIRequest): Promise<AIResult> {
    const response = await fetch(this.url('generateContent'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.payload(request)),
    });

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
        tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      provider: this.name,
      model: this.model,
      stopReason: data.candidates?.[0]?.finishReason,
    };
  }

  async *stream(request: AIRequest): AsyncIterable<AIChunk> {
    const response = await fetch(this.url('streamGenerateContent'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.payload(request)),
    });

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
        usage.tokensOut = event.usageMetadata.candidatesTokenCount ?? usage.tokensOut;
      }
    }

    yield { delta: '', done: true, usage };
  }
}
