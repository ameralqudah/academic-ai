/**
 * Graph-derived context for Context V2 (P1-E, PR #3).
 *
 * Two things, both read from the Research Graph and both only when
 * `FF_CONTEXT_V2` **and** `FF_GRAPH` are on (the assembler checks
 * `graphContextEnabled()` before calling anything here):
 *
 * 1. **The snapshot's graph section** (`graphSummary`): what the project's
 *    graph holds — node counts by type, the research questions and hypotheses
 *    by label, and how many objects are flagged for review. Superseded nodes
 *    are not counted. Labels only, never payloads.
 * 2. **The focus-graph slice** (`focusSlice`): the immediate neighbourhood
 *    (one hop, both directions) of the focus nodes — the claims the request
 *    and the context reference, nodes a caller names, or, when there are none,
 *    the research questions, hypotheses, constructs and variables whose labels
 *    share words with the request. Bounded: at most `MAX_FOCUS` focus nodes,
 *    `MAX_SLICE_NODES` nodes and `MAX_SLICE_EDGES` edges.
 *
 * **Authorization is the graph service's own** (WS4 A2, member-scoped): every
 * read goes through `listNodes`, `listStale` or `trace`, each of which
 * requires the VIEWER role in the project and reads that project only. The
 * assembler calls this only for a project the caller is a member of; a node
 * of another project is not found and contributes nothing. No legacy
 * creator-only record is read.
 *
 * **Claims keep PR #2's rules.** A claim node in the slice is written as its
 * `{{claim:id}}` reference, never its stored text, so the assembler's claim
 * pass decides what the model reads: the text of a current, verified claim of
 * this project, or `[unresolved claim]`.
 */

import { logger } from '@/lib/logger';
import type { GraphNode } from '@/server/db/schema';
import * as graph from '@/server/graph/service';

export const MAX_FOCUS = 4;
export const MAX_SLICE_NODES = 12;
export const MAX_SLICE_EDGES = 20;
const MAX_LISTED = 5;
const MAX_LABEL = 120;

/** Node types a request is matched against when it names no focus node. */
const MATCHABLE = new Set(['research_question', 'hypothesis', 'construct', 'variable', 'objective']);

const PLURAL: Record<string, string> = {
  research_question: 'research questions',
  hypothesis: 'hypotheses',
  analysis: 'analyses',
};

const plural = (type: string, count: number) => (count === 1 ? type.replace(/_/g, ' ') : (PLURAL[type] ?? `${type.replace(/_/g, ' ')}s`));

const label = (node: Pick<GraphNode, 'label' | 'type'>) => {
  const text = (node.label ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL)}…` : text || '(unlabelled)';
};

/** How a node is named in the slice: a claim by its reference (rendered by the claim pass), anything else by type and label. */
const named = (node: Pick<GraphNode, 'id' | 'label' | 'type'>) => (node.type === 'claim' ? `[claim] {{claim:${node.id}}}` : `[${node.type.replace(/_/g, ' ')}] ${label(node)}`);

const live = (node: Pick<GraphNode, 'status'>) => node.status !== 'superseded';

/** The snapshot's graph section, as lines, or none when the graph is empty. Throws only what the graph service throws. */
export async function graphSummary(projectId: string, userId: string): Promise<string[]> {
  const actor = { userId };
  const nodes = (await graph.listNodes(projectId, actor, { limit: 1000 })).filter(live);
  if (nodes.length === 0) return ['Research graph: empty'];

  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const listed = (type: string, title: string) => {
    const of = nodes.filter((node) => node.type === type);
    if (of.length === 0) return '';
    const shown = of.slice(0, MAX_LISTED).map(label);
    return `${title}: ${shown.join('; ')}${of.length > shown.length ? ` (+${of.length - shown.length} more)` : ''}`;
  };

  const stale = (await graph.listStale(projectId, actor)).length;

  return [
    `Research graph: ${ordered.map(([type, count]) => `${count} ${plural(type, count)}`).join(', ')}`,
    listed('research_question', 'Research questions'),
    listed('hypothesis', 'Hypotheses'),
    stale > 0 ? `Flagged for review: ${stale} open mark${stale === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
}

/** The distinctive words of a text, for matching a request to node labels. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 4),
  );
}

export interface FocusSlice {
  /** The rendered slice, or null when there is nothing to show. */
  content: string | null;
  focus: string[];
  nodes: number;
  edges: number;
}

/**
 * The one-hop neighbourhood of the focus nodes. `focusIds` are tried in order
 * (a node of another project, or one that does not exist, is skipped); with
 * none that resolve, nodes are matched to `request` by label.
 */
export async function focusSlice(projectId: string, userId: string, input: { focusIds: readonly string[]; request: string }): Promise<FocusSlice> {
  const actor = { userId };
  const empty: FocusSlice = { content: null, focus: [], nodes: 0, edges: 0 };

  let focus: string[] = [...new Set(input.focusIds)].slice(0, MAX_FOCUS * 2);
  if (focus.length === 0) {
    const wanted = words(input.request);
    if (wanted.size === 0) return empty;
    const candidates = (await graph.listNodes(projectId, actor, { limit: 1000 })).filter((node) => live(node) && MATCHABLE.has(node.type));
    focus = candidates
      .map((node) => ({ id: node.id, score: [...words(node.label ?? '')].filter((word) => wanted.has(word)).length }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .map((entry) => entry.id);
  }

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, { srcId: string; rel: string; dstId: string }>();
  const roots: string[] = [];

  for (const id of focus) {
    if (roots.length >= MAX_FOCUS) break;
    try {
      const [up, down] = await Promise.all([graph.trace(projectId, actor, id, 'up', 1), graph.trace(projectId, actor, id, 'down', 1)]);
      roots.push(id);
      for (const node of [...up.nodes, ...down.nodes]) if (node.projectId === projectId) nodes.set(node.id, node);
      for (const edge of [...up.edges, ...down.edges]) if (edge.projectId === projectId) edges.set(edge.id, edge);
    } catch (error) {
      /* Not in this project, or gone: no slice around it, and nothing about it is said. */
      logger.info('context.focusSkipped', { reason: String(error).slice(0, 120) });
    }
  }
  if (roots.length === 0) return empty;

  /* Bounded: the roots first, then their neighbours as found, superseded neighbours left out. */
  const kept = new Map<string, GraphNode>();
  for (const id of roots) {
    const node = nodes.get(id);
    if (node) kept.set(id, node);
  }
  for (const node of nodes.values()) {
    if (kept.size >= MAX_SLICE_NODES) break;
    if (!kept.has(node.id) && live(node)) kept.set(node.id, node);
  }
  const shownEdges = [...edges.values()].filter((edge) => kept.has(edge.srcId) && kept.has(edge.dstId)).slice(0, MAX_SLICE_EDGES);

  const lines = [
    `Focus graph (one step around ${roots.map((id) => named(kept.get(id)!)).join(', ')}):`,
    ...shownEdges.map((edge) => `- ${named(kept.get(edge.srcId)!)} —${edge.rel}→ ${named(kept.get(edge.dstId)!)}`),
  ];
  const linked = new Set(shownEdges.flatMap((edge) => [edge.srcId, edge.dstId]));
  const alone = [...kept.values()].filter((node) => !linked.has(node.id));
  if (alone.length > 0) lines.push(`- with no shown links: ${alone.map(named).join(', ')}`);

  return { content: lines.join('\n'), focus: roots, nodes: kept.size, edges: shownEdges.length };
}
