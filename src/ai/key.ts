/**
 * Whether a value can actually be used as an API key.
 *
 * "Not empty" is not enough. An API key travels in an HTTP header, and headers
 * accept only single-byte characters — so a key containing Arabic, a smart
 * quote, or a newline does not fail politely at the provider, it throws
 * `Cannot convert argument to a ByteString` deep inside fetch and surfaces as a
 * 500 with no clue as to the cause.
 *
 * The usual way a value like that gets into an environment variable is an
 * operator pasting the instruction rather than the secret — `<your key here>`.
 * Catching it here turns a mystifying crash into an honest "not configured".
 */
const USABLE_KEY = /^[\x21-\x7e]{20,}$/;

export function isUsableApiKey(value: string | undefined | null): boolean {
  return USABLE_KEY.test((value ?? '').trim());
}

/** A human-readable reason, for the health endpoint. Never echoes the value. */
export function describeKeyProblem(value: string | undefined | null): string | undefined {
  const key = (value ?? '').trim();
  if (key.length === 0) return 'The API key is empty.';
  if (/[^\x21-\x7e]/.test(key)) {
    return 'The API key contains spaces or non-Latin characters, so it cannot be sent as an HTTP header. It looks like placeholder text rather than a real key.';
  }
  if (key.length < 20) return `The API key is only ${key.length} characters long — too short to be real.`;
  return undefined;
}
