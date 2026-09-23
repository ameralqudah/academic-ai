/**
 * Research Graph service (P1-A): versioned nodes, typed edges, impact analysis
 * and staleness, all scoped to one project and checked against the caller's
 * project role.
 *
 * Every write that can make something stale runs its impact analysis in the
 * same transaction, and a change with `review` or `invalidates` consequences is
 * refused unless the caller acknowledges the exact Impact Report (R6).
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '@/server/db';
import {
  graphEdges,
  graphNodes,
  nodeVersions,
  projectMembers,
  researchProjects,
  staleMarks,
  type GraphEdge,
  type GraphNode,
} from '@/server/db/schema';
import { AppError } from '@/server/http/errors';

import {
  computeImpact,
  payloadHash,
  reportHash,
  requiresAcknowledgement,
  type EdgeSource,
  type ImpactItem,
} from './impact';
import { ruleFor } from './rules';
import { NODE_TYPES, SEVERITY_RANK, classifyChange, payloadSchema, type ChangeKind, type NodeType, type Severity } from './types';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/* -------------------------------------------------------------------------- */
/*                                   Access                                   */
/* -------------------------------------------------------------------------- */

export const PROJECT_ROLES = ['VIEWER', 'COMMENTER', 'EDITOR', 'OWNER'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

const ROLE_RANK: Record<ProjectRole, number> = { VIEWER: 1, COMMENTER: 2, EDITOR: 3, OWNER: 4 };

export interface Actor {
  userId: string;
  runId?: string;
  origin?: 'user' | 'agent' | 'import' | 'engine';
}

/**
 * The caller's role in the project, or NOT_FOUND. A project the caller cannot
 * see answers exactly like one that does not exist.
 */
export async function requireProjectRole(
  projectId: string,
  userId: string,
  minimum: ProjectRole,
): Promise<ProjectRole> {
  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);

  let role: ProjectRole | undefined = member?.role;
  if (!role) {
    // Projects created outside `projects.repository.create` (fixtures, imports)
    // still belong to their creator.
    const [project] = await db
      .select({ userId: researchProjects.userId })
      .from(researchProjects)
      .where(eq(researchProjects.id, projectId))
      .limit(1);
    if (project?.userId === userId) role = 'OWNER';
  }

  if (!role) throw AppError.notFound('project');
  if (ROLE_RANK[role] < ROLE_RANK[minimum]) throw AppError.forbidden();
  return role;
}

/* -------------------------------------------------------------------------- */
/*                                   Reads                                    */
/* -------------------------------------------------------------------------- */

async function loadNode(executor: Executor, projectId: string, nodeId: string, lock = false): Promise<GraphNode> {
  const query = executor
    .select()
    .from(graphNodes)
    .where(and(eq(graphNodes.id, nodeId), eq(graphNodes.projectId, projectId)))
    .limit(1);
  const [node] = lock ? await query.for('update') : await query;
  if (!node) throw AppError.notFound('node');
  return node;
}

export async function getNode(projectId: string, nodeId: string) {
  const node = await loadNode(db, projectId, nodeId);
  const marks = await db
    .select()
    .from(staleMarks)
    .where(and(eq(staleMarks.nodeId, nodeId), isNull(staleMarks.resolvedAt)));
  return { ...node, openStaleMarks: marks };
}

export async function listNodes(
  projectId: string,
  filter: { type?: NodeType; status?: string; limit?: number } = {},
): Promise<GraphNode[]> {
  const conditions = [eq(graphNodes.projectId, projectId)];
  if (filter.type) conditions.push(eq(graphNodes.type, filter.type));
  if (filter.status) conditions.push(eq(graphNodes.status, filter.status));
  return db
    .select()
    .from(graphNodes)
    .where(and(...conditions))
    .orderBy(desc(graphNodes.updatedAt))
    .limit(Math.min(filter.limit ?? 200, 1000));
}

export async function listVersions(projectId: string, nodeId: string) {
  await loadNode(db, projectId, nodeId);
  return db
    .select()
    .from(nodeVersions)
    .where(eq(nodeVersions.nodeId, nodeId))
    .orderBy(desc(nodeVersions.version));
}

/* -------------------------------------------------------------------------- */
/*                                   Nodes                                    */
/* -------------------------------------------------------------------------- */

function parseType(type: string): NodeType {
  if (!(NODE_TYPES as readonly string[]).includes(type)) {
    throw AppError.validation({ type: `Unknown node type "${type}".` });
  }
  return type as NodeType;
}

