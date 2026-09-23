/**
 * Imported first by suites that need no database: a placeholder connection
 * string, so modules that build the (lazy) client at import time can load.
 * No connection is ever opened with it.
 */
process.env.DATABASE_URL ??= 'postgresql://unused:unused@127.0.0.1:1/unused';
