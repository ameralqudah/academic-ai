/**
 * What a finished task wrote, as one thing that can be referred to.
 *
 * Pure, so the choice can be tested without a database: the continuity module
 * gathers the steps, and this says which output among them is "it".
 */

interface StepLike {
  status: string;
  capability: string;
  output: unknown;
  finishedAt?: Date | null;
  createdAt: Date;
}

interface OutputLike {
  id: string;
  type: string;
  data: unknown;
}

/*
 * Steps whose text is the product. A literature review also writes prose, but
 * in a plan that goes on to write the paper it is material for the paper —
 * offering both as candidates asks the researcher "which one?" about a review
 * and the paper built on it, a minute apart, when they said "it" about the
 * thing on their screen.
 */
const WRITES_THE_PRODUCT = new Set(['document.write', 'general.answer', 'deep.research']);

function proseIn(step: StepLike): OutputLike | null {
  const outputs = (step.output as { outputs?: OutputLike[] } | null)?.outputs ?? [];

  for (const output of outputs) {
    if (!output.type.startsWith('prose') && !output.type.startsWith('literature')) continue;

    const text = (output.data as { text?: unknown } | null)?.text;
    if (typeof text === 'string' && text.trim().length > 0) return output;
  }

  return null;
}

/*
 * Steps that produce research, as against a reply. `general.answer` writes the
 * product of a task too — but the product of a task that was only a question is
 * a conversational answer, and nobody who says "give it to me as Word" after a
 * paper and a follow-up question means the answer to the question.
 */
const RESEARCH = new Set(['document.write', 'deep.research', 'literature.review']);

/** Whether what a task wrote is research rather than a reply in passing. */
export function isResearch(capability: string): boolean {
  return RESEARCH.has(capability);
}

/**
 * Of several tasks' written work, the ones "it" can mean.
 *
 * Research when there is any; replies only when there is nothing else. In
 * production the most recent writing in the conversation was the assistant
 * saying it could not export Word files, and the file that came back was a Word
 * copy of that sentence.
 */
export function meantByIt<T extends { capability: string }>(candidates: T[]): T[] {
  const research = candidates.filter((candidate) => isResearch(candidate.capability));
  return research.length > 0 ? research : candidates;
}

/**
 * The output a task would be known by, and when it was made — or null.
 *
 * The last step that wrote the product; failing that, the last step that wrote
 * anything. The same rule the chat uses to decide what to show under a finished
 * task, so "it" is what the researcher is looking at.
 */
export function writtenWork<S extends StepLike>(
  steps: S[],
): { output: OutputLike; step: S; at: Date } | null {
  const done = steps.filter((step) => step.status === 'COMPLETED').reverse();

  for (const products of [true, false]) {
    for (const step of done) {
      if (products !== WRITES_THE_PRODUCT.has(step.capability)) continue;

      const output = proseIn(step);
      if (output) return { output, step, at: step.finishedAt ?? step.createdAt };
    }
  }

  return null;
}