function parsePayload(type: NodeType, data: unknown): Record<string, unknown> {
  const parsed = payloadSchema(type).safeParse(data ?? {});
  if (!parsed.success) {
    throw AppError.validation(
      parsed.error.issues.map((issue) => ({ path: ['data', ...issue.path].join('.'), message: issue.message })),
    );
  }
  return parsed.data;
}

export async function createNode(
  projectId: string,
  actor: Actor,
  input: { type: string; label?: string | null; data?: unknown; status?: 'draft' | 'active' },
): Promise<GraphNode> {
  const type = parseType(input.type);
  const payload = parsePayload(type, input.data);

  return db.transaction(async (tx) => {
    const [node] = await tx
      .insert(graphNodes)
      .values({
        projectId,
        type,
        label: input.label ?? null,
        data: payload,
        status: input.status ?? 'active',
        createdByUserId: actor.userId,
        createdByRunId: actor.runId ?? null,
        origin: actor.origin ?? 'user',
      })
      .returning();
    if (!node) throw new Error('Failed to create node');

    await tx.insert(nodeVersions).values({
      nodeId: node.id,
      version: 1,
      payload,
      hash: payloadHash(payload),
      createdByUserId: actor.userId,
      createdByRunId: actor.runId ?? null,
    });
    return node;
  });
}

/* -------------------------------------------------------------------------- */
/*                                   Impact                                   */
/* -------------------------------------------------------------------------- */

function edgeSource(executor: Executor, projectId: string): EdgeSource {
  return {
    async dependentsOf(nodeIds) {
      if (nodeIds.length === 0) return [];
      return executor
        .select({ srcId: graphEdges.srcId, rel: graphEdges.rel, dstId: graphEdges.dstId, dstVersion: graphEdges.dstVersion })
        .from(graphEdges)
        .where(
          and(eq(graphEdges.projectId, projectId), eq(graphEdges.dependency, true), inArray(graphEdges.dstId, nodeIds)),
        );
    },
    async dependenciesOf(nodeId) {
      return executor
        .select({ srcId: graphEdges.srcId, rel: graphEdges.rel, dstId: graphEdges.dstId, dstVersion: graphEdges.dstVersion })
        .from(graphEdges)
        .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.dependency, true), eq(graphEdges.srcId, nodeId)));
    },
  };
}

export interface ImpactReport {
  nodeId: string;
  fromVersion: number;
  changeKind: ChangeKind | null;
  items: (ImpactItem & { type: string; label: string | null })[];
  counts: Record<Severity, number>;
  requiresAcknowledgement: boolean;
  hash: string;
}

async function buildReport(
  executor: Executor,
  projectId: string,
  change: {
    nodeId: string;
    fromVersion: number;
    kind: ChangeKind | null;
    proposalHash: string;
    exclude?: string[];
    reviewPropagates?: boolean;
  },
): Promise<ImpactReport> {
  const items = change.kind
    ? await computeImpact(
        {
          nodeId: change.nodeId,
          fromVersion: change.fromVersion,
          kind: change.kind,
          exclude: change.exclude,
          reviewPropagates: change.reviewPropagates,
        },
        edgeSource(executor, projectId),
      )
    : [];

  const ids = items.map((item) => item.nodeId);
  const nodes = ids.length
    ? await executor
        .select({ id: graphNodes.id, type: graphNodes.type, label: graphNodes.label })
        .from(graphNodes)
        .where(and(eq(graphNodes.projectId, projectId), inArray(graphNodes.id, ids)))
    : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const counts: Record<Severity, number> = { info: 0, review: 0, invalidates: 0 };
  for (const item of items) counts[item.severity] += 1;

  return {
    nodeId: change.nodeId,
    fromVersion: change.fromVersion,
    changeKind: change.kind,
    items: items.map((item) => ({
      ...item,
      type: byId.get(item.nodeId)?.type ?? 'unknown',
      label: byId.get(item.nodeId)?.label ?? null,
    })),
    counts,
    requiresAcknowledgement: requiresAcknowledgement(items),
    hash: reportHash({ ...change, items }),
  };
}

function assertAcknowledged(report: ImpactReport, acknowledged: string | undefined) {
  if (report.requiresAcknowledgement && acknowledged !== report.hash) {
    throw new AppError(
      'IMPACT_ACK_REQUIRED',
      'This change affects other parts of the research. Review the Impact Report, then confirm.',
      'هذا التغيير يؤثّر في أجزاء أخرى من البحث. راجع تقرير الأثر ثم أكّد.',
      { report },
    );
  }
}

