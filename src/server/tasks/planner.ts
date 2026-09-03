/**
 * Turning a request into a plan.
 *
 * **Generic by construction.** There is no `ThesisPlanner` and no
 * `PaperPlanner`, because the moment one exists every new document type needs
 * another, and the planner becomes a switch statement over document types that
 * cannot handle "analyse my data and then write the results chapter". The
 * planner here knows only what capabilities exist and how to ask a model which
 * of them a request needs.
 *
 * **Adaptive, not fixed.** The initial plan is a starting point. A step that
 * discovers something — a search returning nothing, a dataset with a variable
 * the researcher did not mention — can cause steps to be added, and those
 * additions are rows like any other, traceable and persisted. Requiring the
 * whole plan up front would mean planning a literature review before knowing
 * what the literature contains.
 *
 * **The dependency graph is what makes it a plan rather than a list.** Writing
 * a results chapter depends on the analysis; the analysis depends on the file
 * being read. Sequence alone cannot express that two searches are independent
 * and both block the review that follows.
 */

import { logger } from '@/lib/logger';
import { runCompletion } from '@/server/services/ai.service';
import { resolveProvider } from '@/ai/registry';

import { allCapabilities, capabilityFor, isKnownCapability } from './capabilities';

export interface PlannedStep {
  /** A key the plan uses to express dependencies before ids exist. */
  key: string;
  capability: string;
  label: string;
  /** Keys of steps this one needs. */
  dependsOn: string[];
  /** Structured input. Values may reference `{{stepKey.field}}`. */
  input: Record<string, unknown>;
}

export interface Plan {
  steps: PlannedStep[];
  /** What the planner could not determine and must ask about. */
  missingInformation: string[];
  /** Its reading of the request, shown to the user before execution. */
  summary: string;
}

/**
 * Builds the initial plan.
 *
 * The model is given the capability list and asked which are needed and in what
 * order. It is not given the ability to invent one: a step naming an unknown
 * capability is dropped, because a plan containing work nothing can perform
 * fails halfway with the user having watched it start.
 */
export async function planTask(input: {
  userId: string;
  request: string;
  locale: 'ar' | 'en';
  /** What the task already has: a dataset, a project, earlier results. */
  context: Record<string, unknown>;
}): Promise<Plan> {
  const provider = await resolveProvider();

  const capabilities = allCapabilities()
    .map(
      (capability) =>
        `- ${capability.id}${capability.requiresDataset ? ' (needs an uploaded dataset)' : ''}`,
    )
    .join('\n');

  const hasDataset = Boolean(input.context.datasetId);

  const system = `You plan work for an academic research assistant.

Given a request, decide which steps are needed and how they depend on each other. Return JSON only:

{
  "summary": "<one sentence, in the user's language, describing what will be done>",
  "steps": [
    {
      "key": "<short identifier, e.g. search1>",
      "capability": "<one of the capabilities below>",
      "label": "<a short phrase in the user's language for the progress display>",
      "dependsOn": ["<keys of steps this needs>"],
      "input": { "<field>": "<value>" }
    }
  ],
  "missingInformation": ["<anything essential you cannot determine>"]
}

Capabilities:
${capabilities}

Rules:

1. Plan only what the request asks for. A question needs one step; a thesis needs many. Do not pad a simple request to look thorough, and do not compress a complex one to look efficient.

2. Dependencies are real constraints, not sequence. Two searches on different topics are independent and should both be listed with empty dependsOn; a chapter that uses their results depends on both. Getting this wrong makes the work slower or makes it use results that do not exist yet.

3. ${hasDataset ? 'A dataset is attached, so capabilities needing one may be used.' : 'No dataset is attached. Do not plan steps that need one; if the request requires data analysis, list that in missingInformation.'}

4. Never plan writing that presents findings before the step that produces them. A results chapter depends on the analysis, always.

5. missingInformation is for things you genuinely cannot infer and that would change the work — the topic when there is none, the analysis when several are possible. Do not ask about things you can reasonably assume; asking is a cost to the user.

6. Use at most 40 steps. If the request needs more, plan the first coherent portion and note the rest in summary.

7. FILE FORMATS. When the researcher asks for a file, the document.generate step must carry the format they asked for in its input:

   {"capability": "document.generate", "input": {"format": "docx", "title": "..."}}

   Recognise these, in either language:
   - Word, DOCX, ملف وورد, بصيغة وورد → "docx"
   - PDF, ملف PDF, بصيغة PDF → "pdf"
   - PowerPoint, presentation, عرض تقديمي, بوربوينت → "pptx"
   - Excel, spreadsheet, جدول بيانات, إكسل → "xlsx"
   - CSV, ملف CSV → "csv"
   - BibTeX, references file, ملف مراجع → "bib"
   - RIS, EndNote → "ris"
   - Nothing named → "md"

   If they ask for two formats — "Word and PDF" — plan two document.generate steps, both depending on the writing step.

   Omitting the format silently produces a Markdown file, which is not what someone asking for Word wanted and gives them no way to tell what happened.

8. A document.generate step must depend on the steps that produce its content. Generating a file before the writing that goes in it produces an empty document.`;

  const result = await runCompletion({
    userId: input.userId,
    projectId: '',
    provider,
    task: 'chat',
    locale: input.locale,
    system,
    messages: [
      {
        role: 'user',
        content: `Request: ${input.request}\n\nAvailable context: ${JSON.stringify(input.context)}`,
      },
    ],
    maxTokens: 2500,
    /* A plan should be the same twice for the same request. */
    temperature: 0,
    json: true,
  });

  const parsed = parsePlan(result.text);

  if (!parsed) {
    /*
     * A single general step rather than a failure.
     *
     * The planner not understanding a request is not a reason to refuse it —
     * the assistant can answer, and answering is better than telling someone
     * their request could not be planned.
     */
    logger.warn('task.plan.unparsable', { request: input.request.slice(0, 100) });

    return {
      steps: [
        {
          key: 'answer',
          capability: 'general.answer',
          label: input.locale === 'ar' ? 'الإجابة' : 'Answering',
          dependsOn: [],
          input: { question: input.request },
        },
      ],
      missingInformation: [],
      summary: input.request.slice(0, 200),
    };
  }

  logger.info('task.planned', {
    steps: parsed.steps.length,
    missing: parsed.missingInformation.length,
  });

  return parsed;
}

