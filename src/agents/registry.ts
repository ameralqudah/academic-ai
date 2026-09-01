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
  /** A question answered from web pages the agent found and read. */
  | 'research.web'
  /** A multi-step review: planned sub-questions, parallel search, synthesis. */
  | 'research.deep'
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

  'research.web': {
    intent: 'research.web',
    status: 'available',
    agent: 'research',
    requiresDataset: false,
    /*
     * One unit, like a literature search. It costs a provider credit and up to
     * five page fetches, which is more work than a chat turn and comparable to
     * the academic search that is already priced this way.
     */
    units: 1,
    estimatedCalls: 1,
  },

  /**
   * Deep research runs many searches and several model calls, so it is priced
   * well above a single search. The figure is an estimate: the workflow
   * branches on what it finds, and a question needing a second round of
   * searching costs more than one that does not.
   */
  'research.deep': {
    intent: 'research.deep',
    status: 'available',
    agent: 'research',
    requiresDataset: false,
    units: 5,
    estimatedCalls: 8,
  },

  /**
   * Built. Produces a questionnaire draft with coded items, a consistent scale,
   * demographics and the steps a researcher must take before administering it.
   *
   * Priced like other writing capabilities because it is one: a model writes
   * the items, and the measurement rules live in the prompt around them. What
   * it does not produce is a validated instrument, and the output says so.
   */
  'research.survey': {
    intent: 'research.survey',
    status: 'available',
    agent: 'research',
    requiresDataset: false,
    units: 2,
    estimatedCalls: 1,
    unavailableReason: 'agent.unavailable.surveyGenerator',
  },

  /* --------------------------- advanced modelling ------------------------- */

  /**
   * Built. The engine, the assessment, bootstrapping, the report and the export
   * all exist; this said `planned` while they did, so the agent declined a
   * capability the product had.
   *
   * Free, like every other statistical capability, and for the reason they all
   * are: it makes no model calls. PLS is arithmetic — an iterative estimation
   * over a correlation matrix — and a guard in the smoke tests asserts that
   * nothing under the statistics agent costs units, precisely so that an
   * analysis quietly acquiring a dependency on a language model would fail.
   *
   * Pricing it at one unit was inconsistent with that and would have set a
   * precedent for the rest. The compute cost of bootstrapping is real and is
   * charged by the service as a tool run, which is a different meter from the
   * AI units this field describes.
   */
  'stats.plsSem': {
    intent: 'stats.plsSem',
    status: 'available',
    agent: 'statistics',
    requiresDataset: true,
    units: 0,
    estimatedCalls: 0,
  },
  /**
   * Built as confirmatory factor analysis — the measurement half of CB-SEM.
   *
   * The structural half, where latent factors predict one another with fit
   * indices, is not built. That is a real limitation and is stated to the
   * researcher rather than implied by the capability being listed: what this
   * runs is a measurement model, and a request for a full structural CB-SEM
   * gets the measurement model plus a note about what is missing.
   *
   * Free, like every statistical capability, because it makes no model calls.
   */
  'stats.cbSem': {
    intent: 'stats.cbSem',
    status: 'available',
    agent: 'statistics',
    requiresDataset: true,
    units: 0,
    estimatedCalls: 0,
    unavailableReason: 'agent.unavailable.cbSem',
  },
  /**
   * Built. A great deal of education and management research asks whether
   * something happened — passed, continued, adopted — and linear regression is
   * invalid for it. The recommender has been naming this and declining to run
   * it since it was written.
   */
  'stats.logistic': {
    intent: 'stats.logistic',
    status: 'available',
    agent: 'statistics',
    requiresDataset: true,
    tests: ['regression.logistic'],
    units: 0,
    estimatedCalls: 0,
  },
  /**
   * The non-parametric family. Recognised because the recommender already names
   * these tests when an assumption fails — an agent that could not even name
   * what it was declining would be worse than one that says "Mann–Whitney is
   * what you need, and it is not built yet".
   */
  /**
   * Built now. The recommender has been naming these tests and declining to run
   * them since it was written — "Mann–Whitney is what you need, and it is not
   * available" — which was honest and useless. It can now run what it
   * recommends.
   */
  'stats.nonparametric': {
    intent: 'stats.nonparametric',
    status: 'available',
    agent: 'statistics',
    requiresDataset: true,
    tests: [
      'nonparametric.mannWhitney',
      'nonparametric.wilcoxon',
      'nonparametric.kruskalWallis',
    ],
    units: 0,
    estimatedCalls: 0,
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
