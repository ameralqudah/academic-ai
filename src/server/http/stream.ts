import { AIProviderError } from '@/ai/types';
import { logger } from '@/lib/logger';
import { withNotices } from '@/server/ai/notices';

import { AppError } from './errors';

/**
 * A response the client reads as it is written.
 *
 * Server-sent events, one JSON object per event. The events are the contract:
 *
 *   { type: 'delta', text }     a piece of the answer
 *   { type: 'notice', kind }    the model is busy; another is being tried
 *   { type: 'task', task, … }   the answer became a task; show that instead
 *   { type: 'done', … }         finished, and saved
 *   { type: 'error', … }        failed, with a message in both languages
 *
 * An error after the first byte cannot be an HTTP status — the 200 has gone —
 * so it travels as an event, carrying the same messages the JSON error would.
 */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'notice'; kind: 'failover' | 'retry' }
  | {
      type: 'task';
      task: { id: string; status: string };
      restatement?: string;
      /** The stored message ids of this turn, when it was recorded. */
      messageIds?: { userMessageId: string; assistantMessageId: string } | null;
    }
  | { type: 'done'; [key: string]: unknown }
  | { type: 'error'; code: string; message: string; messageAr: string };

/** Pure, so the framing can be tested: one event, as the bytes on the wire. */
export function encodeStreamEvent(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function errorEvent(error: unknown): StreamEvent {
  if (error instanceof AppError) {
    return { type: 'error', code: error.code, message: error.message, messageAr: error.messageAr };
  }

  const transient = error instanceof AIProviderError;

  return {
    type: 'error',
    code: transient ? 'AI_UNAVAILABLE' : 'INTERNAL',
    message: transient
      ? 'The AI model is busy right now. Try again in a moment.'
      : 'Something went wrong. Please try again.',
    messageAr: transient
      ? 'نموذج الذكاء الاصطناعي مشغول الآن. أعد المحاولة بعد قليل.'
      : 'حدث خطأ ما. أعد المحاولة.',
  };
}

export function streamResponse(
  run: (send: (event: StreamEvent) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;

      const send = (event: StreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeStreamEvent(event)));
        } catch {
          /* The reader went away. The work finishes; nobody is listening. */
          open = false;
        }
      };

      try {
        /* Notices from the provider layer reach this stream and no other. */
        await withNotices((notice) => send({ type: 'notice', kind: notice.kind }), () => run(send));
      } catch (error) {
        logger.error('stream.failed', { error: String(error).slice(0, 300) });
        send(errorEvent(error));
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          /* Already closed by a disconnect. */
        }
      }
    },
  });

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      /* Tells a proxy in front of the app not to hold the response back. */
      'x-accel-buffering': 'no',
    },
  });
}
