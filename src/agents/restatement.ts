/*
 * Pure, and on its own, because both the chat route and the chat screen need
 * it: the route so an echo is never stored, the screen so the echoes already
 * stored stop being shown.
 */

/**
 * Whether a "restatement" is only the request handed back.
 *
 * When the request is long, or the classifier is skipped, the restatement is
 * the first two hundred characters of what the researcher typed — cut
 * mid-word, sitting under the task where the answer belongs, and read as the
 * answer. Their message is already on screen directly above.
 */
export function isEcho(restatement: string, request: string): boolean {
  const squash = (value: string) =>
    value.replace(/\s+/g, " ").trim().toLowerCase();

  const said = squash(restatement).replace(/(\.\.\.|…)$/, "");
  if (said.length === 0) return true;

  return squash(request).startsWith(said);
}
