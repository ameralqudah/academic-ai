/**
 * The single entry point every route handler goes through.
 *
 * Order matters: rate limit → session → body validation → handler → error envelope.
 * A route handler that does any of those itself is a bug.
 */

import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';

import { logger } from '@/lib/logger';
import { auth } from '@/server/auth';

import { AppError } from './errors';
import { clientKey, consume } from './rate-limit';
import { hasAdminAccess } from '@/server/auth/owner';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: 'USER' | 'ADMIN';
  locale: 'ar' | 'en';
}

export interface ApiContext<TBody, TParams> {
  request: Request;
  body: TBody;
  params: TParams;
  user: SessionUser;
}

export interface ApiContextPublic<TBody, TParams> {
  request: Request;
  body: TBody;
  params: TParams;
  user: SessionUser | null;
}

interface Options<TBody> {
  /** Body schema. Omit for GET/DELETE. */
  schema?: ZodType<TBody>;
  /** `false` allows anonymous access. Defaults to `true`. */
  auth?: boolean;
  /** Restrict to admins. */
  admin?: boolean;
  /** Route-specific limit; falls back to the global one. */
  rateLimit?: { max: number; windowSeconds?: number; key: string };
}

type RouteArgs<TParams> = { params: Promise<TParams> } | undefined;

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

function fail(error: AppError) {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        messageAr: error.messageAr,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
    {
      status: error.status,
      headers:
        error.code === 'RATE_LIMITED' && typeof error.details === 'object' && error.details
          ? { 'Retry-After': String((error.details as { retryAfterSeconds: number }).retryAfterSeconds) }
          : undefined,
    },
  );
}

export function withApi<TBody = undefined, TParams = Record<string, string>>(
  options: Options<TBody>,
  handler: (ctx: ApiContext<TBody, TParams>) => Promise<Response>,
) {
  return async (request: Request, routeArgs?: RouteArgs<TParams>): Promise<Response> => {
    const started = Date.now();

    try {
      if (options.rateLimit) {
        const result = await consume(
          clientKey(request, options.rateLimit.key),
          options.rateLimit.max,
          options.rateLimit.windowSeconds,
        );
        if (!result.allowed) throw AppError.rateLimited(result.retryAfterSeconds);
      }

      const requireAuth = options.auth !== false;
      let user: SessionUser | null = null;

      if (requireAuth || options.admin) {
        const session = await auth();
        if (!session?.user?.id) throw AppError.unauthorized();
        user = {
          id: session.user.id,
          email: session.user.email ?? '',
          name: session.user.name ?? null,
          role: session.user.role,
          locale: session.user.locale,
        };
        if (options.admin && !hasAdminAccess(user)) throw AppError.forbidden();
      }

      let body = undefined as TBody;
      if (options.schema) {
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          throw AppError.validation({ body: 'Expected a JSON body.' });
        }
        body = options.schema.parse(raw);
      }

      const params = routeArgs?.params ? await routeArgs.params : ({} as TParams);

      const response = await handler({
        request,
        body,
        params,
        user: user as SessionUser,
      });

      logger.debug('api.ok', {
        path: new URL(request.url).pathname,
        method: request.method,
        ms: Date.now() - started,
      });

      return response;
    } catch (error) {
      return fail(toAppError(error, request));
    }
  };
}

function toAppError(error: unknown, request: Request): AppError {
  if (error instanceof AppError) {
    if (error.status >= 500) {
      logger.error('api.error', { path: new URL(request.url).pathname, code: error.code });
    }
    return error;
  }

  if (error instanceof ZodError) {
    return AppError.validation(
      error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  logger.error('api.unhandled', {
    path: new URL(request.url).pathname,
    method: request.method,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  return new AppError(
    'INTERNAL',
    'Something went wrong on our side.',
    'حدث خطأ لدينا. حاول مرة أخرى من فضلك.',
  );
}
