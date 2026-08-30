/**
 * Turning an analysis reason key into a sentence, on the server.
 *
 * The parsing and statistics engines raise codes — `analysis.error.notAWorkbook`
 * — because a code can be tested, counted and logged in a way a sentence cannot.
 * Somewhere that code has to become words, and the question is where.
 *
 * It was being done in the browser, and it failed. A user uploaded a file with
 * the wrong extension and saw the literal string `analysis.error.notAWorkbook`
 * on screen: the refusal was correct, the message was machinery. The client
 * lookup was fragile in a way that is hard to see — `useTranslations()` with no
 * namespace, a key containing dots, and a resolver that returns the key rather
 * than throwing when it finds nothing, so the fallback path never ran.
 *
 * Doing it here removes the class of problem rather than the instance. The
 * server already sends `message` and `messageAr` on every error and the client
 * already knows how to pick one; the messages are read straight from the same
 * files the interface uses, so there is one place they live and no second
 * lookup to go wrong. A missing key becomes visible in a test rather than on a
 * user's screen.
 */

import ar from '../../../messages/ar.json';
import en from '../../../messages/en.json';

type Messages = Record<string, unknown>;

/**
 * Walks a dotted path.
 *
 * Written out rather than delegated because the failure that prompted this file
 * came from a resolver whose behaviour on a missing key was neither documented
 * where it was used nor what the caller assumed. This one returns undefined,
 * and every caller handles that.
 */
function lookup(messages: Messages, path: string): string | undefined {
  const value = path
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      messages,
    );

  return typeof value === 'string' ? value : undefined;
}

/**
 * Substitutes `{name}` placeholders.
 *
 * ICU message syntax would be heavier than these messages need — they carry
 * numbers and column names, never plurals or dates. A placeholder with no value
 * is left as written, so a mismatch shows up as `{threshold}` in a test rather
 * than as an empty gap in a sentence.
 */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;

  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export interface ResolvedMessage {
  en: string;
  ar: string;
}

/**
 * Both languages for a reason key.
 *
 * Both, because the error travels to a client that may be showing either and
 * the server does not know which — and sending one would mean the interface
 * looking up the other, which is the thing that broke.
 *
 * An unknown key falls back to itself. Visible, greppable, and caught by the
 * test that walks every key the analysis layer can raise.
 */
export function resolveReason(
  reasonKey: string,
  params?: Record<string, string | number>,
): ResolvedMessage {
  return {
    en: interpolate(lookup(en as Messages, reasonKey) ?? reasonKey, params),
    ar: interpolate(lookup(ar as Messages, reasonKey) ?? reasonKey, params),
  };
}

/** Whether a key has a message in both languages — used by the tests. */
export function hasReason(reasonKey: string): boolean {
  return (
    lookup(en as Messages, reasonKey) !== undefined && lookup(ar as Messages, reasonKey) !== undefined
  );
}
