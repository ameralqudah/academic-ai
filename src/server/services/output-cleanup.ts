/**
 * Cleaning up what a model returns.
 *
 * A user asked where Jordan is, got a correct and well-written answer, and
 * found `ID; V]` stuck on the end of it. Nothing in the transport had corrupted
 * it — the SSE framing was verified to survive chunk boundaries mid-character —
 * so the fragment came from the model, which had begun emitting something after
 * its answer and been cut off mid-token.
 *
 * That happens. A model near its token budget, or one that starts a stray tool
 * call or a citation block it never finishes, leaves a few characters behind.
 * They are meaningless to the reader and they make a correct answer look
 * broken, which is worse than the fragment itself: a researcher who sees
 * garbage at the end of one answer stops trusting the ones without it.
 *
 * **What this does not catch, deliberately.** The fragment that prompted it —
 * `ID; V]` — contains letters, and every rule broad enough to remove it also
 * removed `p < .001` and `[0.12, 0.45]` in testing. A statistic and a stray
 * fragment genuinely look alike out of context, and this product exists to
 * produce statistics: losing a confidence interval from a researcher's results
 * is a serious failure, while five odd characters on screen is an annoyance.
 *
 * So only what can be recognised is removed — provider token markers, and a
 * trailing line of pure punctuation. The rest is left, and the truncation
 * warning below is what surfaces the underlying problem where it can actually
 * be fixed: in the token budget or the provider call.
 */

/**
 * Removes a trailing fragment that is clearly not part of the answer.
 *
 * Applied to prose the reader sees, not to JSON replies — those are parsed, and
 * a parser rejecting malformed output is already the right behaviour.
 */
export function stripTrailingArtefact(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return trimmed;

  /*
   * Only two things are removed, and both are recognisable rather than guessed.
   *
   * A general rule was tried first — "a short trailing line with no words" —
   * and it removed `p < .001` and `[0.12, 0.45]`. Every attempt to patch it
   * produced another false positive, because a statistic and a stray fragment
   * genuinely look alike out of context.
   *
   * So the rule stopped generalising. A confidence interval is content this
   * product exists to produce, and losing one is far worse than leaving five
   * odd characters on screen — which is annoying and harmless.
   */

  /* 1. Token markers, which every provider family writes the same way. */
  const withoutMarkers = trimmed.replace(
    /(?:<\|[a-z_]+\|>|<\/?s>|\[\/?INST\]|<\|endoftext\|>)\s*$/gi,
    '',
  );

  /*
   * 2. A trailing line made only of brackets, quotes and separators — the
   * remains of a JSON or tool-call block the model began and did not finish.
   *
   * Requires no letters and no digits at all, which is what keeps `[0.12,
   * 0.45]` and `p < .001` safe: both contain numbers, and content with numbers
   * in it is content.
   */
  const cleaned = withoutMarkers.trimEnd();
  const lines = cleaned.split('\n');
  const last = lines[lines.length - 1]?.trim() ?? '';

  if (
    lines.length > 1 &&
    last.length > 0 &&
    last.length <= 12 &&
    /^[\[\]{}(),;:|"'`\\/<>~^\s]+$/.test(last)
  ) {
    return lines.slice(0, -1).join('\n').trimEnd();
  }

  return cleaned;
}

/**
 * Whether a completion looks truncated rather than finished.
 *
 * Used for logging rather than for altering the text: a truncated answer is a
 * budget or provider problem worth seeing in the logs, and silently patching
 * over it would hide a fault that needs fixing at its source.
 */
export function looksTruncated(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.length < 40) return false;

  /* Ends mid-sentence: no terminal punctuation, in either script. */
  return !/[.!?؟।:;،\n)\]}"'»]$/.test(trimmed);
}
