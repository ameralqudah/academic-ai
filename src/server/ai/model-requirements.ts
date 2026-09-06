/**
 * What a step needs from a model, and which failures are worth retrying
 * elsewhere.
 *
 * Pure decisions, separated from the router because that imports the provider
 * registry and through it the database — and a test asking whether a literature
 * review is reasoning work should not need a database to answer.
 *
 * That coupling has now appeared ten times in this codebase. The pattern never
 * varies: a module needs one small pure function, imports the module that
 * happens to contain it, and drags everything behind it.
 */

import { capabilityFor } from '@/server/tasks/capabilities';

/**
 * What a step needs from a model.
 *
 * Derived from the capability and the step rather than declared per call site:
 * a capability knows whether it reasons or retrieves, and the step knows how
 * much text it carries. Scattering model names through handlers is what this
 * replaces.
 */
export interface ModelRequirements {
  /** The capability being executed. */
  capability: string;
  /** Roughly how much context the call will carry, in tokens. */
  contextTokens: number;
  /** Whether the work needs multi-step reasoning rather than extraction. */
  needsReasoning: boolean;
  /** Roughly how much output is expected, in tokens. */
  expectedOutputTokens: number;
  /** Whether a person is waiting on this answer right now. */
  latencySensitive: boolean;
}


/**
 * What each capability asks of a model.
 *
 * Held here rather than in the handlers so that adding a model changes one
 * file. A handler that named its own model would have to be found and edited
 * every time the model list changed, which is how model names end up scattered
 * and inconsistent.
 */
const CAPABILITY_PROFILE: Record<string, Partial<ModelRequirements>> = {
  'general.answer': { needsReasoning: false, latencySensitive: true, expectedOutputTokens: 800 },
  'web.search': { needsReasoning: false, latencySensitive: true, expectedOutputTokens: 400 },
  'academic.search': { needsReasoning: false, latencySensitive: true, expectedOutputTokens: 400 },

  /* Long synthesis over many sources. Reasoning, and a lot of output. */
  'literature.review': { needsReasoning: true, expectedOutputTokens: 6000, latencySensitive: false },
  'deep.research': { needsReasoning: true, expectedOutputTokens: 8000, latencySensitive: false },
  'document.write': { needsReasoning: true, expectedOutputTokens: 6000, latencySensitive: false },

  /* Structured judgement over a defined input. */
  'quality.check': { needsReasoning: true, expectedOutputTokens: 1500 },
  'citation.verify': { needsReasoning: false, expectedOutputTokens: 800 },
  'survey.generate': { needsReasoning: true, expectedOutputTokens: 3000 },

  /*
   * Statistics run in the engines. The model interprets a result rather than
   * computing one, so the output is short and the reasoning is real.
   */
  'statistics.run': { needsReasoning: true, expectedOutputTokens: 1200 },
  'statistics.pls': { needsReasoning: true, expectedOutputTokens: 2000 },
  'statistics.cbsem': { needsReasoning: true, expectedOutputTokens: 2000 },
  'file.analyse': { needsReasoning: false, expectedOutputTokens: 1500 },

  /* No model at all: the generator writes bytes. */
  'document.generate': { needsReasoning: false, expectedOutputTokens: 0, latencySensitive: true },
};


/**
 * The requirements of a step, from its capability and its inputs.
 *
 * A default profile covers a capability that has none, so adding a capability
 * does not require touching this file before it can run.
 */
export function requirementsFor(input: {
  capability: string;
  contextTokens?: number;
}): ModelRequirements {
  const profile = CAPABILITY_PROFILE[input.capability] ?? {};
  const capability = capabilityFor(input.capability);

  return {
    capability: input.capability,
    contextTokens: input.contextTokens ?? 2000,
    needsReasoning: profile.needsReasoning ?? true,
    expectedOutputTokens: profile.expectedOutputTokens ?? 2000,
    /*
     * A capability with a short timeout is one someone is waiting on. Read from
     * the registry rather than repeated here, so the two cannot disagree.
     */
    latencySensitive: profile.latencySensitive ?? (capability?.timeoutMs ?? 0) < 60_000,
  };
}


/**
 * Whether a failure is worth trying another provider for.
 *
 * A quota, an outage or a timeout is about the provider and says nothing about
 * the request — another provider may well succeed. A refusal or a malformed
 * request would fail identically everywhere, and retrying it elsewhere spends
 * a second call to receive the same answer.
 */
export function shouldFailOver(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number })?.status;

  if (status === 429 || status === 503 || status === 502 || status === 504) return true;

  return /quota|rate.?limit|timeout|unavailable|overloaded|ECONNRESET|ETIMEDOUT/i.test(detail);
}