/** Writes stale marks for a report and flags the affected nodes. */
async function applyReport(tx: Tx, report: ImpactReport, causeVersion: number) {
  if (report.items.length === 0) return;

  for (const item of report.items) {
    await tx
      .insert(staleMarks)
      .values({
        nodeId: item.nodeId,
        causeNodeId: report.nodeId,
        causeVersion,
        path: item.path,
        severity: item.severity,
        reason: `${item.rel}: ${item.reason}`,
      })
      .onConflictDoUpdate({
        target: [staleMarks.nodeId, staleMarks.causeNodeId, staleMarks.causeVersion],
        set: {
          // Keep the most severe; reopen a resolved mark the same cause hits again.
          severity: sql`case when ${SEVERITY_SQL('excluded.severity')} > ${SEVERITY_SQL('stale_marks.severity')} then excluded.severity else stale_marks.severity end`,
          path: sql`case when ${SEVERITY_SQL('excluded.severity')} > ${SEVERITY_SQL('stale_marks.severity')} then excluded.path else stale_marks.path end`,
          resolvedAt: null,
          resolvedByUserId: null,
          resolution: null,
        },
      });
  }

  const stale = report.items.filter((item) => item.severity !== 'info').map((item) => item.nodeId);
  if (stale.length > 0) {
    await tx
      .update(graphNodes)
      .set({ status: 'stale' })
      .where(and(inArray(graphNodes.id, stale), inArray(graphNodes.status, ['active', 'draft'])));
  }
}

function SEVERITY_SQL(column: string) {
  return sql.raw(
    `(case ${column} ${Object.entries(SEVERITY_RANK)
      .map(([name, rank]) => `when '${name}' then ${rank}`)
      .join(' ')} else 0 end)`,
  );
}

/** Dry run: what would this new payload affect? Writes nothing. */
export async function previewUpdate(projectId: string, nodeId: string, data: unknown): Promise<ImpactReport> {
  const node = await loadNode(db, projectId, nodeId);
  const type = parseType(node.type);
  const payload = parsePayload(type, data);
  return buildReport(db, projectId, {
    nodeId,
    fromVersion: node.currentVersion,
    kind: classifyChange(type, node.data, payload),
    proposalHash: payloadHash(payload),
  });
}

export async function updateNode(
  projectId: string,
  nodeId: string,
  actor: Actor,
  input: {
    data?: unknown;
    label?: string | null;
    expectedVersion: number;
    changeNote?: string;
    impactAcknowledged?: string;
  },
): Promise<{ node: GraphNode; report: ImpactReport | null }> {
  return db.transaction(async (tx) => {
    const node = await loadNode(tx, projectId, nodeId, true);
    if (node.currentVersion !== input.expectedVersion) {
      throw new AppError(
        'CONFLICT',
        'Someone changed this in the meantime. Reload and try again.',
        'عدّل أحدهم هذا العنصر في الأثناء. أعد التحميل وحاول مجددًا.',
        { currentVersion: node.currentVersion },
      );
    }

    const type = parseType(node.type);
    const payload = input.data === undefined ? node.data : parsePayload(type, input.data);
    const kind = classifyChange(type, node.data, payload);
    const labelChanged = input.label !== undefined && input.label !== node.label;

    if (!kind) {
      if (!labelChanged) return { node, report: null };
      const [renamed] = await tx
        .update(graphNodes)
        .set({ label: input.label ?? null })
        .where(eq(graphNodes.id, nodeId))
        .returning();
      return { node: renamed ?? node, report: null };
    }

    const report = await buildReport(tx, projectId, {
      nodeId,
      fromVersion: node.currentVersion,
      kind,
      proposalHash: payloadHash(payload),
    });
    assertAcknowledged(report, input.impactAcknowledged);

    const version = node.currentVersion + 1;
    await tx.insert(nodeVersions).values({
      nodeId,
      version,
      payload,
      hash: payloadHash(payload),
      changeKind: kind,
      changeNote: input.changeNote ?? null,
      impactReportHash: report.items.length > 0 ? report.hash : null,
      createdByUserId: actor.userId,
      createdByRunId: actor.runId ?? null,
    });

    const [updated] = await tx
      .update(graphNodes)
      .set({ data: payload, currentVersion: version, ...(labelChanged ? { label: input.label ?? null } : {}) })
      .where(eq(graphNodes.id, nodeId))
      .returning();

    await applyReport(tx, report, node.currentVersion);
    return { node: updated ?? node, report };
  });
}

