/**
 * The one definition of a PLS model.
 *
 * There were three. The builder had `BuilderConstruct`, the engine had
 * `LatentConstruct`, and the API route had a zod schema written to match both —
 * and the builder converted between them on submit. It worked, and it was a
 * standing invitation to drift: adding a field to the engine would leave the
 * other two silently behind, and the failure would surface as a model that
 * validated and then behaved unexpectedly.
 *
 * So the type and its runtime schema live here, and everything else imports
 * them. The builder edits this shape, the route parses into it, the engine
 * consumes it, and the conversational builder will produce it. A change made
 * here is a change everywhere, enforced by the compiler rather than by anyone
 * remembering.
 *
 * The one concession is `id` on a construct: the builder needs a stable key for
 * React while a construct is still unnamed, and the engine has no use for it.
 * It lives on an extension type rather than in the canonical shape, so the
 * engine never sees a field it does not understand.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*                                   Schema                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reflective or formative, and the distinction is not cosmetic.
 *
 * Reflective indicators are *caused by* the construct: several questions about
 * satisfaction all reflect one underlying feeling, so they should correlate and
 * dropping one loses little. Formative indicators *cause* it: price, location
 * and range together form "store attractiveness", they need not correlate at
 * all, and dropping one removes part of the definition.
 *
 * Every assessment criterion branches on this, because judging a formative
 * construct by reliability condemns it for the property that makes it
 * formative — among the most common serious errors in published PLS work.
 */
export const measurementModeSchema = z.enum(['reflective', 'formative']);
export type MeasurementMode = z.infer<typeof measurementModeSchema>;

export const latentConstructSchema = z.object({
  name: z.string().min(1).max(80),
  indicators: z.array(z.string().min(1)).min(1).max(30),
  mode: measurementModeSchema,
});

export type LatentConstruct = z.infer<typeof latentConstructSchema>;

export const structuralPathSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export type StructuralPath = z.infer<typeof structuralPathSchema>;

export const plsModelSchema = z.object({
  constructs: z.array(latentConstructSchema).min(2).max(20),
  paths: z.array(structuralPathSchema).min(1).max(100),
});

export type PlsModel = z.infer<typeof plsModelSchema>;

/**
 * A model still being edited.
 *
 * Deliberately looser than `PlsModel`: a construct being typed has no name yet
 * and no indicators, and a builder that refused to hold that state would be
 * unusable. The strict schema is applied at the boundary — when the model is
 * sent — which is where validity actually has to hold.
 */
export interface DraftConstruct {
  /** Stable across renames, so React keys survive editing. */
  id: string;
  name: string;
  indicators: string[];
  mode: MeasurementMode;
}

export interface PlsModelDraft {
  constructs: DraftConstruct[];
  paths: StructuralPath[];
}

/* -------------------------------------------------------------------------- */
/*                                Conversion                                  */
/* -------------------------------------------------------------------------- */

/**
 * A draft as the engine expects it.
 *
 * Trims names and drops the editing id. Returns null when the draft is not yet
 * a valid model — which is the normal state while it is being built, not an
 * error worth throwing over.
 */
export function draftToModel(draft: PlsModelDraft): PlsModel | null {
  const candidate = {
    constructs: draft.constructs.map((construct) => ({
      name: construct.name.trim(),
      indicators: construct.indicators,
      mode: construct.mode,
    })),
    paths: draft.paths,
  };

  const parsed = plsModelSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * A model as a draft, for editing something that already exists.
 *
 * Used when the conversational builder proposes a model and the researcher
 * opens it in the form to check it — which is the confirmation step that keeps
 * the model theirs rather than the assistant's.
 */
export function modelToDraft(model: PlsModel): PlsModelDraft {
  return {
    constructs: model.constructs.map((construct) => ({
      id: crypto.randomUUID(),
      name: construct.name,
      indicators: construct.indicators,
      mode: construct.mode,
    })),
    paths: model.paths,
  };
}

/* -------------------------------------------------------------------------- */
/*                             Structural checks                              */
/* -------------------------------------------------------------------------- */

export interface ModelIssue {
  key: string;
  params?: Record<string, string | number>;
}

/**
 * Every structural rule, in one place.
 *
 * Shared between the builder — which shows them as you type — and the engine,
 * which refuses on them. Previously the two had separate implementations of the
 * same rules, so a rule tightened in one could pass in the other.
 *
 * Returns every problem rather than the first, because a researcher fixing a
 * model one error at a time is being made to submit repeatedly for information
 * that was all available at once.
 */
export function validateModelStructure(draft: PlsModelDraft): ModelIssue[] {
  const issues: ModelIssue[] = [];

  if (draft.constructs.length < 2) {
    issues.push({ key: 'tooFewConstructs', params: { count: draft.constructs.length } });
  }

  const names = new Set<string>();
  const owners = new Map<string, string>();

  for (const construct of draft.constructs) {
    const name = construct.name.trim();

    if (!name) {
      issues.push({ key: 'unnamedConstruct' });
    } else if (names.has(name)) {
      issues.push({ key: 'duplicateName', params: { name } });
    } else {
      names.add(name);
    }

    if (construct.indicators.length === 0) {
      issues.push({ key: 'noIndicators', params: { name: name || '—' } });
    }

    for (const indicator of construct.indicators) {
      const owner = owners.get(indicator);
      /*
       * An indicator in two constructs makes their scores partly the same
       * variable. They will then correlate by construction, and discriminant
       * validity fails for a reason that has nothing to do with the data.
       */
      if (owner && owner !== name) {
        issues.push({ key: 'sharedIndicator', params: { indicator, first: owner, second: name } });
      }
      owners.set(indicator, name);
    }
  }

  if (draft.constructs.length >= 2 && draft.paths.length === 0) {
    issues.push({ key: 'noPaths' });
  }

  for (const path of draft.paths) {
    if (path.from === path.to) {
      issues.push({ key: 'selfPath', params: { construct: path.from } });
    }
    if (path.from && !names.has(path.from)) {
      issues.push({ key: 'unknownConstruct', params: { construct: path.from } });
    }
    if (path.to && !names.has(path.to)) {
      issues.push({ key: 'unknownConstruct', params: { construct: path.to } });
    }
  }

  const cycle = findCycle(draft);
  if (cycle) issues.push({ key: 'cycle', params: { cycle: cycle.join(' → ') } });

  return issues;
}

/**
 * A cycle in the path model.
 *
 * PLS requires a recursive model, and a cycle does not stop it: the algorithm
 * iterates, converges, and returns coefficients for something that cannot be
 * interpreted causally. Nothing downstream notices, which is why this check has
 * to exist rather than being left to fail naturally.
 */
export function findCycle(draft: PlsModelDraft): string[] | null {
  const successors = new Map<string, string[]>();

  for (const path of draft.paths) {
    const list = successors.get(path.from);
    if (list) list.push(path.to);
    else successors.set(path.from, [path.to]);
  }

  const visiting = new Set<string>();
  const settled = new Set<string>();
  const stack: string[] = [];

  function walk(node: string): string[] | null {
    if (visiting.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    if (settled.has(node)) return null;

    visiting.add(node);
    stack.push(node);

    for (const next of successors.get(node) ?? []) {
      const found = walk(next);
      if (found) return found;
    }

    visiting.delete(node);
    settled.add(node);
    stack.pop();
    return null;
  }

  for (const construct of draft.constructs) {
    const found = walk(construct.name.trim());
    if (found) return found;
  }

  return null;
}
