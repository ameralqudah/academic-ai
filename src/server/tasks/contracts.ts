/**
 * What a capability produces, and how the next step finds it.
 *
 * The contract this replaces was name-based: a step wanting search results
 * asked for `dependencies['academic.search']`. That works and is brittle in a
 * way that fails silently — rename the capability, or let deep research produce
 * the sources instead of an academic search, and the consumer reads `undefined`
 * and writes a literature review from nothing. Nothing throws; the review is
 * just empty of evidence.
 *
 * So a step declares what it needs by **data type**: `sources.v1`, not the name
 * of whoever produced it. Two capabilities can satisfy one requirement, a
 * capability can be renamed, and the consumer keeps working.
 *
 * **Provenance travels with every output.** For an academic product this is not
 * bookkeeping: a claim in a generated chapter must be traceable to the search
 * that found it and the step that wrote it, or the researcher cannot defend it.
 */

/* -------------------------------------------------------------------------- */
/*                                Output types                                */
/* -------------------------------------------------------------------------- */

/**
 * The data types capabilities exchange.
 *
 * Deliberately few. A type earns its place by having more than one producer or
 * more than one consumer; anything else is a payload that belongs inside a
 * result rather than a type in this list.
 *
 * The `.v1` suffix is the schema version. A breaking change becomes `.v2` and
 * both exist until consumers move — which is the whole versioning story, and
 * enough of one. A migration framework here would be machinery for a problem
 * this product does not yet have.
 */
export type OutputType =
  /** Retrieved sources: academic search, web search, deep research. */
  | 'sources.v1'
  /** A synthesised review of literature. */
  | 'literature.v1'
  /** What the literature does not answer. */
  | 'research-gap.v1'
  /** A conceptual framework: constructs and their proposed relations. */
  | 'framework.v1'
  /** Testable hypotheses. */
  | 'hypotheses.v1'
  /** A dataset's shape: columns, types, quality. */
  | 'dataset.v1'
  /** Any statistical result, with its own payload inside. */
  | 'analysis.v1'
  /** A proposed PLS model, before the researcher confirms it. */
  | 'pls-model.v1'
  /** Estimated PLS results. */
  | 'pls-results.v1'
  /** Written text, for a document or a chapter. */
  | 'prose.v1'
  /** References with their verification status. */
  | 'citations.v1'
  /** The quality engine's structured verdict. */
  | 'quality-report.v1'
  /** A generated file. */
  | 'artifact.v1'
  /** A survey instrument. */
  | 'survey.v1'
  /** Anything a capability produces that no other consumes. */
  | 'generic.v1';

/**
 * A produced output, addressable by type.
 *
 * `data` holds the payload for small results. Large ones — a dataset profile, a
 * bootstrap distribution — already have somewhere to live, and `location`
 * points there instead: duplicating a megabyte into every reference would make
 * a task's row unreadable and its history unqueryable.
 */
export interface OutputReference {
  id: string;
  type: OutputType;
  schemaVersion: number;

  /** Where it came from. Not optional: an untraceable claim is unusable. */
  producedBy: {
    taskId: string;
    stepId: string;
    capability: string;
  };

  projectId: string | null;
  createdAt: string;

  /** The payload, for outputs small enough to carry. */
  data?: unknown;
  /** A pointer, for outputs that already live somewhere. */
  location?: {
    kind: 'artifact' | 'dataset' | 'analysis-run' | 'conversation';
    id: string;
  };

  /** Anything a consumer needs to decide whether this is the right output. */
  metadata?: Record<string, string | number | boolean>;
}

/* -------------------------------------------------------------------------- */
/*                                  Findings                                  */
/* -------------------------------------------------------------------------- */

/**
 * A structured warning or error.
 *
 * Free-form strings are unusable for a decision: a replanner cannot tell "no
 * sources found" from "provider timed out" by reading prose, and the two need
 * opposite responses — one wants a different query, the other wants a retry.
 */
export interface Finding {
  /** A stable key the planner branches on and the interface translates. */
  code: string;
  severity: 'error' | 'warning' | 'info';
  /** For a human. The planner reads `code`. */
  message: string;
  /** What it concerns: a reference id, a column, a step. */
  reference?: string;
  metadata?: Record<string, string | number | boolean>;
}

