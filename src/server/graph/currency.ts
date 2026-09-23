/**
 * Currency and verification: can this object be presented as current, and are
 * the numbers it shows computationally verified? (P1-A review F-2, F-3, F-6.)
 *
 * Stale marks record what a *change* did. Currency is what a reader needs: an
 * object is only as current as the worst thing it rests on. A block whose own
 * marks are resolved is still not current if the value it reports came from a
 * superseded run, or from a run on data that has since been invalidated. This
 * is computed on read from the dependency graph — it cannot drift out of date,
 * and no action can "accept" it away.
 *
 * Pure: the caller supplies the loaders, like `impact.ts`.
 */

import { ruleFor } from './rules';
import { RESULT_TYPES, type NodeType } from './types';

export interface CurrencyNode {
  id: string;
  type: string;
  status: string;
  provenance: string | null;
  /** Open (unresolved) marks. `info` marks never affect currency. */
  openMarks: { severity: string; kind: string }[];
}

export interface CurrencyEdge {
  srcId: string;
  rel: string;
  dstId: string;
}

export interface CurrencyLoader {
  nodes(ids: string[]): Promise<CurrencyNode[]>;
  /** Dependency edges whose `src` is one of these nodes. */
  dependencies(ids: string[]): Promise<CurrencyEdge[]>;
  /** `supersedes` edges whose `dst` (the replaced node) is one of these nodes. */
  replacements?(ids: string[]): Promise<CurrencyEdge[]>;
}

/** An object's own state, from its status and its open marks. */
export type OwnState = 'current' | 'needs_review' | 'invalid' | 'untraced' | 'superseded';

/**
 * The worst of its own state and everything upstream:
 * - `provisional`: something it rests on is under review;
 * - `upstream_invalid`: something it rests on is invalidated or untraced;
 * - `superseded_input`: something it rests on has been replaced.
 */
export type Currency =
  | 'current'
  | 'provisional'
  | 'needs_review'
  | 'upstream_invalid'
  | 'invalid'
  | 'untraced'
  | 'superseded_input'
  | 'superseded';

const RANK: Record<Currency, number> = {
  current: 0,
  provisional: 1,
  needs_review: 2,
  upstream_invalid: 3,
  invalid: 4,
  untraced: 5,
  superseded_input: 6,
  superseded: 7,
};

/** States in which an object must not be presented, or used, as current evidence. */
export const NOT_CURRENT: ReadonlySet<Currency> = new Set([
  'upstream_invalid',
  'invalid',
  'untraced',
  'superseded_input',
  'superseded',
]);

/**
 * What the numbers an object shows are worth:
 * - `verified`: every value was computed by the engine and is current;
 * - `provisional`: computed, but something upstream is under review;
 * - `manual`: at least one value was typed in by a person;
 * - `not_current`: at least one value is invalidated or from a replaced run;
 * - `untraced`: a provenance link was removed and not restored;
 * - `none`: it reports no values.
 */
export type Verification = 'verified' | 'provisional' | 'manual' | 'not_current' | 'untraced' | 'none';

const VERIFICATION_RANK: Record<Verification, number> = {
  none: 0,
  verified: 1,
  provisional: 2,
  manual: 3,
  not_current: 4,
  untraced: 5,
};

export interface CurrencyReport {
  nodeId: string;
  own: OwnState;
  /** The worst state upstream, as it affects this node. */
  upstream: Currency;
  effective: Currency;
  verification: Verification;
  /** Upstream objects that make this one less than current (at most 50). */
  reasons: { nodeId: string; type: string; state: OwnState }[];
}

export function ownState(node: CurrencyNode): OwnState {
  if (node.status === 'superseded') return 'superseded';
  if (node.openMarks.some((mark) => mark.kind === 'untraced')) return 'untraced';
  if (node.openMarks.some((mark) => mark.severity === 'invalidates')) return 'invalid';
  if (node.openMarks.some((mark) => mark.severity === 'review')) return 'needs_review';
  return 'current';
}

function asUpstream(state: OwnState): Currency {
  if (state === 'superseded') return 'superseded_input';
  if (state === 'invalid' || state === 'untraced') return 'upstream_invalid';
  if (state === 'needs_review') return 'provisional';
  return 'current';
}

function worst<T extends string>(rank: Record<T, number>, a: T, b: T): T {
  return rank[b] > rank[a] ? b : a;
}

