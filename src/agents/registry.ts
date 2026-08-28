/**
 * What the agent can actually do.
 *
 * This file is the honesty mechanism of the whole agent layer, and it is worth
 * being explicit about why it exists rather than letting the orchestrator work
 * out its own abilities.
 *
 * A chat interface invites people to ask for anything. "Run a PLS-SEM on this",
 * "write my literature review with real citations", "do a logistic regression".
 * Some of those this product does well, some it does not do at all, and the gap
 * between the two is invisible to the person typing. A language model asked to
 * handle a request it has no engine for does not stop — it produces something
 * that looks like an answer. In a research tool that means fabricated
 * coefficients ending up in a thesis.
 *
 * So capability is data, declared here, and the orchestrator can only route to
 * what this catalogue contains. An intent outside it produces a plain "not
 * available yet", naming what is missing, rather than an improvisation. The
 * same discipline already exists one layer down: `recommend.ts` returns
 * Mann–Whitney as the right test while marking it unbuilt, instead of promoting
 * a t-test that would run.
 *
 * Adding a capability means adding an entry here and an executor beside it.
 * Nothing else in the agent needs to change — which is the point.
 */

import type { AnalysisTestKey } from '@/server/services/statistics.service';

/* -------------------------------------------------------------------------- */
/*                                  Intents                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every intent the classifier may return.
 *
 * The union is closed on purpose: the classifier is given this exact list and
 * anything it invents is rejected rather than passed along. A model that
 * hallucinates an intent name should fail loudly at the boundary, not produce a
 * runtime error three layers in.
 */
export type IntentKey =
  // Data
  | 'data.inspect'
  | 'data.clean'
  | 'data.describe'
  // Statistics
  | 'stats.recommend'
  | 'stats.reliability'
  | 'stats.compare'
  | 'stats.relate'
  | 'stats.predict'
  | 'stats.categorical'
  // Research writing
  | 'research.plan'
  | 'research.section'
  | 'research.results'
  | 'research.survey'
  // Advanced modelling
  | 'stats.plsSem'
  | 'stats.cbSem'
  | 'stats.logistic'
  | 'stats.nonparametric'
  // Literature — searching real academic databases
  | 'research.literature'
  // Conversation
  | 'general.question'
  | 'general.unclear';

export type CapabilityStatus =
  /** Built, tested, and callable today. */
  | 'available'
  /** Recognised and deliberately not built. The user is told which and why. */
  | 'planned'
  /** Not a task — a question to answer or a request to clarify. */
  | 'conversational';

export interface Capability {
  intent: IntentKey;
  status: CapabilityStatus;
  /** Which agent handles it. */
  agent: 'data' | 'statistics' | 'research' | 'conversation';
  /** Needs a dataset in the conversation before it can run. */
  requiresDataset: boolean;
  /** Statistical engines this intent may reach for, when it is a stats intent. */
  tests?: AnalysisTestKey[];
  /**
   * Weight in task units, for the shadow meter.
   *
   * Statistical work is zero because it costs no model calls — it is arithmetic
   * running on the server. That is a fact about the architecture rather than a
   * promotion, and it should stay true: the moment an analysis needs a model to
   * produce a number, something has gone wrong.
   */
  units: number;
  /** Roughly how many model calls this takes, for the pre-flight estimate. */
  estimatedCalls: number;
  /** Message key explaining what is missing, for `planned` capabilities. */
  unavailableReason?: string;
}

/* -------------------------------------------------------------------------- */
/*                                 The catalogue                              */
/* -------------------------------------------------------------------------- */