/**
 * Replaces a node with a newer one of the same type (a new dataset version, a
 * re-run). What depended on the old one is asked for review; the new one is
 * linked with `supersedes`.
 */
export async function supersede(
  projectId: string,
  oldId: string,
  newId: string,
  actor: Actor,
  impactAcknowledged?: string,
): Promise<ImpactReport> {
  if (oldId === newId) throw AppError.validation({ newId: 'A node cannot supersede itself.' });

  return db.transaction(async (tx) => {
    const previous = await loadNode(tx, projectId, oldId, true);
    const replacement = await loadNode(tx, projectId, newId);
    if (previous.type !== replacement.type) {
      throw AppError.validation({ newId: 'The replacement must be of the same type.' });
    }

    const report = await buildReport(tx, projectId, {
      nodeId: oldId,
      fromVersion: previous.currentVersion,
      kind: 'substantive',
      proposalHash: `supersede:${newId}`,
      exclude: [newId],
      reviewPropagates: true,
    });
    assertAcknowledged(report, impactAcknowledged);

    await tx.update(graphNodes).set({ status: 'superseded' }).where(eq(graphNodes.id, oldId));
    await tx
      .insert(graphEdges)
      .values({ projectId, srcId: newId, rel: 'supersedes', dstId: oldId, dependency: false, createdByUserId: actor.userId, createdByRunId: actor.runId ?? null })
      .onConflictDoNothing();
    await applyReport(tx, report, previous.currentVersion);
    return report;
  });
}

/* -------------------------------------------------------------------------- */
/*                                   Edges                                    */
/* -------------------------------------------------------------------------- */

/** The impact of adding or removing an edge whose rule says that is a change. */
async function linkImpact(tx: Tx, projectId: string, edge: { srcId: string; rel: string; dstId: string }) {
  const rule = ruleFor(edge.rel);
  if (!rule?.onLink) return null;
  const target = await loadNode(tx, projectId, rule.onLink.node === 'src' ? edge.srcId : edge.dstId);
  const report = await buildReport(tx, projectId, {
    nodeId: target.id,
    fromVersion: target.currentVersion,
    kind: rule.onLink.kind,
    proposalHash: `link:${edge.srcId}:${edge.rel}:${edge.dstId}`,
  });
  return { report, version: target.currentVersion };
}