/**
 * Extends a plan while it runs.
 *
 * Called when a step's output implies work the initial plan did not contain —
 * a search that found a contradiction worth investigating, an analysis that
 * revealed a variable needing its own test. The new steps are ordinary rows,
 * marked as dynamic so the plan's history is legible.
 */
export async function planAdditionalSteps(input: {
  userId: string;
  locale: 'ar' | 'en';
  originalRequest: string;
  completedSteps: { capability: string; label: string; output: unknown }[];
  remainingSteps: { key: string; capability: string; label: string }[];
  /** Why more work might be needed, from the step that noticed. */
  trigger: string;
  /** Steps left in the budget. Zero means do not ask for more. */
  stepsAvailable: number;
}): Promise<PlannedStep[]> {
  if (input.stepsAvailable <= 0) return [];

  const provider = await resolveProvider();

  const capabilities = allCapabilities()
    .map((capability) => `- ${capability.id}`)
    .join('\n');

  const system = `You are extending a plan that is already running.

Return JSON only: {"steps": [ ... ]}, using the same step shape as a plan.

Capabilities:
${capabilities}

Rules:

1. Add steps only if they are genuinely needed. An empty array is the right answer more often than not — a plan that grows on every result never finishes.

2. At most ${input.stepsAvailable} steps. This is what remains of the budget.

3. New steps may depend on completed steps by their capability name, or on nothing.

4. Do not duplicate work already done or already planned.`;

  const result = await runCompletion({
    userId: input.userId,
    projectId: '',
    provider,
    task: 'chat',
    locale: input.locale,
    system,
    messages: [
      {
        role: 'user',
        content: [
          `Original request: ${input.originalRequest}`,
          `What triggered this: ${input.trigger}`,
          `Completed: ${input.completedSteps.map((step) => step.label).join('; ')}`,
          `Still planned: ${input.remainingSteps.map((step) => step.label).join('; ')}`,
        ].join('\n\n'),
      },
    ],
    maxTokens: 1200,
    temperature: 0,
    json: true,
  });

  const parsed = parsePlan(result.text);
  if (!parsed) return [];

  return parsed.steps.slice(0, input.stepsAvailable);
}

/**
 * Parses and validates a plan.
 *
 * Rejects rather than repairs anything structurally wrong: a plan with a
 * dependency on a step that does not exist would deadlock, and a plan with an
 * unknown capability fails at the moment the user is watching it run.
 */
