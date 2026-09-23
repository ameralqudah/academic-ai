import { handlers } from '@/server/auth';
import {
  isFailedSignIn,
  loginBlocked,
  rateLimitedResponse,
  recordLoginFailure,
} from '@/server/auth/login-throttle';
import type { NextRequest } from 'next/server';

export const { GET } = handlers;

/**
 * Auth.js's POST handler, with password sign-in rate-limited in front of it.
 *
 * Every other Auth.js action passes straight through. For the credentials
 * callback the request is refused while either failure window is full, and a
 * failed attempt is counted after Auth.js has answered.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!new URL(request.url).pathname.endsWith('/callback/credentials')) {
    return handlers.POST(request);
  }

  const form = await request
    .clone()
    .formData()
    .catch(() => null);
  const email = String(form?.get('email') ?? '');

  const gate = await loginBlocked(request, email);
  if (gate.blocked) return rateLimitedResponse(request, gate.retryAfterSeconds);

  const response = await handlers.POST(request);
  if (await isFailedSignIn(response)) await recordLoginFailure(request, email);

  return response;
}
