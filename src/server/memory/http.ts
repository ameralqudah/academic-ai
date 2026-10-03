/**
 * HTTP for memories (P1-E, PR #5). Every route is behind `memoriesFlagged`
 * (with `FF_CONTEXT_V2` off the API answers 404, as if it did not exist),
 * `withApi` (session), an address limit and a per-user limit, a strict body
 * schema and a body cap. The service checks the project role and where the
 * memory belongs; the database enforces RLS underneath.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { contextV2Enabled } from '@/server/context/flags';

export const MEMORY_READ_LIMIT = { key: 'memory-read', max: 300, windowSeconds: 60 };
export const MEMORY_READ_USER_LIMIT = { key: 'memory-read-user', max: 300, windowSeconds: 60 };
export const MEMORY_WRITE_LIMIT = { key: 'memory-write', max: 60, windowSeconds: 60 };
export const MEMORY_WRITE_USER_LIMIT = { key: 'memory-write-user', max: 60, windowSeconds: 60 };
export const MEMORY_BODY_BYTES = 8 * 1024;

export const MEMORY_KINDS = ['preference', 'fact', 'instruction', 'style', 'decision'] as const;

export const createMemorySchema = z
  .object({
    kind: z.enum(MEMORY_KINDS),
    content: z.string().trim().min(1).max(2000),
    pinned: z.boolean().optional(),
  })
  .strict();

export const editMemorySchema = z
  .object({
    kind: z.enum(MEMORY_KINDS).optional(),
    content: z.string().trim().min(1).max(2000).optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.kind !== undefined || value.content !== undefined || value.pinned !== undefined, { message: 'Nothing to change.' });

export const STATUS_FILTER = z.enum(['proposed', 'confirmed', 'archived']);

type Handler<A extends unknown[]> = (request: Request, ...rest: A) => Promise<Response>;

/** The memory API exists only with `FF_CONTEXT_V2` on; off, every route answers 404 before anything else. */
export function memoriesFlagged<A extends unknown[]>(handler: Handler<A>): Handler<A> {
  return async (request, ...rest) => {
    if (!contextV2Enabled()) {
      return NextResponse.json({ ok: false, error: { code: 'NOT_FOUND', message: 'The resource was not found.', messageAr: 'العنصر المطلوب غير موجود.' } }, { status: 404 });
    }
    return handler(request, ...rest);
  };
}

/** `?status=` on a list, validated; anything else is ignored. */
export function statusFilter(request: Request) {
  const parsed = STATUS_FILTER.safeParse(new URL(request.url).searchParams.get('status'));
  return parsed.success ? { status: parsed.data } : {};
}
