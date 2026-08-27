import { estimateTokens, readSSE, type AIProvider } from '../provider';
import {
  AIProviderError,
  type AIChunk,
  type AIRequest,
  type AIResult,
  type TokenUsage,
} from '../types';
import { isUsableApiKey } from '@/ai/key';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const PRICE_PER_MTOK = { input: 2.5, output: 10 };

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai' as const;
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

  private payload(request: AIRequest, stream: boolean) {
    return {
      model: this.model,
      max_completion_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
  }

  private headers() {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
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
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      text: data.choices?.[0]?.message?.content ?? '',
      usage: {
        tokensIn: data.usage?.prompt_tokens ?? 0,
        tokensOut: data.usage?.completion_tokens ?? 0,
      },
      provider: this.name,
      model: this.model,
      stopReason: data.choices?.[0]?.finish_reason,
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

    const usage: TokenUsage = { tokensIn: 0, tokensOut: 0 };

    for await (const payload of readSSE(response)) {
      let event: {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = event.choices?.[0]?.delta?.content;
      if (delta) yield { delta, done: false };

      if (event.usage) {
        usage.tokensIn = event.usage.prompt_tokens ?? usage.tokensIn;
        usage.tokensOut = event.usage.completion_tokens ?? usage.tokensOut;
      }
    }

    yield { delta: '', done: true, usage };
  }
}
