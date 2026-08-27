/**
 * One error type for the whole application.
 *
 * Services throw `AppError`; the API wrapper turns it into the response envelope.
 * `messageAr` exists because an API error can surface directly in the UI before
 * any translation layer runs.
 */

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PLAN_LIMIT'
  | 'AI_UNAVAILABLE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PLAN_LIMIT: 402,
  AI_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly messageAr: string;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, messageAr: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.messageAr = messageAr;
    this.details = details;
  }

  static unauthorized() {
    return new AppError('UNAUTHORIZED', 'You need to log in.', 'تحتاج إلى تسجيل الدخول.');
  }

  static forbidden() {
    return new AppError(
      'FORBIDDEN',
      "You don't have access to this.",
      'ليست لديك صلاحية الوصول إلى هذا.',
    );
  }

  static notFound(what = 'resource') {
    return new AppError('NOT_FOUND', `The ${what} was not found.`, 'العنصر المطلوب غير موجود.');
  }

  static validation(details?: unknown) {
    return new AppError(
      'VALIDATION',
      'Please check the highlighted fields.',
      'راجع الحقول المحدَّدة من فضلك.',
      details,
    );
  }

  static conflict(message: string, messageAr: string) {
    return new AppError('CONFLICT', message, messageAr);
  }

  static rateLimited(retryAfterSeconds: number) {
    return new AppError(
      'RATE_LIMITED',
      'Too many requests. Wait a moment and try again.',
      'طلبات كثيرة جدًا. انتظر لحظة ثم أعد المحاولة.',
      { retryAfterSeconds },
    );
  }

  static planLimit(metric: string, used: number, limit: number) {
    return new AppError(
      'PLAN_LIMIT',
      'Upgrade to Pro to continue your research.',
      'ارتقِ إلى Pro لمتابعة بحثك.',
      { metric, used, limit },
    );
  }

  static aiUnavailable(detail?: string) {
    return new AppError(
      'AI_UNAVAILABLE',
      'The AI service is not reachable right now.',
      'خدمة الذكاء الاصطناعي غير متاحة الآن.',
      detail,
    );
  }
}
