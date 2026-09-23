/**
 * Gateway failures, classified (P1-B §2.4).
 *
 * The class decides what happens next — retry, fail over, or stop — so it is
 * derived from the provider's status and error type, never from matching words
 * in a message. Provider bodies are kept for the server log only, after key
 * redaction; the client sees a stable code and a bilingual message.
 */

import { AppError } from '@/server/http/errors';

import type { Provider } from './contract';

export const ERROR_CLASSES = [
  'auth',
  'rate_limit',
  'timeout',
  'network',
  'outage',
  'invalid_request',
  'context_length',
  'refusal',
  'tool_validation',
  'schema_validation',
  'cancelled',
  'quota',
  'entitlement',
  'not_configured',
  'internal',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

const RETRYABLE: ReadonlySet<ErrorClass> = new Set(['rate_limit', 'timeout', 'network', 'outage']);

export function isRetryable(errorClass: ErrorClass): boolean {
  return RETRYABLE.has(errorClass);
}

export class GatewayError extends Error {
  readonly errorClass: ErrorClass;
  readonly provider?: Provider;
  readonly status?: number;
  /** Seconds the provider asked us to wait (rate limits). */
  readonly retryAfterSeconds?: number;
  /** Redacted provider detail, for the server log only. */
  readonly detail?: string;
  /** Usage the provider reported before failing, when it did. */
  usage?: { inputTokens: number; outputTokens: number };

  constructor(
    errorClass: ErrorClass,
    message: string,
    options: { provider?: Provider; status?: number; retryAfterSeconds?: number; detail?: string } = {},
  ) {
    super(message);
    this.name = 'GatewayError';
    this.errorClass = errorClass;
    this.provider = options.provider;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.detail = options.detail === undefined ? undefined : redact(options.detail).slice(0, 500);
  }

  /** Attaches the application error this one stands for (a plan limit, say). */
  withCause(cause: unknown): this {
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false, configurable: true, writable: true });
    return this;
  }

  get retryable(): boolean {
    return isRetryable(this.errorClass);
  }
}

/**
 * Removes anything shaped like a credential: API keys (`sk-…`, `AIza…`, long
 * opaque tokens), bearer headers and `key=` query parameters. Applied to every
 * provider body before it is logged.
 */
export function redact(text: string): string {
  return text
    .replace(/([?&](?:key|api_key|apikey)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_\-]{8,}|AIza[0-9A-Za-z_\-]{20,}|sk-ant-[A-Za-z0-9_\-]{8,})/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_\-]{40,}\b/g, '[redacted]');
}

const CONTEXT_LENGTH = /context.{0,20}(length|window)|too many tokens|prompt is too long|maximum.{0,20}tokens|input.{0,20}too long|exceeds.{0,30}(limit|context)/i;
const REFUSAL = /safety|blocked|content.?policy|content_filter|refus/i;

/**
 * Classifies an HTTP failure from a provider. `type` is the provider's own
 * error type field when the body had one (`rate_limit_error`,
 * `overloaded_error`, `RESOURCE_EXHAUSTED`, `context_length_exceeded`, …).
 */