export const CAPABILITIES: Record<IntentKey, Capability> = {
  /* ------------------------------- data ---------------------------------- */

  'data.inspect': {
    intent: 'data.inspect',
    status: 'available',
    agent: 'data',
    requiresDataset: true,
    units: 0,
    estimatedCalls: 0,
  },
  'data.clean': {
    intent: 'data.clean',
    status: 'available',
    agent: 'data',
    requiresDataset: true,
    units: 0,
    estimatedCalls: 0,
  },
  'data.describe': {
    intent: 'data.describe',
    status: 'available',
    agent: 'data',
    requiresDataset: true,
    units: 0,
    estimatedCalls: 0,
  },

  /* ---------------------------- statistics -------------------------------- */

  'stats.recommend': {
    intent: 'stats.recommend',
    status: 'available',
    agent: 'statistics',
    requiresDataset: true,
    units: 0,
    estimatedCalls: 0,
  },
  'stats.reliability': {
    intent: 'stats.reliability',
    status: 'available',
    agent: 'statistics',
    requiresDataset: true,
    tests: ['reliability.cronbachAlpha'],
    units: 0,
    estimatedCalls: 0,
  },
  /** Differences between groups: t-tests and one-way ANOVA. */
  'stats.compare': {
    intent: 'stats.compare',
    status: 'available',
    agent: 'statistics',
    requiresDataset: true,
    tests: ['t.oneSample', 't.independent', 't.paired', 'anova.oneWay'],
    units: 0,
    estimatedCalls: 0,
  },
  /** Association between variables: correlation, and the correlation matrix. */
  'stats.relate': {
    intent: 'stats.relate',
    status: 'available',
    agent: 'statistics',
    requiresDataset: true,
    tests: ['correlation.pearson', 'correlation.spearman', 'correlation.matrix'],
    units: 0,
    estimatedCalls: 0,
  },
  'stats.predict': {
    intent: 'stats.predict',
    status: 'available',
    agent: 'statistics',
    requiresDataset: true,
    tests: ['regression.ols'],
    units: 0,
    estimatedCalls: 0,
  },
  'stats.categorical': {
    intent: 'stats.categorical',
    status: 'available',
    agent: 'statistics',
    requiresDataset: true,
    tests: ['chiSquare.independence', 'chiSquare.goodnessOfFit'],
    units: 0,
    estimatedCalls: 0,
  },

  /* ------------------------------ research -------------------------------- */

  'research.plan': {
    intent: 'research.plan',
    status: 'available',
    agent: 'research',
    requiresDataset: false,
    units: 5,
    estimatedCalls: 6,
  },
  'research.section': {
    intent: 'research.section',
    status: 'available',
    agent: 'research',
    requiresDataset: false,
    units: 2,
    estimatedCalls: 1,
  },
  /**
   * Writing the results chapter from analyses the researcher attached.
   *
   * Available now that the wiring exists: attached results are formatted as
   * facts and travel into the prompt, so the model describes figures it was
   * given rather than producing figures of its own. That distinction is the
   * whole feature — asked to write a results chapter with no results, a model
   * writes a convincing one anyway, and a committee reads numbers describing a
   * study nobody ran.
   *
   * `requiresDataset` is false because the requirement is attached *analyses*,
   * not a file still in the conversation. A researcher who analysed their data
   * last week and comes back to write the chapter should not have to re-upload
   * anything.
   */
  'research.results': {
    intent: 'research.results',
    status: 'available',
    agent: 'research',
    requiresDataset: false,
    units: 3,
    estimatedCalls: 1,
  },
  /**
   * Searching the academic databases for real studies.
   *
   * Separate from `research.plan` and from `general.question` because it is the
   * one intent that must never be answered from the model's memory. A model
   * asked for studies on a topic will produce a list of plausible-looking
   * titles with plausible-looking authors, and a student will cite them. This
   * intent exists so that request is routed to Crossref and OpenAlex instead,
   * and comes back with DOIs that resolve.
   *
   * Costs one unit rather than zero: the search itself is free, but composing
   * the answer from what came back takes a model call.
   */
  'research.literature': {
    intent: 'research.literature',
    status: 'available',
    agent: 'research',
    requiresDataset: false,
    units: 1,
    estimatedCalls: 1,
  },

  'research.survey': {
    intent: 'research.survey',
    status: 'planned',
    agent: 'research',
    requiresDataset: false,
    units: 2,
    estimatedCalls: 1,
    unavailableReason: 'agent.unavailable.surveyGenerator',
  },

  /* --------------------------- advanced modelling ------------------------- */

  'stats.plsSem': {
    intent: 'stats.plsSem',
    status: 'planned',
    agent: 'statistics',
    requiresDataset: true,
    units: 0,
    estimatedCalls: 0,
    unavailableReason: 'agent.unavailable.plsSem',
  },
  'stats.cbSem': {
    intent: 'stats.cbSem',
    status: 'planned',
    agent: 'statistics',
    requiresDataset: true,
    units: 0,
    estimatedCalls: 0,
    unavailableReason: 'agent.unavailable.cbSem',
  },
  'stats.logistic': {
    intent: 'stats.logistic',
    status: 'planned',
    agent: 'statistics',
    requiresDataset: true,
    units: 0,
    estimatedCalls: 0,
    unavailableReason: 'agent.unavailable.logistic',
  },
  /**
   * The non-parametric family. Recognised because the recommender already names
   * these tests when an assumption fails — an agent that could not even name
   * what it was declining would be worse than one that says "Mann–Whitney is
   * what you need, and it is not built yet".
   */
  'stats.nonparametric': {
    intent: 'stats.nonparametric',
    status: 'planned',
    agent: 'statistics',
    requiresDataset: true,
    units: 0,
    estimatedCalls: 0,
    unavailableReason: 'agent.unavailable.nonparametric',
  },

  /* ---------------------------- conversation ------------------------------ */

  'general.question': {
    intent: 'general.question',
    status: 'conversational',
    agent: 'conversation',
    requiresDataset: false,
    units: 1,
    estimatedCalls: 1,
  },
  'general.unclear': {
    intent: 'general.unclear',
    status: 'conversational',
    agent: 'conversation',
    requiresDataset: false,
    units: 0,
    estimatedCalls: 0,
  },
};

/* -------------------------------------------------------------------------- */
/*                                  Queries                                   */
/* -------------------------------------------------------------------------- */

export const INTENT_KEYS = Object.keys(CAPABILITIES) as IntentKey[];

export function capabilityFor(intent: IntentKey): Capability {
  return CAPABILITIES[intent];
}

export function isKnownIntent(value: string): value is IntentKey {
  return value in CAPABILITIES;
}

export function isAvailable(intent: IntentKey): boolean {
  return CAPABILITIES[intent].status === 'available';
}

/** Everything the product can do today — the honest answer to "what can you do". */
export function availableCapabilities(): Capability[] {
  return INTENT_KEYS.map(capabilityFor).filter((capability) => capability.status === 'available');
}

/** Recognised but unbuilt, so the interface can say what is coming. */
export function plannedCapabilities(): Capability[] {
  return INTENT_KEYS.map(capabilityFor).filter((capability) => capability.status === 'planned');
}

/**
 * The list handed to the classifier.
 *
 * Includes the planned intents deliberately. Classifying a PLS-SEM request
 * correctly and then declining it is a far better answer than misclassifying it
 * as a regression and running one — the user learns what the product does not
 * do, instead of receiving the wrong analysis.
 */
export function classifiableIntents(): { intent: IntentKey; requiresDataset: boolean }[] {
  return INTENT_KEYS.map((intent) => ({
    intent,
    requiresDataset: CAPABILITIES[intent].requiresDataset,
  }));
}
