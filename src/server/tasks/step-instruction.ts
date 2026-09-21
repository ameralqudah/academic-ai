/**
 * What a step was told to do, whatever the planner called it.
 *
 * The planner is a model, and it is shown `"input": { "<field>": "<value>" }`
 * without being told the field names. So it names them as it sees fit: the same
 * search arrived as `query` in one task and `topic` in the next, and an answer
 * step arrived as `prompt` — a name no handler read. The handler found nothing
 * under `question`, concluded it had been given nothing, and stopped the task
 * to ask the researcher "What would you like me to answer?" with a complete,
 * carefully written instruction sitting in its input.
 *
 * A handler that needs one piece of text should accept it under any of the
 * names a reasonable author would use. Kept free of imports so the rule can be
 * tested on its own.
 */
const NAMES = [
  'question',
  'prompt',
  'instruction',
  'instructions',
  'task',
  'query',
  'topic',
  'subject',
  'text',
  'request',
  'description',
];

function usable(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

export function instructionFrom(input: Record<string, unknown>, preferred: string[] = []): string {
  for (const name of [...preferred, ...NAMES]) {
    const found = usable(input[name]);
    if (found) return found;
  }

  /*
   * A single piece of text under a name nobody anticipated is still plainly the
   * instruction. With several, guessing which one is meant would be worse than
   * admitting it is not known.
   */
  const texts = Object.values(input).map(usable).filter(Boolean);
  return texts.length === 1 ? (texts[0] as string) : '';
}