/* -------------------------------------------------------------------------- */
/*                                Observation                                 */
/* -------------------------------------------------------------------------- */

/**
 * What a step reports back.
 *
 * Replaces a free-text `suggestsMoreWork` that the planner could only pass to a
 * model and hope. A structured observation lets the executor decide without a
 * model call — a `needs-input` pauses the task, a `failed` with a retryable
 * code retries — and lets the replanner reason about what specifically went
 * wrong.
 */
export interface Observation {
  /**
   * `partial` is the state the old contract could not express: a search that
   * found three sources when it wanted ten succeeded and did not do the job,
   * and treating it as success writes a review on three sources.
   */
  status: 'success' | 'partial' | 'failed' | 'needs-input';

  outputs: OutputReference[];
  artifacts: ArtifactReference[];

  /**
   * Claims and what supports them.
   *
   * The academic integrity hook: a step that asserts something names the
   * sources it rests on, and the chain survives into the final document.
   */
  evidence: { claim: string; sourceIds: string[] }[];

  warnings: Finding[];
  errors: Finding[];

  /** What the step could not determine. Drives replanning or a question. */
  missingInformation: string[];

  /** 0–1. Below a threshold the planner may verify rather than proceed. */
  confidence: number;

  /**
   * What the step thinks should happen next.
   *
   * Structured so the planner can act on it directly: a search that found a
   * contradiction can name the capability that would resolve it rather than
   * describing the problem in prose.
   */
  recommendedNextActions: {
    capability: string;
    reason: string;
    input?: Record<string, unknown>;
  }[];

  /** Present only when `status` is `needs-input`. */
  requiresUserInput?: {
    question: string;
    /** The context key the answer fills, so resuming knows where to put it. */
    field: string;
  };

  /** Model calls made, counted against the task budget. */
  modelCalls?: number;
}

export interface ArtifactReference {
  id: string;
  kind: string;
  filename: string;
  /** The quality verdict as generated, so a file's state travels with it. */
  validationStatus: string;
}

/* -------------------------------------------------------------------------- */
/*                              Consumer contract                             */
/* -------------------------------------------------------------------------- */

/**
 * What a step needs before it can run.
 *
 * By type rather than by producer. A literature review needs `sources.v1` and
 * does not care whether an academic search or a deep research run produced
 * them — which is exactly the substitution the old contract made impossible.
 */
export interface Requirement {
  type: OutputType;
  /** False when the step can proceed without it, in reduced form. */
  required: boolean;
  /**
   * Narrows which output satisfies this, when several are present.
   *
   * A chapter that needs the results of one particular analysis rather than
   * any analysis names the step that produced them.
   */
  fromStepId?: string;
}

/**
 * Finds the outputs that satisfy a requirement.
 *
 * Most recent first, because a step that ran twice — a retry, a replan —
 * produced a better answer the second time.
 */