export function classifyHttp(
  provider: Provider,
  status: number,
  body: string,
  headers?: Headers,
): GatewayError {
  let type = '';
  let message = '';
  try {
    const parsed = JSON.parse(body) as {
      error?: { type?: string; code?: string | number; status?: string; message?: string };
      type?: string;
    };
    type = String(parsed.error?.type ?? parsed.error?.code ?? parsed.error?.status ?? parsed.type ?? '');
    message = String(parsed.error?.message ?? '');
  } catch {
    message = body;
  }
  const retryAfter = Number(headers?.get('retry-after'));
  const options = {
    provider,
    status,
    detail: `${type} ${message}`.trim() || body,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  };

  const signal = `${type} ${message}`;
  if (status === 401 || status === 403 || /authentication|permission|invalid.?api.?key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(type)) {
    return new GatewayError('auth', 'The AI provider rejected the credentials.', options);
  }
  if (status === 429 || /rate.?limit|RESOURCE_EXHAUSTED|quota/i.test(type)) {
    return new GatewayError('rate_limit', 'The AI provider is rate limiting requests.', options);
  }
  if (status === 408 || status === 504) return new GatewayError('timeout', 'The AI provider timed out.', options);
  if (status >= 500 || /overloaded|UNAVAILABLE|internal/i.test(type)) {
    return new GatewayError('outage', 'The AI provider is unavailable.', options);
  }
  if (/context_length|max_tokens|too.?long/i.test(type) || CONTEXT_LENGTH.test(signal)) {
    return new GatewayError('context_length', 'The request is too long for the model.', options);
  }
  if (REFUSAL.test(type)) return new GatewayError('refusal', 'The model declined the request.', options);
  if (status === 404) return new GatewayError('invalid_request', 'The model or endpoint was not found.', options);
  return new GatewayError('invalid_request', 'The AI provider rejected the request.', options);
}

/** Classifies a thrown error (fetch failure, abort) from a provider call. */
export function classifyThrown(provider: Provider, error: unknown, callerAborted: boolean): GatewayError {
  if (error instanceof GatewayError) return error;
  const name = (error as { name?: string })?.name;
  if (callerAborted) return new GatewayError('cancelled', 'The request was cancelled.', { provider });
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new GatewayError('timeout', 'The AI provider did not answer in time.', { provider });
  }
  return new GatewayError('network', 'The AI provider could not be reached.', {
    provider,
    detail: error instanceof Error ? error.message : String(error),
  });
}

/**
 * The error the application sees. Never carries a provider body: `details`
 * holds only the class, which the UI and logs can act on.
 */
export function toAppError(error: GatewayError): AppError {
  switch (error.errorClass) {
    case 'quota':
      return error.cause instanceof AppError ? error.cause : AppError.planLimit('aiRequests', 0, 0);
    case 'entitlement':
      if (error.detail === 'no_eligible_model') {
        return new AppError(
          'PLAN_LIMIT',
          'No AI model is available on your plan. Upgrade to Pro, or ask the administrator to configure a model your plan includes.',
          'لا يتوفر نموذج ذكاء اصطناعي ضمن خطتك. ارتقِ إلى Pro، أو اطلب من المسؤول إعداد نموذج مشمول في خطتك.',
          { metric: 'model', errorClass: error.errorClass, reason: 'no_eligible_model' },
        );
      }
      return new AppError('FORBIDDEN', 'That model is not included in your plan.', 'هذا النموذج غير مشمول في خطتك.', {
        errorClass: error.errorClass,
      });
    case 'rate_limit':
      return new AppError(
        'AI_UNAVAILABLE',
        'The AI provider quota has been used up. It resets on its own — try again later.',
        'انتهت حصّة مزوّد الذكاء الاصطناعي. تتجدّد تلقائيًا — أعد المحاولة لاحقًا.',
        { errorClass: error.errorClass },
      );
    case 'timeout':
    case 'network':
    case 'outage':
      return new AppError(
        'AI_UNAVAILABLE',
        'The AI model is busy at the moment. Try again in a minute.',
        'نموذج الذكاء الاصطناعي مشغول حاليًا. أعد المحاولة بعد دقيقة.',
        { errorClass: error.errorClass },
      );
    case 'context_length':
      return new AppError('VALIDATION', 'The request is too long for the model. Shorten it and try again.', 'الطلب أطول مما يحتمله النموذج. اختصره وأعد المحاولة.', {
        errorClass: error.errorClass,
      });
    case 'refusal':
      return new AppError('VALIDATION', 'The model declined this request.', 'رفض النموذج هذا الطلب.', { errorClass: error.errorClass });
    case 'cancelled':
      return new AppError('VALIDATION', 'The request was cancelled.', 'أُلغي الطلب.', { errorClass: error.errorClass });
    default:
      return AppError.aiUnavailable();
  }
}