export async function link(
  projectId: string,
  actor: Actor,
  input: {
    srcId: string;
    rel: string;
    dstId: string;
    attrs?: Record<string, unknown>;
    /** Pin to the target's current version (default) or follow its latest. */
    pin?: boolean;
    impactAcknowledged?: string;
  },
): Promise<{ edge: GraphEdge; report: ImpactReport | null }> {
  const rule = ruleFor(input.rel);
  if (!rule) throw AppError.validation({ rel: `Unknown relation "${input.rel}".` });
  if (input.srcId === input.dstId) throw AppError.validation({ dstId: 'A node cannot depend on itself.' });

  return db.transaction(async (tx) => {
    const src = await loadNode(tx, projectId, input.srcId);
    const dst = await loadNode(tx, projectId, input.dstId);
    if (!(rule.from as readonly string[]).includes(src.type) || !(rule.to as readonly string[]).includes(dst.type)) {
      throw AppError.validation({
        rel: `"${input.rel}" links ${rule.from.join('|')} → ${rule.to.join('|')}, not ${src.type} → ${dst.type}.`,
      });
    }

    const [edge] = await tx
      .insert(graphEdges)
      .values({
        projectId,
        srcId: src.id,
        rel: input.rel,
        dstId: dst.id,
        dstVersion: rule.dependency && input.pin !== false ? dst.currentVersion : null,
        dependency: rule.dependency,
        attrs: input.attrs ?? {},
        createdByUserId: actor.userId,
        createdByRunId: actor.runId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!edge) {
      throw AppError.conflict('These two are already linked this way.', 'هذان العنصران مرتبطان بهذه العلاقة مسبقًا.');
    }

    const impact = await linkImpact(tx, projectId, edge);
    if (impact) {
      assertAcknowledged(impact.report, input.impactAcknowledged);
      await applyReport(tx, impact.report, impact.version);
    }
    return { edge, report: impact?.report ?? null };
  });
}

export async function unlink(
  projectId: string,
  edgeId: string,
  impactAcknowledged?: string,
): Promise<{ report: ImpactReport | null }> {
  return db.transaction(async (tx) => {
    const [edge] = await tx
      .select()
      .from(graphEdges)
      .where(and(eq(graphEdges.id, edgeId), eq(graphEdges.projectId, projectId)))
      .limit(1);
    if (!edge) throw AppError.notFound('link');

    // Measured with the edge still in place, so its own consequences count.
    const impact = await linkImpact(tx, projectId, edge);
    if (impact) assertAcknowledged(impact.report, impactAcknowledged);

    await tx.delete(graphEdges).where(eq(graphEdges.id, edgeId));
    if (impact) await applyReport(tx, impact.report, impact.version);
    return { report: impact?.report ?? null };
  });
}

/* -------------------------------------------------------------------------- */
/*                                   Trace                                    */
/* -------------------------------------------------------------------------- */

/**
 * Provenance walk. `up`: what this node rests on (a reported number → its run →
 * the data and the analysis → the model and hypotheses). `down`: what rests on
 * it.
 */
export async function trace(projectId: string, nodeId: string, direction: 'up' | 'down', maxDepth = 8) {
  const root = await loadNode(db, projectId, nodeId);
  const depth = Math.min(Math.max(maxDepth, 1), 20);
  const seen = new Set([root.id]);
  const edges: GraphEdge[] = [];
  let frontier = [root.id];

  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const step = await db
      .select()
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          direction === 'up' ? inArray(graphEdges.srcId, frontier) : inArray(graphEdges.dstId, frontier),
        ),
      );
    const next: string[] = [];
    for (const edge of step) {
      edges.push(edge);
      const other = direction === 'up' ? edge.dstId : edge.srcId;
      if (!seen.has(other)) {
        seen.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }

  const nodes = await db
    .select()
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), inArray(graphNodes.id, [...seen])));
  return { root: root.id, direction, nodes, edges };
}

/* -------------------------------------------------------------------------- */
/*                                 Staleness                                  */
/* -------------------------------------------------------------------------- */

export async function listStale(projectId: string, options: { includeResolved?: boolean } = {}) {
  return db
    .select({
      nodeId: staleMarks.nodeId,
      type: graphNodes.type,
      label: graphNodes.label,
      causeNodeId: staleMarks.causeNodeId,
      causeVersion: staleMarks.causeVersion,
      severity: staleMarks.severity,
      path: staleMarks.path,
      reason: staleMarks.reason,
      createdAt: staleMarks.createdAt,
      resolvedAt: staleMarks.resolvedAt,
      resolution: staleMarks.resolution,
    })
    .from(staleMarks)
    .innerJoin(graphNodes, eq(graphNodes.id, staleMarks.nodeId))
    .where(and(eq(graphNodes.projectId, projectId), options.includeResolved ? undefined : isNull(staleMarks.resolvedAt)))
    .orderBy(desc(staleMarks.createdAt))
    .limit(1000);
}

/**
 * Clears a node's open marks. `accepted`: still valid as is — its dependency
 * edges are re-pinned to the current versions of their targets, so the next
 * change is measured from here. `regenerated`: a new version replaced it.
 * `dismissed`: closed without a decision (info marks).
 */
export async function resolveStale(
  projectId: string,
  nodeId: string,
  actor: Actor,
  resolution: 'accepted' | 'regenerated' | 'dismissed',
): Promise<{ resolved: number }> {
  return db.transaction(async (tx) => {
    const node = await loadNode(tx, projectId, nodeId, true);

    const resolved = await tx
      .update(staleMarks)
      .set({ resolvedAt: new Date(), resolvedByUserId: actor.userId, resolution })
      .where(and(eq(staleMarks.nodeId, nodeId), isNull(staleMarks.resolvedAt)))
      .returning({ nodeId: staleMarks.nodeId });

    if (resolution === 'accepted') {
      await tx.execute(sql`
        update graph_edges e set dst_version = n.current_version
        from graph_nodes n
        where e.src_id = ${nodeId} and e.dependency and e.dst_version is not null and n.id = e.dst_id
      `);
    }

    if (node.status === 'stale') {
      await tx.update(graphNodes).set({ status: 'active' }).where(eq(graphNodes.id, nodeId));
    }
    return { resolved: resolved.length };
  });
}