export function resolveRequirement(
  requirement: Requirement,
  available: OutputReference[],
): OutputReference[] {
  return available
    .filter((output) => {
      if (output.type !== requirement.type) return false;
      if (requirement.fromStepId && output.producedBy.stepId !== requirement.fromStepId) {
        return false;
      }
      return true;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Whether every required input is available.
 *
 * Returns the unmet requirements rather than a boolean: a step blocked on two
 * missing inputs should say which two, and the planner needs them to decide
 * what to add.
 */
export function unmetRequirements(
  requirements: Requirement[],
  available: OutputReference[],
): Requirement[] {
  return requirements.filter(
    (requirement) =>
      requirement.required && resolveRequirement(requirement, available).length === 0,
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Building                                  */
/* -------------------------------------------------------------------------- */

export interface ProducerContext {
  taskId: string;
  stepId: string;
  capability: string;
  projectId: string | null;
}

/** An output reference with its provenance filled in. */
export function makeOutput(
  producer: ProducerContext,
  type: OutputType,
  data: unknown,
  extra: { location?: OutputReference['location']; metadata?: OutputReference['metadata'] } = {},
): OutputReference {
  return {
    id: crypto.randomUUID(),
    type,
    /* Parsed from the type, so the two cannot disagree. */
    schemaVersion: Number(type.split('.v')[1] ?? 1),
    producedBy: {
      taskId: producer.taskId,
      stepId: producer.stepId,
      capability: producer.capability,
    },
    projectId: producer.projectId,
    createdAt: new Date().toISOString(),
    data,
    ...extra,
  };
}

/**
 * A successful observation.
 *
 * The common case, with sensible defaults — a handler reporting success should
 * not have to write eight empty fields.
 */
export function succeeded(
  outputs: OutputReference[],
  extra: Partial<Observation> = {},
): Observation {
  return {
    status: 'success',
    outputs,
    artifacts: [],
    evidence: [],
    warnings: [],
    errors: [],
    missingInformation: [],
    confidence: 1,
    recommendedNextActions: [],
    ...extra,
  };
}

/**
 * A step that did some of its job.
 *
 * Distinct from success because the difference matters downstream: three
 * sources where ten were wanted is a review the researcher should not submit,
 * and the planner can decide to search again.
 */
export function partial(
  outputs: OutputReference[],
  missing: string[],
  extra: Partial<Observation> = {},
): Observation {
  return {
    status: 'partial',
    outputs,
    artifacts: [],
    evidence: [],
    warnings: [],
    errors: [],
    missingInformation: missing,
    confidence: 0.5,
    recommendedNextActions: [],
    ...extra,
  };
}

export function failed(errors: Finding[], extra: Partial<Observation> = {}): Observation {
  return {
    status: 'failed',
    outputs: [],
    artifacts: [],
    evidence: [],
    warnings: [],
    errors,
    missingInformation: [],
    confidence: 0,
    recommendedNextActions: [],
    ...extra,
  };
}

/**
 * A step that cannot proceed without the researcher.
 *
 * Reserved for what genuinely cannot be inferred — a PLS model is the
 * researcher's theory, and proposing one is useful while assuming one is not.
 * Asking is a cost, and a step that asks when it could have decided wastes the
 * researcher's attention.
 */
export function needsInput(
  question: string,
  field: string,
  extra: Partial<Observation> = {},
): Observation {
  return {
    status: 'needs-input',
    outputs: [],
    artifacts: [],
    evidence: [],
    warnings: [],
    errors: [],
    missingInformation: [question],
    confidence: 0,
    recommendedNextActions: [],
    requiresUserInput: { question, field },
    ...extra,
  };
}

/* -------------------------------------------------------------------------- */
/*                           Reading typed outputs                            */
/* -------------------------------------------------------------------------- */

/**
 * The payload of the newest output of a type.
 *
 * The consumer-side helper, and the whole point of the exercise: a handler asks
 * for `sources.v1` and does not name who produced it.
 */
export function readOutput<T>(available: OutputReference[], type: OutputType): T | null {
  const matches = resolveRequirement({ type, required: false }, available);
  return matches.length > 0 ? ((matches[0]?.data ?? null) as T) : null;
}

/** Every payload of a type, for a consumer that merges several producers. */
export function readAllOutputs<T>(available: OutputReference[], type: OutputType): T[] {
  return resolveRequirement({ type, required: false }, available)
    .map((output) => output.data)
    .filter((data): data is T => data !== undefined && data !== null);
}

/**
 * The provenance chain behind an output.
 *
 * Walks back through the steps that produced what this rests on. For an
 * academic product this is the difference between a citation a researcher can
 * defend and one they cannot account for.
 */
export function provenanceChain(
  output: OutputReference,
  all: OutputReference[],
): { capability: string; stepId: string; type: OutputType }[] {
  const chain: { capability: string; stepId: string; type: OutputType }[] = [
    { capability: output.producedBy.capability, stepId: output.producedBy.stepId, type: output.type },
  ];

  /*
   * Sources referenced in metadata are followed. Deliberately shallow — a full
   * graph walk would need edges this does not store, and the immediate
   * ancestry answers the question a researcher actually asks: where did this
   * come from.
   */
  const sourceIds = output.metadata?.derivedFrom;

  if (typeof sourceIds === 'string') {
    for (const id of sourceIds.split(',')) {
      const parent = all.find((entry) => entry.id === id.trim());
      if (!parent) continue;

      chain.push({
        capability: parent.producedBy.capability,
        stepId: parent.producedBy.stepId,
        type: parent.type,
      });
    }
  }

  return chain;
}