/** Relations along which currency flows: dependencies, minus verdict annotations. */
function carriesCurrency(rel: string): boolean {
  const rule = ruleFor(rel);
  return Boolean(rule?.dependency && !rule.annotation);
}

/** Relations along which a text reaches the values it shows. */
const SHOWS = new Set(['has_block', 'asserts', 'reports', 'contains_value']);

const MAX_UPSTREAM = 5_000;

export async function assessCurrency(rootId: string, loader: CurrencyLoader): Promise<CurrencyReport> {
  const cache = new Map<string, CurrencyNode>();
  const load = async (ids: string[]) => {
    const missing = ids.filter((id) => !cache.has(id));
    if (missing.length) for (const node of await loader.nodes(missing)) cache.set(node.id, node);
    return ids.map((id) => cache.get(id)).filter((node): node is CurrencyNode => Boolean(node));
  };

  const [root] = await load([rootId]);
  if (!root) throw new Error(`Unknown node ${rootId}`);

  /** Upstream closure of `start` (excluding it), with each node's own state. */
  const upstreamOf = async (start: string) => {
    const seen = new Set([start]);
    let frontier = [start];
    let state: Currency = 'current';
    const reasons: CurrencyReport['reasons'] = [];
    const replaced: CurrencyNode[] = [];
    while (frontier.length > 0 && seen.size < MAX_UPSTREAM) {
      const edges = (await loader.dependencies(frontier)).filter((edge) => carriesCurrency(edge.rel));
      const next = [...new Set(edges.map((edge) => edge.dstId))].filter((id) => !seen.has(id));
      for (const id of next) seen.add(id);
      for (const node of await load(next)) {
        const own = ownState(node);
        if (own === 'superseded') replaced.push(node);
        else if (own !== 'current') {
          state = worst(RANK, state, asUpstream(own));
          if (reasons.length < 50) reasons.push({ nodeId: node.id, type: node.type, state: own });
        }
      }
      frontier = next;
    }
    /*
     * A replaced node upstream makes this stale, unless its replacement is also
     * upstream (or is this node): a cleaned dataset version that replaced the
     * version it was derived from is the current data, not stale data (P1-C).
     */
    const replacers = replaced.length && loader.replacements ? await loader.replacements(replaced.map((node) => node.id)) : [];
    for (const node of replaced) {
      if (replacers.some((edge) => edge.dstId === node.id && seen.has(edge.srcId))) continue;
      state = worst(RANK, state, asUpstream('superseded'));
      if (reasons.length < 50) reasons.push({ nodeId: node.id, type: node.type, state: 'superseded' });
    }
    return { state, reasons };
  };

  const own = ownState(root);
  const upstream = await upstreamOf(rootId);
  const effective = worst(RANK, ownCurrency(own), upstream.state);

  // Verification: the values this object shows, and what each is worth.
  let verification: Verification = 'none';
  const isResult = (RESULT_TYPES as readonly string[]).includes(root.type);
  const results: CurrencyNode[] = [];
  const visited = new Set([rootId]);
  let frontier = [rootId];
  if (isResult) results.push(root);
  else {
    while (frontier.length > 0) {
      const edges = (await loader.dependencies(frontier)).filter((edge) => SHOWS.has(edge.rel));
      const next = [...new Set(edges.map((edge) => edge.dstId))].filter((id) => !visited.has(id));
      for (const id of next) visited.add(id);
      for (const node of await load(next)) {
        if ((RESULT_TYPES as readonly string[]).includes(node.type)) results.push(node);
        if (ownState(node) === 'untraced') verification = 'untraced';
      }
      frontier = next;
    }
  }
  if (own === 'untraced') verification = 'untraced';

  for (const result of results) {
    let worth: Verification;
    if (result.provenance !== 'computed') {
      worth = 'manual';
    } else {
      const state = worst(RANK, ownCurrency(ownState(result)), (await upstreamOf(result.id)).state);
      worth = NOT_CURRENT.has(state) ? 'not_current' : state === 'current' ? 'verified' : 'provisional';
    }
    verification = worst(VERIFICATION_RANK, verification, worth);
  }

  return { nodeId: rootId, own, upstream: upstream.state, effective, verification, reasons: upstream.reasons };
}

function ownCurrency(own: OwnState): Currency {
  return own;
}

/** Whether a type is a statistical output (`result_value`, `result_table`, `figure`). */
export function isResultType(type: string): type is NodeType {
  return (RESULT_TYPES as readonly string[]).includes(type);
}
