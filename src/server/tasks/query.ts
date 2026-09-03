/**
 * Turning a request into something worth searching for.
 *
 * Pure text work, kept out of the handlers module because importing that pulls
 * in the AI service and through it the database — and a test checking that
 * "give me a Word file" is stripped from a query should not need a database to
 * do it.
 *
 * That coupling has now appeared seven times. The pattern is always the same:
 * a module needs one small pure function, imports the module that happens to
 * contain it, and drags everything behind it.
 */

/**
 * The topic inside a request.
 *
 * A planner told to pass a topic sometimes passes the whole sentence, and the
 * consequence is not cosmetic: "find studies on hybrid learning and give me a
 * Word file" matched ten poetry collections on the word "Word", and the
 * researcher received volumes of verse instead of literature.
 *
 * Instructions the model may ignore are not a guarantee, so the request is
 * stripped here too. Both layers, because either alone has been shown to fail.
 *
 * **This is a safety net, not the mechanism.** The planner is told to pass a
 * topic and usually does; these patterns catch the cases where it does not, and
 * they will not catch every phrasing. A request whose format clause survives
 * still searches for something reasonable — the relevance filter then judges
 * the results — which is why the fallback below returns the original rather
 * than an empty string.
 */
export function topicOf(request: string): string {
  /*
   * Trailing punctuation removed first. "…a Word document." kept its full stop,
   * which is inside the `.*$` of every clause pattern and so matched nothing —
   * a single character defeating the whole strip.
   */
  let text = request.trim().replace(/[.!?؟]+$/, '');

  /*
   * The format clause, which is what caused the poetry. Removed with the
   * conjunction that introduces it, or "hybrid learning and" is left behind.
   */
  text = text
    .replace(
      /\s*(?:,|;|and|then|،|و)?\s*(?:give|send|export|save|make|produce|prepare)\s+(?:me\s+|it\s+|them\s+|this\s+)?(?:as\s+|to\s+|in\s+)?(?:a\s+|an\s+|the\s+)?(?:word\s*(?:file|document|doc)?|docx|pdf\s*(?:file|document)?|excel|xlsx|powerpoint|pptx|csv|markdown|text\s*file|bibtex|ris)\b.*$/i,
      '',
    )
    .replace(
      /\s*(?:,|;|و)?\s*(?:واعطيني|وأعطني|واعطني|وصدّرها|وصدرها|واحفظها|وحوّلها|وحولها)\s*.*$/,
      '',
    )
    .replace(/\s*(?:as|in|بصيغة|كملف)\s+(?:a\s+|an\s+)?(?:word|docx|pdf|excel|pptx|csv|وورد|بي دي اف)\b.*$/i, '')
    /*
     * A trailing format clause with no verb: "…, exported as PDF" or "…, in
     * Word". The comma is what marks it as an aside rather than part of the
     * topic.
     */
    .replace(
      /\s*,?\s*(?:exported|saved|formatted|delivered)?\s*(?:as|in|to)\s+(?:a\s+|an\s+)?(?:word|docx|pdf|excel|xlsx|powerpoint|pptx|csv|markdown|text)\b.*$/i,
      '',
    )
    /* A dangling participle left behind when its object was removed. */
    .replace(/\s*,?\s*(?:exported|saved|formatted|delivered)\s*$/i, '');

  /* The instruction verb that opens the request. */
  text = text
    .replace(
      /^(?:please\s+)?(?:find|search\s+for|search|get|look\s+for|write|prepare|do|conduct|create|produce|research)\s+(?:me\s+)?(?:some\s+|recent\s+|the\s+|a\s+|an\s+)?(?:studies|papers|research\s+paper|research|articles|literature|sources|review)?\s*(?:on|about|regarding|concerning|of)?\s*/i,
      '',
    )
    /*
     * "I need / I want / I'm looking for", which open a request without an
     * imperative verb and are therefore missed by the pattern above.
     */
    .replace(
      /^(?:i\s+(?:need|want|would\s+like)|i'?m\s+looking\s+for)\s+(?:some\s+|recent\s+|the\s+|a\s+|an\s+)?(?:studies|papers|research|articles|literature|sources)?\s*(?:on|about|regarding|concerning)?\s*/i,
      '',
    )
    .replace(
      /^(?:من فضلك\s+)?(?:اعمل|أعمل|ابحث|أبحث|اكتب|أكتب|جهّز|جهز|أجرِ|اجر)\s*(?:لي\s+)?(?:بحثًا|بحثا|بحث|دراسة|دراسات|مراجعة)?\s*(?:عن|حول|بخصوص|في)?\s*/,
      '',
    )
    /*
     * The descriptors that survive the opening verb — "دراسات حديثة عن X"
     * leaves "دراسات حديثة عن" when the verb goes first. Removed separately
     * because they also appear without a verb.
     */
    .replace(/^(?:دراسات|أبحاث|بحوث|مقالات)\s+(?:حديثة|سابقة|منشورة)?\s*(?:عن|حول|في)\s*/, '')
    .replace(/^(?:حديثة|سابقة)\s+(?:عن|حول)\s*/, '');

  const cleaned = text.trim();

  /*
   * The original when stripping left too little. An empty or two-character
   * topic searches for nothing, which is worse than searching for the whole
   * sentence — at least that returns something the relevance filter can judge.
   */
  return cleaned.length >= 3 ? cleaned : request.trim();
}

/**
 * A broader form of a query that returned too little.
 *
 * Drops the last significant word, which in both Arabic and English is usually
 * the narrowing qualifier — "hybrid learning in Jordanian universities" becomes
 * "hybrid learning in Jordanian". Crude, and better than repeating a query that
 * already failed.
 *
 * Returns the original when there is nothing to drop, and the caller checks for
 * that: a recommendation identical to what was just tried is filtered out
 * before it reaches the planner.
 */
export function broaden(query: string): string {
  const words = query.trim().split(/\s+/);
  return words.length > 2 ? words.slice(0, -1).join(' ') : query;
}

