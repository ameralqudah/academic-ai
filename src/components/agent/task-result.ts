/**
 * What a finished task has to show for itself, worked out from its steps.
 *
 * Pure functions, apart from the panel that draws them, so they can be tested
 * without a browser.
 */

interface StepLike {
  capability: string;
  status: string;
  artifactIds: string[];
  output: Record<string, unknown> | null;
}

/**
 * Steps whose product is prose the researcher asked to read. A search also
 * stores text of a kind, but its findings are material for a later step, not
 * the answer.
 */
const WRITES_PROSE = new Set([
  "general.answer",
  "document.write",
  "literature.review",
  "deep.research",
]);

function proseOf(step: StepLike): string {
  const legacy = (step.output?.legacy ?? step.output ?? {}) as Record<
    string,
    unknown
  >;

  for (const key of ["text", "answer", "report"]) {
    const value = legacy[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }

  return "";
}

/**
 * The text a completed task should put in front of the researcher, or null.
 *
 * A task that wrote a whole paper showed five ticks and nothing else: the panel
 * drew steps and files, and a writing step that was not followed by an export
 * produced neither. The work was done, stored, and invisible.
 *
 * The last writing step wins, because a plan that reviews the literature and
 * then writes the paper means the paper. Text that went into a file is left to
 * the file — showing both would be the same document twice.
 */
export function deliverableText(steps: StepLike[]): string | null {
  const exported = steps.some(
    (step) => step.status === "COMPLETED" && step.artifactIds.length > 0,
  );
  if (exported) return null;

  for (const step of [...steps].reverse()) {
    if (step.status !== "COMPLETED" || !WRITES_PROSE.has(step.capability))
      continue;

    const text = proseOf(step);
    if (text) return text;
  }

  return null;
}

/**
 * The message key for a finding code, or null when the text is not a code.
 *
 * Quality findings travel as codes (`format.emptySection`) so the replanner can
 * act on them, and the panel printed the code. A code is for the machine; the
 * researcher gets the sentence, and an unrecognised code gets nothing rather
 * than being shown raw.
 */
export function findingKey(message: string): string | null {
  return /^[a-z]+\.[A-Za-z]+$/.test(message) ? message.replace(".", "_") : null;
}
