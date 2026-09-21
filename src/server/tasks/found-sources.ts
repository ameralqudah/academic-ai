/**
 * What an earlier search found, written down for the step that answers.
 *
 * A task planned "search the recent literature, then propose titles", and the
 * second step never saw what the first one found: it answered from the model's
 * general knowledge while twelve retrieved papers sat in the step before it. The
 * search cost time and changed nothing.
 *
 * Titles and years only. That is enough to show where a field is heading, and
 * short enough to cost little; abstracts would triple the prompt for a step
 * whose job is to be informed by the literature, not to review it. Free of
 * imports so the wording can be tested on its own.
 */
export interface FoundSource {
  title?: string | null;
  year?: number | string | null;
  container?: string | null;
}

export function sourcesAsMaterial(sources: FoundSource[], limit = 12): string {
  const lines = sources
    .filter((source) => typeof source.title === 'string' && source.title.trim().length > 0)
    .slice(0, limit)
    .map((source) => {
      const year = source.year ? ` (${source.year})` : '';
      const container = source.container ? ` — ${source.container}` : '';
      return `- ${String(source.title).trim()}${year}${container}`;
    });

  if (lines.length === 0) return '';

  return [
    'Recent work retrieved by an earlier step of this task:',
    ...lines,
    '',
    /*
     * The instruction that matters. A list of real papers beside a request for
     * titles invites a model to present them as its own, or to cite them for
     * claims they never made.
     */
    'Use these to judge where the field is heading. Do not present them as your own suggestions, and do not attribute to them anything beyond their titles.',
  ].join('\n');
}
