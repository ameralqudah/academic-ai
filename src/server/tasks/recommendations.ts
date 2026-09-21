/**
 * Whether a recommendation can be carried out as it stands.
 *
 * Kept free of imports so the rule can be tested without a database.
 *
 * "Search again" with no new query is an opinion, not an instruction: the step
 * it becomes has nothing to search for, and its handler can only stop the task
 * to ask the researcher for a topic they have already given. Those go to the
 * planner instead, which can phrase a better query or decide the task is better
 * off moving on.
 *
 * Only the capabilities that search are held to this. "Write the document
 * again" legitimately carries no input of its own — it works from what the
 * earlier steps produced.
 */
const NEEDS_A_QUERY = new Set(['academic.search', 'web.search', 'deep.research']);

export function isActionable(action: { capability: string; input?: Record<string, unknown> }): boolean {
  const capability = action.capability.trim();
  if (!capability) return false;
  if (!NEEDS_A_QUERY.has(capability)) return true;

  return Object.values(action.input ?? {}).some(
    (value) => value !== null && value !== undefined && String(value).trim().length > 0,
  );
}
