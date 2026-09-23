/**
 * A scripted adapter for tests. Never registered by `productionDeps`: tests and
 * the integration suite inject it explicitly.
 */

import { adapterResultSchema, type AdapterResult, type Provider } from '../contract';
import { GatewayError } from '../errors';
import type { AdapterCall, AdapterStreamEvent, ModelCapabilities, ProviderAdapter } from './types';

export type Script =
  | { reply: Partial<AdapterResult> & { text?: string }; delayMs?: number }
  | { fail: GatewayError }
  | { stream: string[]; failAfter?: GatewayError; delayMs?: number; hang?: boolean };

export class FakeAdapter implements ProviderAdapter {
  readonly calls: AdapterCall[] = [];
  readonly embeddingModel = 'fake-embed';
  private readonly script: Script[];

  constructor(
    readonly provider: Provider,
    script: Script[] = [],
    private readonly contextTokens = 200_000,
  ) {
    this.script = [...script];
  }

  push(...steps: Script[]) {
    this.script.push(...steps);
    return this;
  }

  configured(): boolean {
    return true;
  }

  capabilities(): ModelCapabilities {
    return { tools: true, structured: true, images: true, contextTokens: this.contextTokens };
  }

  private next(): Script {
    return this.script.shift() ?? { reply: { text: 'ok' } };
  }

  private static wait(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  }

  async send(call: AdapterCall): Promise<AdapterResult> {
    this.calls.push(call);
    const step = this.next();
    if ('fail' in step) throw step.fail;
    if ('stream' in step) throw new Error('scripted a stream for send()');
    if (step.delayMs) await FakeAdapter.wait(step.delayMs, call.signal);
    return adapterResultSchema.parse({
      text: step.reply.text ?? '',
      toolCalls: step.reply.toolCalls ?? [],
      finishReason: step.reply.finishReason ?? 'stop',
      usage: step.reply.usage ?? { inputTokens: 100, outputTokens: 50 },
      model: step.reply.model ?? call.model,
    });
  }

  async *stream(call: AdapterCall): AsyncIterable<AdapterStreamEvent> {
    this.calls.push(call);
    const step = this.next();
    if ('fail' in step) throw step.fail;
    if (!('stream' in step)) throw new Error('scripted a reply for stream()');
    for (const piece of step.stream) {
      if (step.delayMs) await FakeAdapter.wait(step.delayMs, call.signal);
      if (call.signal.aborted) throw call.signal.reason;
      yield { type: 'text', text: piece };
    }
    if (step.failAfter) throw step.failAfter;
    if (step.hang) await FakeAdapter.wait(10 * 60_000, call.signal);
    yield {
      type: 'final',
      result: adapterResultSchema.parse({ text: step.stream.join(''), toolCalls: [], finishReason: 'stop', usage: { inputTokens: 80, outputTokens: 20 }, model: call.model }),
    };
  }

  async embed(input: { inputs: string[]; model: string }) {
    return { vectors: input.inputs.map(() => [0.1, 0.2, 0.3]), model: input.model, usage: { inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false } };
  }
}
