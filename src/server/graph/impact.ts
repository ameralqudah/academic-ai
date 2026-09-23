/**
 * Impact analysis (TARGET_ARCHITECTURE §G.3, R6).
 *
 * Given a change of some kind to one node, which nodes become stale and how
 * badly. The walk goes backwards over dependency edges (from what changed to
 * what depends on it), asks the edge rule for a severity, and passes the change
 * on: a node that is invalidated invalidates in turn, while `review` and `info`
 * stop at the node they flag (containers excepted; see `propagatedKind`).
 * Every dependency edge is followed, whatever version it is pinned to: a
 * dependent that is already out of date is flagged again, never skipped. A node reached by several
 * paths keeps the most severe one, and passes each kind of change on at most
 * once, so the walk ends even on a cyclic graph.
 *
 * Pure: the caller supplies the edges, so the same code runs against the
 * database, a transaction, or a fixture.
 */

import { createHash } from 'node:crypto';

import { propagatedKind, ruleFor } from './rules';
import { SEVERITY_RANK, canonicalJson, type ChangeKind, type Severity } from './types';

export interface ImpactEdge {
  id?: string;
  srcId: string;
  rel: string;
  dstId: string;
  dstVersion: number | null;
}

export interface EdgeSource {
  /** Dependency edges whose `dst` is one of these nodes. */
  dependentsOf(nodeIds: string[]): Promise<ImpactEdge[]>;
  /** Dependency edges whose `src` is this node. */
  dependenciesOf(nodeId: string): Promise<ImpactEdge[]>;
}

export interface ImpactItem {
  nodeId: string;
  severity: Severity;
  /** Node ids from the changed node to this one. */
  path: string[];
  rel: string;
  reason: string;
  /**
   * Reached through an edge still pinned to an older version: the node is
   * already out of date with respect to an earlier change and is flagged again
   * for this one. It is never skipped (P1-A review F-1).
   */
  alreadyStale?: boolean;
}

export interface ImpactInput {
  nodeId: string;
  /** The version being replaced. */
  fromVersion: number;
  kind: ChangeKind;
  /** Nodes never flagged (the node replacing a superseded one). */
  exclude?: string[];
}

export interface ImpactResult {
  items: ImpactItem[];
  /**
   * Dependency edges into the changed node that this change does not affect
   * (a cosmetic edit, a rule with no severity for this kind of change). Their
   * dependents are still valid against the new version, so the caller advances
   * their pins to it.
   */
  unaffectedEdges: ImpactEdge[];
}

/** Safety bound; a project graph is far smaller. */
const MAX_NODES = 20_000;

const KIND_RANK: Record<ChangeKind, number> = { cosmetic: 1, substantive: 2, structural: 3 };

export async function computeImpact(input: ImpactInput, edges: EdgeSource): Promise<ImpactResult> {
  const excluded = new Set([input.nodeId, ...(input.exclude ?? [])]);
  const found = new Map<string, ImpactItem>();
  /** The largest change each node has already passed on. */
  const passedOn = new Map<string, ChangeKind>();
  const unaffectedEdges: ImpactEdge[] = [];

  // One hop against the direction of dependency, for the rules that define it.
  for (const edge of await edges.dependenciesOf(input.nodeId)) {
    const rule = ruleFor(edge.rel);
    const severity = rule?.upstream?.[input.kind];
    if (!rule || !severity || excluded.has(edge.dstId)) continue;
    const existing = found.get(edge.dstId);
    if (!existing || SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity]) {
      found.set(edge.dstId, { nodeId: edge.dstId, severity, path: [input.nodeId, edge.dstId], rel: edge.rel, reason: rule.reason });
    }
  }

  let frontier: { nodeId: string; kind: ChangeKind; path: string[]; root: boolean }[] = [
    { nodeId: input.nodeId, kind: input.kind, path: [input.nodeId], root: true },
  ];

  while (frontier.length > 0) {
    if (found.size > MAX_NODES) throw new Error('Impact analysis exceeded the node bound.');

    const byNode = new Map<string, (typeof frontier)[number]>();
    for (const item of frontier) byNode.set(item.nodeId, item);
    const next: typeof frontier = [];

    for (const edge of await edges.dependentsOf([...byNode.keys()])) {
      const from = byNode.get(edge.dstId);
      if (!from || excluded.has(edge.srcId)) continue;

      const rule = ruleFor(edge.rel);
      const severity = rule?.downstream?.[from.kind];
      if (!rule || !severity) {
        if (from.root) unaffectedEdges.push(edge);
        continue;
      }

      const path = [...from.path, edge.srcId];
      const alreadyStale = from.root && edge.dstVersion !== null && edge.dstVersion < input.fromVersion;
      const existing = found.get(edge.srcId);
      if (!existing || SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity]) {
        found.set(edge.srcId, {
          nodeId: edge.srcId,
          severity,
          path,
          rel: edge.rel,
          reason: rule.reason,
          ...(alreadyStale ? { alreadyStale } : {}),
        });
      }

      const kind = propagatedKind(severity, from.kind, rule);
      const passed = passedOn.get(edge.srcId);
      if (kind && (!passed || KIND_RANK[kind] > KIND_RANK[passed])) {
        passedOn.set(edge.srcId, kind);
        next.push({ nodeId: edge.srcId, kind, path, root: false });
      }
    }

    frontier = next;
  }

  const items = [...found.values()].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.nodeId.localeCompare(b.nodeId),
  );
  return { items, unaffectedEdges };
}

/** Whether accepting the change needs an acknowledged Impact Report (R6). */
export function requiresAcknowledgement(items: ImpactItem[]): boolean {
  return items.some((item) => item.severity !== 'info');
}

/**
 * The report's identity. The client echoes it back as `impactAcknowledged`, so
 * a change is accepted only against the exact consequences that were shown.
 */
export function reportHash(input: {
  nodeId: string;
  fromVersion: number;
  kind: ChangeKind | null;
  proposalHash: string;
  items: ImpactItem[];
}): string {
  const body = canonicalJson({
    nodeId: input.nodeId,
    fromVersion: input.fromVersion,
    kind: input.kind,
    proposal: input.proposalHash,
    items: input.items.map((item) => [item.nodeId, item.severity]).sort(),
  });
  return createHash('sha256').update(body).digest('hex');
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
