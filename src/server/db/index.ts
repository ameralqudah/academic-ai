import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { getEnv } from '@/config/env';

import * as schema from './schema';

/**
 * A single pooled connection per process. Next.js reloads modules in dev, so the
 * client is cached on globalThis to avoid exhausting Postgres connections.
 */
const globalForDb = globalThis as unknown as {
  __pgClient?: ReturnType<typeof postgres>;
};

function createClient() {
  const env = getEnv();

  // On a serverless platform every concurrent invocation is its own process, so
  // a large per-process pool multiplies into hundreds of connections. One socket
  // per instance, fronted by the provider's connection pooler, is the correct
  // shape there; a long-lived server can hold a real pool.
  const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

  return postgres(env.DATABASE_URL, {
    max: serverless ? 1 : env.NODE_ENV === 'production' ? 10 : 3,
    idle_timeout: 20,
    connect_timeout: 15,
    // Required by transaction-mode poolers (Neon `-pooler`, Supabase :6543).
    prepare: false,
  });
}

const client = globalForDb.__pgClient ?? createClient();
if (process.env.NODE_ENV !== 'production') globalForDb.__pgClient = client;

export const db = drizzle(client, { schema });
export type Database = typeof db;
export { schema };
