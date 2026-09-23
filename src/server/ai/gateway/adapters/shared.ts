/** Helpers shared by the adapters. Nothing here is provider-specific. */

import type { ContentPart, GatewayMessage } from '../contract';
import { classifyHttp, classifyThrown, GatewayError } from '../errors';
import type { Provider } from '../contract';
import type { Fetcher } from './types';

export function partsOf(message: GatewayMessage): ContentPart[] {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
}

/** Sends one request; HTTP and transport failures become classified GatewayErrors. */
export async function post(
  provider: Provider,
  fetcher: Fetcher,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (error) {
    throw classifyThrown(provider, error, Boolean(callerSignal?.aborted));
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw classifyHttp(provider, response.status, text, response.headers);
  }
  return response;
}

/** Reads `data:` lines from an SSE body, honouring the abort signal. */
export async function* readSSE(response: Response, provider: Provider, signal: AbortSignal): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw classifyThrown(provider, error, false);
      }
      if (signal.aborted) throw classifyThrown(provider, signal.reason, false);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload && payload !== '[DONE]') yield payload;
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export function parseJsonArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function notSupported(provider: Provider, what: string): GatewayError {
  return new GatewayError('invalid_request', `${provider} does not support ${what} for this model.`, { provider });
}
