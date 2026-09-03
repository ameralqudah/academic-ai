/**
 * What each capability needs before it can run.
 *
 * Kept apart from the planner because this is arithmetic on a list of steps —
 * no model, no network, no database. Importing the planner pulls in the AI
 * service and through it the database, and a test checking that a review is
 * preceded by a search should not need a database to do it.
 *
 * That coupling has now appeared six times in this codebase. The pattern is
 * always the same: a module needs one small pure function, imports the module
 * that happens to contain it, and drags everything behind it.
 */

export interface PlannedStepShape {
  key: string;
  capability: string;
  label: string;
  dependsOn: string[];
  input: Record<string, unknown>;
}

/**
 * What each capability needs before it can run.
 *
 * A capability whose input comes from another step cannot be first in a plan.
 * Listing the alternatives rather than one producer matters: a review can be
 * fed by an academic search or by deep research, and demanding a specific one
 * would reject a valid plan.
 */
export const PREREQUISITES: Record<string, string[]> = {
  'literature.review': ['academic.search', 'deep.research'],
  'quality.check': ['document.write', 'literature.review', 'deep.research'],
  'citation.verify': ['academic.search', 'deep.research', 'literature.review', 'document.write'],
  'document.generate': ['document.write', 'literature.review', 'deep.research', 'survey.generate'],
};

/**
 * Adds a missing prerequisite, or links to one already planned.
 *
 * Two repairs, in order. If the plan contains a producer the step forgot to
 * depend on, the dependency is added — the commonest case, and free. Only when
 * no producer exists at all is a step inserted, because inserting one the
 * researcher did not ask for costs them time and a model call.
 */
export function repairPrerequisites(steps: PlannedStepShape[]): void {
  const byCapability = new Map<string, string>();
  for (const step of steps) byCapability.set(step.capability, step.key);

  const inserted: PlannedStepShape[] = [];

  for (const step of steps) {
    const needs = PREREQUISITES[step.capability];
    if (!needs) continue;

    /* Already satisfied by something it depends on, directly or otherwise. */
    const satisfied = step.dependsOn.some((key) => {
      const producer = steps.find((entry) => entry.key === key);
      return producer ? needs.includes(producer.capability) : false;
    });

    if (satisfied) continue;

    const existing = needs.map((capability) => byCapability.get(capability)).find(Boolean);

    if (existing) {
      /* The producer is in the plan; the step just failed to depend on it. */
      step.dependsOn.push(existing);
      continue;
    }

    /*
     * Nothing produces what this needs. One step is inserted — the first
     * alternative, which is the cheapest of them — rather than the task
     * stopping to ask for something it could have fetched.
     */
    const capability = needs[0] as string;
    const key = `auto_${capability.replace('.', '_')}`;

    if (byCapability.has(capability)) continue;

    inserted.push({
      key,
      capability,
      label: capability,
      dependsOn: [],
      /* The topic travels from the step that needed it. */
      input: step.input.topic ? { topic: step.input.topic } : { ...step.input },
    });

    byCapability.set(capability, key);
    step.dependsOn.push(key);
  }

  /* Prepended, so a prerequisite reads before the step that needs it. */
  steps.unshift(...inserted);
}

