/**
 * Structured logging. One JSON line per event so a hosting platform can index it.
 * Swap the sink here to ship logs elsewhere; call sites never change.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';
  return ORDER[configured] ?? ORDER.info;
}

function emit(level: Level, message: string, context?: Record<string, unknown>) {
  if (ORDER[level] < threshold()) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...context,
  };

  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => emit('error', message, context),
};