function parsePlan(reply: string): Plan | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? reply).trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }

  if (!raw || typeof raw !== 'object') return null;

  const data = raw as { steps?: unknown; summary?: unknown; missingInformation?: unknown };
  if (!Array.isArray(data.steps)) return null;

  const seen = new Set<string>();
  const steps: PlannedStep[] = [];

  for (const entry of data.steps) {
    if (!entry || typeof entry !== 'object') continue;

    const step = entry as Record<string, unknown>;
    const key = typeof step.key === 'string' ? step.key.trim() : '';
    const capability = typeof step.capability === 'string' ? step.capability.trim() : '';

    if (!key || seen.has(key)) continue;

    /*
     * An unknown capability is dropped rather than the plan being rejected.
     * One bad step among eight should cost that step, not the whole plan —
     * and the executor will not silently substitute something else for it.
     */
    if (!isKnownCapability(capability)) {
      logger.info('task.plan.unknownCapability', { capability: capability.slice(0, 40) });
      continue;
    }

    seen.add(key);

    steps.push({
      key,
      capability,
      label: typeof step.label === 'string' ? step.label.slice(0, 200) : capability,
      dependsOn: Array.isArray(step.dependsOn)
        ? step.dependsOn.filter((value): value is string => typeof value === 'string')
        : [],
      input: (step.input as Record<string, unknown>) ?? {},
    });
  }

  if (steps.length === 0) return null;

  /*
   * Dependencies on steps that were dropped, or that never existed, are
   * removed. Left in place they would block the dependent step forever, and a
   * task that stops with no explanation is worse than one that runs a step
   * early.
   */
  for (const step of steps) {
    step.dependsOn = step.dependsOn.filter((key) => seen.has(key) && key !== step.key);
  }

  const cycle = findCycle(steps);

  if (cycle) {
    /*
     * A cycle deadlocks the executor: every step in it waits for another. The
     * plan is rejected rather than broken arbitrarily, because which edge to
     * cut is a judgement the planner should have made.
     */
    logger.warn('task.plan.cyclic', { cycle: cycle.join(' → ') });
    return null;
  }

  return {
    steps,
    summary: typeof data.summary === 'string' ? data.summary.slice(0, 500) : '',
    missingInformation: Array.isArray(data.missingInformation)
      ? data.missingInformation
          .filter((value): value is string => typeof value === 'string')
          .slice(0, 5)
      : [],
  };
}

/** A dependency cycle, if the plan contains one. */
export function findCycle(steps: PlannedStep[]): string[] | null {
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const visiting = new Set<string>();
  const settled = new Set<string>();
  const stack: string[] = [];

  function walk(key: string): string[] | null {
    if (visiting.has(key)) return [...stack.slice(stack.indexOf(key)), key];
    if (settled.has(key)) return null;

    visiting.add(key);
    stack.push(key);

    for (const dependency of byKey.get(key)?.dependsOn ?? []) {
      const found = walk(dependency);
      if (found) return found;
    }

    visiting.delete(key);
    settled.add(key);
    stack.pop();
    return null;
  }

  for (const step of steps) {
    const found = walk(step.key);
    if (found) return found;
  }

  return null;
}

/**
 * Steps whose dependencies are all satisfied.
 *
 * The scheduling primitive: everything returned can start now, and everything
 * returned is independent of everything else returned — which is what makes
 * parallel execution possible without the executor reasoning about it.
 */
export function readySteps<T extends { id: string; status: string; dependsOn: string[] }>(
  steps: T[],
): T[] {
  const byId = new Map(steps.map((step) => [step.id, step]));

  return steps.filter((step) => {
    if (step.status !== 'PENDING') return false;

    return step.dependsOn.every((id) => byId.get(id)?.status === 'COMPLETED');
  });
}

/**
 * Steps that can never run because something they need failed.
 *
 * Distinguished from merely waiting: a step whose dependency failed is blocked
 * permanently, and reporting it as pending would leave a task apparently stuck
 * with no explanation.
 */
export function blockedSteps<T extends { id: string; status: string; dependsOn: string[] }>(
  steps: T[],
): T[] {
  const byId = new Map(steps.map((step) => [step.id, step]));

  const failedOrBlocked = (id: string, depth = 0): boolean => {
    if (depth > 50) return false;

    const step = byId.get(id);
    if (!step) return false;
    if (step.status === 'FAILED' || step.status === 'BLOCKED') return true;

    return step.dependsOn.some((parent) => failedOrBlocked(parent, depth + 1));
  };

  return steps.filter(
    (step) => step.status === 'PENDING' && step.dependsOn.some((id) => failedOrBlocked(id)),
  );
}

export { capabilityFor };
