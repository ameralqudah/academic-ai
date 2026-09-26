/**
 * Research Graph service: versioned nodes, typed edges, impact analysis,
 * staleness, currency and result provenance, all scoped to one project.
 *
 * This service is the gate (P1-A review F-24). Every exported operation takes
 * the acting user and checks their project role itself, so routes, tools and
 * agents cannot reach the graph around it. What the service guarantees:
 *
 * - **Impact (R6).** Every write that can make something stale runs its impact
 *   analysis in the same transaction; a change with `review` or `invalidates`
 *   consequences is refused unless the caller acknowledges the exact Impact
 *   Report. No dependent is ever skipped (F-1).
 * - **Currency.** Nothing can be accepted as current while something it rests
 *   on is invalidated, untraced or replaced (F-2); nothing new can be linked to
 *   out-of-date evidence without saying so (F-3); replaced objects are
 *   read-only and replacement cannot loop (F-4).
 * - **Provenance.** Runs and their outputs are written only by the analysis
 *   engine (`recordRun`), together with the edges that say what they used, and
 *   are never edited. A value typed in by a person is classified `manual` and
 *   never counts as verified. Removing the link behind a reported number
 *   leaves the text `untraced` (F-5, F-6). Data a run has used is frozen.
 * - **History.** Versions are immutable (database trigger, F-7); edits against
 *   an old version are refused (optimistic concurrency).
 */

import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';

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
import { researchNumbers } from '@/server/integrity/numbers';

import { NOT_CURRENT, assessCurrency, isResultType, type CurrencyLoader, type CurrencyReport } from './currency';
import {
  computeImpact,
  payloadHash,
  reportHash,
  requiresAcknowledgement,
  type EdgeSource,
  type ImpactItem,
} from './impact';
import { ruleFor } from './rules';
import {
  ENGINE_OUTPUT_TYPES,
  MAX_PAYLOAD_BYTES,
  NODE_TYPES,
  RESULT_TYPES,
  SEVERITY_RANK,
  canonicalJson,
  classifyChange,
  immutableFieldChanges,
  payloadSchema,
  type ChangeKind,
  type NodeType,
  type Severity,
} from './types';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/* -------------------------------------------------------------------------- */
/*                                   Access                                   */
/* -------------------------------------------------------------------------- */

export const PROJECT_ROLES = ['VIEWER', 'COMMENTER', 'EDITOR', 'OWNER'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

const ROLE_RANK: Record<ProjectRole, number> = { VIEWER: 1, COMMENTER: 2, EDITOR: 3, OWNER: 4 };

/**
 * Who is acting. Routes build it from the session and never set `origin`, so
 * only server code (the analysis engine, importers) can act as `engine`.
 */
export interface Actor {
  userId: string;
  runId?: string;
  /** P1-D: the research-run step whose tool is writing; recorded as provenance. */
  stepId?: string;
  origin?: 'user' | 'agent' | 'import' | 'engine';
}

const isEngine = (actor: Actor) => actor.origin === 'engine';

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

const authorize = (projectId: string, actor: Actor, minimum: ProjectRole) =>
  requireProjectRole(projectId, actor.userId, minimum);

/** A refused write, with a machine-readable reason in `details.reason`. */
function refuse(reason: string, message: string, messageAr: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('CONFLICT', message, messageAr, { reason, ...details });
}

/* -------------------------------------------------------------------------- */
/*                                   Loaders                                  */
/* -------------------------------------------------------------------------- */

async function loadNode(
  executor: Executor,
  projectId: string,
  nodeId: string,
  lock?: 'update' | 'share',
): Promise<GraphNode> {
  const query = executor
    .select()
    .from(graphNodes)
    .where(and(eq(graphNodes.id, nodeId), eq(graphNodes.projectId, projectId)))
    .limit(1);
  const [node] = lock ? await query.for(lock) : await query;
  if (!node) throw AppError.notFound('node');
  return node;
}

function edgeSource(executor: Executor, projectId: string): EdgeSource {
  const columns = {
    id: graphEdges.id,
    srcId: graphEdges.srcId,
    rel: graphEdges.rel,
    dstId: graphEdges.dstId,
    dstVersion: graphEdges.dstVersion,
  };
  return {
    async dependentsOf(nodeIds) {
      if (nodeIds.length === 0) return [];
      return executor
        .select(columns)
        .from(graphEdges)
        .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.dependency, true), inArray(graphEdges.dstId, nodeIds)));
    },
    async dependenciesOf(nodeId) {
      return executor
        .select(columns)
        .from(graphEdges)
        .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.dependency, true), eq(graphEdges.srcId, nodeId)));
    },
  };
}

function currencyLoader(executor: Executor, projectId: string): CurrencyLoader {
  return {
    async nodes(ids) {
      if (ids.length === 0) return [];
      const rows = await executor
        .select({ id: graphNodes.id, type: graphNodes.type, status: graphNodes.status, provenance: graphNodes.provenance })
        .from(graphNodes)
        .where(and(eq(graphNodes.projectId, projectId), inArray(graphNodes.id, ids)));
      const marks = await executor
        .select({ nodeId: staleMarks.nodeId, severity: staleMarks.severity, kind: staleMarks.kind })
        .from(staleMarks)
        .where(and(eq(staleMarks.projectId, projectId), inArray(staleMarks.nodeId, ids), isNull(staleMarks.resolvedAt)));
      return rows.map((row) => ({
        ...row,
        openMarks: marks.filter((mark) => mark.nodeId === row.id).map(({ severity, kind }) => ({ severity, kind })),
      }));
    },
    async dependencies(ids) {
      if (ids.length === 0) return [];
      return executor
        .select({ srcId: graphEdges.srcId, rel: graphEdges.rel, dstId: graphEdges.dstId })
        .from(graphEdges)
        .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.dependency, true), inArray(graphEdges.srcId, ids)));
    },
    async replacements(ids) {
      if (ids.length === 0) return [];
      return executor
        .select({ srcId: graphEdges.srcId, rel: graphEdges.rel, dstId: graphEdges.dstId })
        .from(graphEdges)
        .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.rel, 'supersedes'), inArray(graphEdges.dstId, ids)));
    },
  };
}

const currencyOf = (executor: Executor, projectId: string, nodeId: string) =>
  assessCurrency(nodeId, currencyLoader(executor, projectId));

/* -------------------------------------------------------------------------- */
/*                                   Reads                                    */
/* -------------------------------------------------------------------------- */

export async function getNode(projectId: string, actor: Actor, nodeId: string) {
  await authorize(projectId, actor, 'VIEWER');
  const node = await loadNode(db, projectId, nodeId);
  const marks = await db
    .select()
    .from(staleMarks)
    .where(and(eq(staleMarks.projectId, projectId), eq(staleMarks.nodeId, nodeId), isNull(staleMarks.resolvedAt)));
  const currency = await currencyOf(db, projectId, nodeId);
  return { ...node, openStaleMarks: marks, currency };
}

/** Whether an object can be presented as current, and what its numbers are worth. */
export async function assess(projectId: string, actor: Actor, nodeId: string): Promise<CurrencyReport> {
  await authorize(projectId, actor, 'VIEWER');
  await loadNode(db, projectId, nodeId);
  return currencyOf(db, projectId, nodeId);
}

export async function listNodes(
  projectId: string,
  actor: Actor,
  filter: { type?: NodeType; status?: string; limit?: number } = {},
): Promise<GraphNode[]> {
  await authorize(projectId, actor, 'VIEWER');
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

export async function listVersions(projectId: string, actor: Actor, nodeId: string) {
  await authorize(projectId, actor, 'VIEWER');
  await loadNode(db, projectId, nodeId);
  return db
    .select()
    .from(nodeVersions)
    .where(and(eq(nodeVersions.projectId, projectId), eq(nodeVersions.nodeId, nodeId)))
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
  const size = Buffer.byteLength(canonicalJson(data ?? {}), 'utf8');
  if (size > MAX_PAYLOAD_BYTES) {
    throw AppError.validation({ data: `The payload is ${size} bytes; the limit is ${MAX_PAYLOAD_BYTES}.` });
  }
  const parsed = payloadSchema(type).safeParse(data ?? {});
  if (!parsed.success) {
    throw AppError.validation(
      parsed.error.issues.map((issue) => ({ path: ['data', ...issue.path].join('.'), message: issue.message })),
    );
  }
  return parsed.data;
}

const isEngineOutput = (node: Pick<GraphNode, 'type' | 'provenance'>) =>
  (ENGINE_OUTPUT_TYPES as readonly string[]).includes(node.type) || node.provenance === 'computed';

async function insertNode(
  tx: Tx,
  projectId: string,
  actor: Actor,
  input: { type: NodeType; label: string | null; payload: Record<string, unknown>; status?: string; provenance?: 'computed' | 'manual' | null },
): Promise<GraphNode> {
  const [node] = await tx
    .insert(graphNodes)
    .values({
      projectId,
      type: input.type,
      label: input.label,
      data: input.payload,
      status: input.status ?? 'active',
      provenance: input.provenance ?? null,
      createdByUserId: actor.userId,
      createdByRunId: actor.runId ?? null, createdByStepId: actor.stepId ?? null,
      origin: actor.origin ?? 'user',
    })
    .returning();
  if (!node) throw new Error('Failed to create node');

  await tx.insert(nodeVersions).values({
    projectId,
    nodeId: node.id,
    version: 1,
    payload: input.payload,
    hash: payloadHash(input.payload),
    createdByUserId: actor.userId,
    createdByRunId: actor.runId ?? null, createdByStepId: actor.stepId ?? null,
  });
  return node;
}

/**
 * Creates a node. Analysis runs cannot be created here: only `recordRun`
 * writes them, with their outputs. A result, table or figure created here was
 * typed in by a person and is classified `manual` — it is never shown as
 * computationally verified.
 */
export async function createNode(
  projectId: string,
  actor: Actor,
  input: { type: string; label?: string | null; data?: unknown; status?: 'draft' | 'active' },
): Promise<GraphNode> {
  await authorize(projectId, actor, 'EDITOR');
  const type = parseType(input.type);
  if ((ENGINE_OUTPUT_TYPES as readonly string[]).includes(type)) {
    throw new AppError(
      'FORBIDDEN',
      'Analysis runs are recorded by the analysis engine, not created by hand.',
      'تُسجِّل محرّكات التحليل عمليات التشغيل، ولا تُنشأ يدويًا.',
      { reason: 'engine_only' },
    );
  }
  const payload = parsePayload(type, input.data);
  /*
   * A claim that reports a research number exists only with its evidence
   * (WS3-A, N5): it is written by the strict claim path (`insertClaim` →
   * `createClaim`), which renders its numbers from recorded values and links
   * them in the same transaction. Typed here it would look as traced as one
   * that is. A claim with no research number (from the literature, say) may
   * be written here; its text never changes afterwards (N6), so it cannot
   * gain one later.
   */
  if (type === 'claim') assertNoResearchNumbers((payload as { text: string }).text);
  return db.transaction((tx) =>
    insertNode(tx, projectId, actor, {
      type,
      label: input.label ?? null,
      payload,
      status: input.status,
      provenance: (RESULT_TYPES as readonly string[]).includes(type) ? 'manual' : null,
    }),
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Impact                                   */
/* -------------------------------------------------------------------------- */

export interface ImpactReport {
  nodeId: string;
  fromVersion: number;
  changeKind: ChangeKind | null;
  items: (ImpactItem & { type: string; label: string | null; kind?: 'stale' | 'untraced' })[];
  counts: Record<Severity, number>;
  requiresAcknowledgement: boolean;
  hash: string;
}

type ReportItem = ImpactItem & { kind?: 'stale' | 'untraced' };

/** Labels, counts and the hash for a set of consequences. */
async function finaliseReport(
  executor: Executor,
  projectId: string,
  base: { nodeId: string; fromVersion: number; changeKind: ChangeKind | null },
  items: ReportItem[],
  proposal: string,
): Promise<ImpactReport> {
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
    ...base,
    items: items.map((item) => ({ ...item, type: byId.get(item.nodeId)?.type ?? 'unknown', label: byId.get(item.nodeId)?.label ?? null })),
    counts,
    requiresAcknowledgement: requiresAcknowledgement(items),
    hash: reportHash({ nodeId: base.nodeId, fromVersion: base.fromVersion, kind: base.changeKind, proposalHash: proposal, items }),
  };
}

async function buildReport(
  executor: Executor,
  projectId: string,
  change: { nodeId: string; fromVersion: number; kind: ChangeKind | null; proposalHash: string; exclude?: string[] },
): Promise<{ report: ImpactReport; unaffected: { id?: string }[] }> {
  const impact = change.kind
    ? await computeImpact(
        { nodeId: change.nodeId, fromVersion: change.fromVersion, kind: change.kind, exclude: change.exclude },
        edgeSource(executor, projectId),
      )
    : { items: [], unaffectedEdges: [] };
  const report = await finaliseReport(
    executor,
    projectId,
    { nodeId: change.nodeId, fromVersion: change.fromVersion, changeKind: change.kind },
    impact.items,
    change.proposalHash,
  );
  return { report, unaffected: impact.unaffectedEdges };
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

function severitySql(column: string) {
  return sql.raw(
    `(case ${column} ${Object.entries(SEVERITY_RANK)
      .map(([name, rank]) => `when '${name}' then ${rank}`)
      .join(' ')} else 0 end)`,
  );
}

/** Writes the stale marks of a report and flags the affected nodes. */
async function applyReport(tx: Tx, projectId: string, report: ImpactReport, causeVersion: number) {
  if (report.items.length === 0) return;

  const versions = await tx
    .select({ id: graphNodes.id, currentVersion: graphNodes.currentVersion })
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), inArray(graphNodes.id, report.items.map((item) => item.nodeId))));
  const versionOf = new Map(versions.map((row) => [row.id, row.currentVersion]));

  await tx
    .insert(staleMarks)
    .values(
      report.items.map((item) => ({
        projectId,
        nodeId: item.nodeId,
        causeNodeId: report.nodeId,
        causeVersion,
        kind: item.kind ?? 'stale',
        nodeVersion: versionOf.get(item.nodeId) ?? 1,
        path: item.path,
        severity: item.severity,
        reason: `${item.rel}: ${item.reason}`,
      })),
    )
    .onConflictDoUpdate({
      target: [staleMarks.nodeId, staleMarks.causeNodeId, staleMarks.causeVersion, staleMarks.kind],
      set: {
        // Keep the most severe; reopen a resolved mark the same cause hits again.
        severity: sql`case when ${severitySql('excluded.severity')} > ${severitySql('stale_marks.severity')} then excluded.severity else stale_marks.severity end`,
        path: sql`case when ${severitySql('excluded.severity')} > ${severitySql('stale_marks.severity')} then excluded.path else stale_marks.path end`,
        nodeVersion: sql`excluded.node_version`,
        resolvedAt: null,
        resolvedByUserId: null,
        resolution: null,
      },
    });

  const stale = report.items.filter((item) => item.severity !== 'info').map((item) => item.nodeId);
  if (stale.length > 0) {
    await tx
      .update(graphNodes)
      .set({ status: 'stale' })
      .where(and(eq(graphNodes.projectId, projectId), inArray(graphNodes.id, stale), inArray(graphNodes.status, ['active', 'draft'])));
  }
}

/** Relations that record what a run actually used; their pins never move. */
const ENGINE_RELS = ['executes', 'uses_data', 'produced_by'];

/**
 * After a version bump: dependents this change does not affect are still valid
 * against the new version, so their pins follow it (F-1). Run records keep the
 * version they used.
 */
async function advancePins(tx: Tx, projectId: string, edges: { id?: string }[], fromVersion: number, toVersion: number) {
  const ids = edges.map((edge) => edge.id).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return;
  await tx
    .update(graphEdges)
    .set({ dstVersion: toVersion })
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        inArray(graphEdges.id, ids),
        eq(graphEdges.dstVersion, fromVersion),
        sql`${graphEdges.rel} not in (${sql.join(ENGINE_RELS.map((rel) => sql`${rel}`), sql`, `)})`,
      ),
    );
}

/** Refusals that apply to any edit of a node's payload. */
function assertEditable(node: GraphNode, type: NodeType, payload: Record<string, unknown>, kind: ChangeKind | null) {
  if (node.status === 'superseded') {
    throw refuse('superseded', 'This has been replaced and is kept as a record. Edit its replacement.', 'استُبدل هذا العنصر ويُحفظ للسجلّ. عدّل البديل.');
  }
  if (kind && isEngineOutput(node)) {
    throw refuse(
      'immutable_result',
      'A computed result is exactly what its run produced and cannot be edited. Re-run the analysis instead.',
      'النتيجة المحسوبة هي ما أنتجه التشغيل تمامًا ولا يمكن تعديلها. أعد تشغيل التحليل بدلًا من ذلك.',
    );
  }
  const immutable = immutableFieldChanges(type, node.data, payload);
  if (immutable.length > 0) {
    throw refuse(
      'immutable_field',
      'Different content is a new version: create it and replace this one.',
      'المحتوى المختلف نسخةٌ جديدة: أنشئها واستبدل بها هذه.',
      { fields: immutable },
    );
  }
  if (kind && kind !== 'cosmetic' && node.frozenAt) {
    throw refuse(
      'frozen',
      'An analysis has used this data, so it can no longer change. Create a new version instead.',
      'استُخدمت هذه البيانات في تحليل، فلم يعد تغييرها ممكنًا. أنشئ نسخة جديدة بدلًا من ذلك.',
    );
  }
}

/** Dry run: what would this new payload affect? Writes nothing. */
export async function previewUpdate(projectId: string, actor: Actor, nodeId: string, data: unknown): Promise<ImpactReport> {
  await authorize(projectId, actor, 'VIEWER');
  const node = await loadNode(db, projectId, nodeId);
  const type = parseType(node.type);
  const payload = parsePayload(type, data);
  const kind = classifyChange(type, node.data, payload);
  assertEditable(node, type, payload, kind);
  const { report } = await buildReport(db, projectId, {
    nodeId,
    fromVersion: node.currentVersion,
    kind,
    proposalHash: payloadHash(payload),
  });
  return report;
}

export async function updateNode(
  projectId: string,
  actor: Actor,
  nodeId: string,
  input: {
    data?: unknown;
    label?: string | null;
    expectedVersion: number;
    changeNote?: string;
    impactAcknowledged?: string;
  },
): Promise<{ node: GraphNode; report: ImpactReport | null }> {
  await authorize(projectId, actor, 'EDITOR');
  return db.transaction(async (tx) => {
    const node = await loadNode(tx, projectId, nodeId, 'update');
    if (node.currentVersion !== input.expectedVersion) {
      throw refuse(
        'version_conflict',
        'Someone changed this in the meantime. Reload and try again.',
        'عدّل أحدهم هذا العنصر في الأثناء. أعد التحميل وحاول مجددًا.',
        { currentVersion: node.currentVersion },
      );
    }

    const type = parseType(node.type);
    const payload = input.data === undefined ? node.data : parsePayload(type, input.data);
    const kind = classifyChange(type, node.data, payload);
    assertEditable(node, type, payload, kind);
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

    const { report, unaffected } = await buildReport(tx, projectId, {
      nodeId,
      fromVersion: node.currentVersion,
      kind,
      proposalHash: payloadHash(payload),
    });
    assertAcknowledged(report, input.impactAcknowledged);

    const version = node.currentVersion + 1;
    await tx.insert(nodeVersions).values({
      projectId,
      nodeId,
      version,
      payload,
      hash: payloadHash(payload),
      changeKind: kind,
      changeNote: input.changeNote ?? null,
      impactReportHash: report.items.length > 0 ? report.hash : null,
      createdByUserId: actor.userId,
      createdByRunId: actor.runId ?? null, createdByStepId: actor.stepId ?? null,
    });

    const [updated] = await tx
      .update(graphNodes)
      .set({ data: payload, currentVersion: version, ...(labelChanged ? { label: input.label ?? null } : {}) })
      .where(eq(graphNodes.id, nodeId))
      .returning();

    await applyReport(tx, projectId, report, node.currentVersion);
    await advancePins(tx, projectId, unaffected, node.currentVersion, version);
    return { node: updated ?? node, report };
  });
}

/* -------------------------------------------------------------------------- */
/*                                 Supersede                                  */
/* -------------------------------------------------------------------------- */

/** Whether `from` already (transitively) supersedes `to`. */
async function supersedes(tx: Tx, projectId: string, from: string, to: string): Promise<boolean> {
  const [row] = await tx.execute<{ found: boolean }>(sql`
    with recursive chain(id) as (
      select ${from}::text
      union
      select e.dst_id from graph_edges e join chain c on e.src_id = c.id
      where e.project_id = ${projectId} and e.rel = 'supersedes'
    )
    select exists(select 1 from chain where id = ${to}) as found
  `);
  return Boolean(row?.found);
}

async function supersedeInTx(
  tx: Tx,
  projectId: string,
  actor: Actor,
  oldId: string,
  newId: string,
  impactAcknowledged: string | undefined,
  proposal: string,
  exclude: string[],
): Promise<ImpactReport> {
  if (oldId === newId) throw AppError.validation({ newId: 'A node cannot supersede itself.' });
  const previous = await loadNode(tx, projectId, oldId, 'update');
  const replacement = await loadNode(tx, projectId, newId, 'share');
  if (previous.type !== replacement.type) {
    throw AppError.validation({ newId: 'The replacement must be of the same type.' });
  }
  if (previous.status === 'superseded') {
    throw refuse('already_superseded', 'This has already been replaced.', 'استُبدل هذا العنصر من قبل.');
  }
  if (replacement.status === 'superseded') {
    throw refuse('superseded', 'The replacement has itself been replaced.', 'البديل نفسه مستبدَل.');
  }
  if (await supersedes(tx, projectId, oldId, newId)) {
    throw refuse('supersede_cycle', 'That would make a replacement chain loop back on itself.', 'سيجعل هذا سلسلة الاستبدال تعود إلى نفسها.');
  }

  // A replaced object is gone from the current study: what used it is invalid.
  const { report } = await buildReport(tx, projectId, {
    nodeId: oldId,
    fromVersion: previous.currentVersion,
    kind: 'structural',
    proposalHash: proposal,
    exclude,
  });
  assertAcknowledged(report, impactAcknowledged);

  await tx.update(graphNodes).set({ status: 'superseded' }).where(eq(graphNodes.id, oldId));
  await tx.insert(graphEdges).values({
    projectId,
    srcId: newId,
    rel: 'supersedes',
    dstId: oldId,
    dependency: false,
    createdByUserId: actor.userId,
    createdByRunId: actor.runId ?? null, createdByStepId: actor.stepId ?? null,
    origin: actor.origin ?? 'user',
  });
  await applyReport(tx, projectId, report, previous.currentVersion);
  return report;
}

/**
 * Replaces a node with a newer one of the same type (a new dataset version, a
 * revised instrument). Everything that used the old one is invalidated; the
 * old one stays as a read-only record, linked from its replacement. Runs and
 * computed results are replaced only by re-running (`recordRun`).
 */
export async function supersede(
  projectId: string,
  actor: Actor,
  oldId: string,
  newId: string,
  impactAcknowledged?: string,
): Promise<ImpactReport> {
  await authorize(projectId, actor, 'EDITOR');
  return db.transaction(async (tx) => {
    const previous = await loadNode(tx, projectId, oldId);
    if (isEngineOutput(previous) && !isEngine(actor)) {
      throw new AppError('FORBIDDEN', 'A run is replaced by re-running the analysis.', 'يُستبدل التشغيل بإعادة تشغيل التحليل.', { reason: 'engine_only' });
    }
    return supersedeInTx(tx, projectId, actor, oldId, newId, impactAcknowledged, `supersede:${oldId}:${newId}`, [newId]);
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
  const { report } = await buildReport(tx, projectId, {
    nodeId: target.id,
    fromVersion: target.currentVersion,
    kind: rule.onLink.kind,
    proposalHash: `link:${edge.srcId}:${edge.rel}:${edge.dstId}`,
  });
  return { report, version: target.currentVersion };
}

/** The refusal for a `reports` link made outside the strict claim path (WS3-A, N5). */
function strictClaimPath(): AppError {
  return new AppError(
    'FORBIDDEN',
    'The values a claim reports are linked only through the strict claim path (POST …/analyses/runs/:runId/claims).',
    'لا تُربط القيم التي يوردها الادعاء إلا عبر مسار الادعاء الصارم.',
    { reason: 'strict_claim_path' },
  );
}

/**
 * A hand-written claim carries no research number (WS3-A, N5): no statistic,
 * decimal or percentage as the numeric guard reads a person's text, and no
 * `{{value:…}}` reference, which only the strict claim path can render.
 * Years, counts in prose and labels are ordinary text and pass.
 */
function assertNoResearchNumbers(text: string) {
  const spans = researchNumbers(text, 'person').map((found) => found.text);
  if (spans.length > 0 || /\{\{value:/.test(text)) {
    throw new AppError(
      'FORBIDDEN',
      'A claim that reports research numbers is written only through the strict claim path (POST …/analyses/runs/:runId/claims).',
      'لا يُكتب الادعاء الذي يورد أرقامًا بحثية إلا عبر مسار الادعاء الصارم.',
      { reason: 'strict_claim_path', spans: spans.slice(0, 10) },
    );
  }
}

/** Frozen data and engine outputs keep the links they were recorded with. */
function assertLinksEditable(src: GraphNode, rule: NonNullable<ReturnType<typeof ruleFor>>, actor: Actor) {
  if (rule.annotation || isEngine(actor)) return;
  if (isEngineOutput(src) || src.frozenAt) {
    throw refuse(
      'immutable_node',
      'This is a recorded result or frozen data; its links cannot change.',
      'هذا نتيجةٌ مسجّلة أو بياناتٌ مجمّدة؛ لا يمكن تغيير روابطه.',
    );
  }
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
    /**
     * Link to a target that is replaced or invalidated anyway (say, to discuss
     * a pilot run). The new dependent is then marked out of date at once.
     */
    allowStaleTarget?: boolean;
  },
): Promise<{ edge: GraphEdge; report: ImpactReport | null; currency?: CurrencyReport }> {
  await authorize(projectId, actor, 'EDITOR');
  const rule = ruleFor(input.rel);
  if (!rule) throw AppError.validation({ rel: `Unknown relation "${input.rel}".` });
  if (rule.managed) throw AppError.validation({ rel: `"${input.rel}" is set by its own operation.` });
  /*
   * Text reports a result only through the strict claim path (WS3-A, N5):
   * no hand-made `reports` link, to a computed result or to a typed-in one,
   * from a block or a claim, by any actor. `createClaim` writes its own
   * edges and never comes through here.
   */
  if (input.rel === 'reports') throw strictClaimPath();
  if (rule.engineOnly && !isEngine(actor)) {
    throw new AppError(
      'FORBIDDEN',
      'Only the analysis engine records what a run used and produced.',
      'محرّك التحليل وحده يسجّل ما استخدمه التشغيل وما أنتجه.',
      { reason: 'engine_only' },
    );
  }
  if (input.srcId === input.dstId) throw AppError.validation({ dstId: 'A node cannot depend on itself.' });

  return db.transaction(async (tx) => {
    const src = await loadNode(tx, projectId, input.srcId, 'share');
    // Locked so a concurrent update cannot slip between reading its version and pinning to it (F-17).
    const dst = await loadNode(tx, projectId, input.dstId, 'share');
    if (!(rule.from as readonly string[]).includes(src.type) || !(rule.to as readonly string[]).includes(dst.type)) {
      throw AppError.validation({
        rel: `"${input.rel}" links ${rule.from.join('|')} → ${rule.to.join('|')}, not ${src.type} → ${dst.type}.`,
      });
    }
    if (src.status === 'superseded') {
      throw refuse('superseded', 'This has been replaced; link its replacement instead.', 'استُبدل هذا العنصر؛ اربط البديل بدلًا منه.');
    }
    assertLinksEditable(src, rule, actor);

    let targetCurrency: CurrencyReport | undefined;
    if (rule.dependency) {
      targetCurrency = await currencyOf(tx, projectId, dst.id);
      if (NOT_CURRENT.has(targetCurrency.effective) && !input.allowStaleTarget) {
        throw refuse(
          'stale_target',
          'That is out of date (replaced or invalidated). Link its current version, or confirm that you are referring to the old one.',
          'هذا العنصر غير محدَّث (مستبدَل أو ملغى). اربط نسخته الحالية، أو أكّد أنك تشير إلى القديم.',
          { currency: targetCurrency },
        );
      }
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
        createdByRunId: actor.runId ?? null, createdByStepId: actor.stepId ?? null,
        origin: actor.origin ?? 'user',
      })
      .onConflictDoNothing()
      .returning();
    if (!edge) {
      throw refuse('duplicate_edge', 'These two are already linked this way.', 'هذان العنصران مرتبطان بهذه العلاقة مسبقًا.');
    }

    const impact = await linkImpact(tx, projectId, edge);
    if (impact) {
      assertAcknowledged(impact.report, input.impactAcknowledged);
      await applyReport(tx, projectId, impact.report, impact.version);
    }

    // Knowingly linked to out-of-date evidence: the dependent is out of date too (F-3).
    if (targetCurrency && NOT_CURRENT.has(targetCurrency.effective)) {
      await tx
        .insert(staleMarks)
        .values({
          projectId,
          nodeId: src.id,
          causeNodeId: dst.id,
          causeVersion: dst.currentVersion,
          kind: 'stale_input',
          nodeVersion: src.currentVersion,
          path: [dst.id, src.id],
          severity: 'invalidates',
          reason: `${input.rel}: linked to something already out of date (${targetCurrency.effective}).`,
        })
        .onConflictDoUpdate({
          target: [staleMarks.nodeId, staleMarks.causeNodeId, staleMarks.causeVersion, staleMarks.kind],
          set: { resolvedAt: null, resolvedByUserId: null, resolution: null },
        });
      await tx
        .update(graphNodes)
        .set({ status: 'stale' })
        .where(and(eq(graphNodes.id, src.id), inArray(graphNodes.status, ['active', 'draft'])));
    }

    return { edge, report: impact?.report ?? null, ...(targetCurrency ? { currency: targetCurrency } : {}) };
  });
}

/**
 * Removes an edge. A run's record cannot be removed. Removing a provenance
 * link (the number a text reports, the source it cites) leaves the text
 * `untraced` — invalid until it is re-linked or rewritten — and flags what
 * depends on it, so it cannot keep reading as verified (F-5).
 */
export async function unlink(
  projectId: string,
  actor: Actor,
  edgeId: string,
  impactAcknowledged?: string,
): Promise<{ report: ImpactReport | null }> {
  await authorize(projectId, actor, 'EDITOR');
  return db.transaction(async (tx) => {
    const [edge] = await tx
      .select()
      .from(graphEdges)
      .where(and(eq(graphEdges.id, edgeId), eq(graphEdges.projectId, projectId)))
      .limit(1);
    if (!edge) throw AppError.notFound('link');

    const rule = ruleFor(edge.rel);
    if (rule?.engineOnly) {
      throw refuse('engine_record', 'This is part of a run’s record and stays as it was.', 'هذا جزءٌ من سجلّ التشغيل ويبقى كما هو.');
    }
    if (rule?.managed) throw AppError.validation({ rel: `"${edge.rel}" is set by its own operation.` });
    const src = await loadNode(tx, projectId, edge.srcId, 'update');
    /* A claim's evidence is part of the claim (WS3-A, N6): changed only by replacing the claim. */
    if (edge.rel === 'reports' && src.type === 'claim') {
      throw refuse('claim_record', 'A claim keeps the values it reports. Replace the claim to change them.', 'يحتفظ الادعاء بالقيم التي يوردها. استبدل الادعاء لتغييرها.');
    }
    if (rule) assertLinksEditable(src, rule, actor);

    let impact: { report: ImpactReport; version: number } | null;
    if (rule?.provenance) {
      const untraced: ReportItem = {
        nodeId: src.id,
        severity: 'invalidates',
        path: [edge.dstId, src.id],
        rel: edge.rel,
        reason: 'The link to its evidence was removed; it is no longer traced.',
        kind: 'untraced',
      };
      // What rests on the now-untraced node is affected as if it had changed structurally.
      const downstream = await computeImpact(
        { nodeId: src.id, fromVersion: src.currentVersion, kind: 'structural' },
        edgeSource(tx, projectId),
      );
      const report = await finaliseReport(
        tx,
        projectId,
        { nodeId: edge.dstId, fromVersion: edge.dstVersion ?? 0, changeKind: null },
        [untraced, ...downstream.items],
        `unlink:${edge.id}`,
      );
      impact = { report, version: edge.dstVersion ?? 0 };
    } else {
      // Measured with the edge still in place, so its own consequences count.
      impact = await linkImpact(tx, projectId, edge);
    }
    if (impact) assertAcknowledged(impact.report, impactAcknowledged);

    await tx.delete(graphEdges).where(eq(graphEdges.id, edgeId));
    if (impact) await applyReport(tx, projectId, impact.report, impact.version);
    return { report: impact?.report ?? null };
  });
}

/* -------------------------------------------------------------------------- */
/*                          Analysis runs (engine only)                        */
/* -------------------------------------------------------------------------- */

export interface RecordRunInput {
  analysisId: string;
  datasetVersionIds: string[];
  /** The run's own payload: engine, engine version, seed. */
  run: Record<string, unknown>;
  label?: string;
  results: {
    key: string;
    type: 'result_value' | 'result_table' | 'figure';
    label?: string;
    data: Record<string, unknown>;
    /** Hypotheses this value decides. */
    tests?: string[];
    /** For tables and figures: the keys of the values they show. */
    showsValues?: string[];
  }[];
  /** A previous run of the same analysis that this one replaces. */
  supersedesRunId?: string;
  impactAcknowledged?: string;
}

/** Data lineage a run freezes: the versions it used, what they derive from, their columns and cleaning steps. */
const LINEAGE_RELS = ['derived_from', 'includes', 'transformed_by', 'applies_to'];

async function freezeLineage(tx: Tx, projectId: string, datasetVersionIds: string[]) {
  const seen = new Set(datasetVersionIds);
  let frontier = [...datasetVersionIds];
  while (frontier.length > 0) {
    const edges = await tx
      .select({ dstId: graphEdges.dstId })
      .from(graphEdges)
      .where(and(eq(graphEdges.projectId, projectId), inArray(graphEdges.srcId, frontier), inArray(graphEdges.rel, LINEAGE_RELS)));
    frontier = edges.map((edge) => edge.dstId).filter((id) => !seen.has(id));
    for (const id of frontier) seen.add(id);
  }
  await tx
    .update(graphNodes)
    .set({ frozenAt: new Date() })
    .where(and(eq(graphNodes.projectId, projectId), inArray(graphNodes.id, [...seen]), isNull(graphNodes.frozenAt)));
}

/**
 * The only way a run and its outputs enter the graph: one transaction writes
 * the run, the exact analysis and data versions it used (pinned), every
 * output (`computed`, immutable) linked to it, and — when this is a re-run —
 * replaces the previous run, invalidating everything that reported it. The
 * data it used is frozen. Only the analysis engine may call this.
 */
export async function recordRun(projectId: string, actor: Actor, input: RecordRunInput) {
  if (!isEngine(actor)) {
    throw new AppError('FORBIDDEN', 'Only the analysis engine records runs.', 'محرّك التحليل وحده يسجّل عمليات التشغيل.', { reason: 'engine_only' });
  }
  await authorize(projectId, actor, 'EDITOR');
  if (input.datasetVersionIds.length === 0) throw AppError.validation({ datasetVersionIds: 'A run uses at least one dataset version.' });
  if (new Set(input.results.map((result) => result.key)).size !== input.results.length) {
    throw AppError.validation({ results: 'Result keys must be unique.' });
  }

  return db.transaction(async (tx) => {
    /*
     * Idempotent on the engine's own run id (P1-C): a retried job, or a second
     * worker, gets the run already recorded instead of recording it twice.
     */
    const engineRunId = typeof input.run.legacyRunId === 'string' ? input.run.legacyRunId : null;
    if (engineRunId) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`graph-run:${projectId}:${engineRunId}`}))`);
      const [already] = await tx
        .select()
        .from(graphNodes)
        .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.type, 'analysis_run'), sql`${graphNodes.data} ->> 'legacyRunId' = ${engineRunId}`))
        .limit(1);
      if (already) {
        const produced = await tx.select({ srcId: graphEdges.srcId }).from(graphEdges).where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.rel, 'produced_by'), eq(graphEdges.dstId, already.id)));
        const nodes = produced.length ? await tx.select().from(graphNodes).where(inArray(graphNodes.id, produced.map((edge) => edge.srcId))) : [];
        const outputs = Object.fromEntries(nodes.map((node) => [String((node.data as { key?: string }).key ?? node.id), node])) as Record<string, GraphNode>;
        return { run: already as GraphNode, outputs, report: null, alreadyRecorded: true };
      }
    }
    const analysis = await loadNode(tx, projectId, input.analysisId, 'share');
    if (analysis.type !== 'analysis') throw AppError.validation({ analysisId: 'Not an analysis.' });
    const inputs = [analysis];
    for (const id of input.datasetVersionIds) {
      const version = await loadNode(tx, projectId, id, 'share');
      if (version.type !== 'dataset_version') throw AppError.validation({ datasetVersionIds: `${id} is not a dataset version.` });
      inputs.push(version);
    }
    for (const node of inputs) {
      const currency = await currencyOf(tx, projectId, node.id);
      if (NOT_CURRENT.has(currency.effective)) {
        throw refuse(
          'stale_input',
          'The analysis or its data is out of date (replaced or invalidated); a run on it would not be current evidence.',
          'التحليل أو بياناته غير محدَّثة (مستبدَلة أو ملغاة)؛ ولن يكون التشغيل عليها دليلًا حاليًا.',
          { nodeId: node.id, currency },
        );
      }
    }

    const runPayload = parsePayload('analysis_run', input.run);
    const run = await insertNode(tx, projectId, actor, {
      type: 'analysis_run',
      label: input.label ?? null,
      payload: runPayload,
      provenance: 'computed',
    });

    const record = (srcId: string, rel: string, dstId: string, dstVersion: number | null, dependency = true) =>
      tx.insert(graphEdges).values({
        projectId,
        srcId,
        rel,
        dstId,
        dstVersion,
        dependency,
        createdByUserId: actor.userId,
        createdByRunId: actor.runId ?? null, createdByStepId: actor.stepId ?? null,
        origin: 'engine',
      });

    await record(run.id, 'executes', analysis.id, analysis.currentVersion);
    for (const version of inputs.slice(1)) await record(run.id, 'uses_data', version.id, version.currentVersion);

    const outputs: Record<string, GraphNode> = {};
    for (const result of input.results) {
      const payload = parsePayload(result.type, result.data);
      const node = await insertNode(tx, projectId, actor, { type: result.type, label: result.label ?? null, payload, provenance: 'computed' });
      outputs[result.key] = node;
      await record(node.id, 'produced_by', run.id, 1);
      for (const hypothesisId of result.tests ?? []) {
        const hypothesis = await loadNode(tx, projectId, hypothesisId);
        if (hypothesis.type !== 'hypothesis' || result.type !== 'result_value') {
          throw AppError.validation({ tests: 'Only a result value tests a hypothesis.' });
        }
        await record(node.id, 'tests', hypothesis.id, hypothesis.currentVersion);
      }
    }
    for (const result of input.results) {
      for (const key of result.showsValues ?? []) {
        const value = outputs[key];
        if (!value || value.type !== 'result_value' || result.type === 'result_value') {
          throw AppError.validation({ showsValues: `"${key}" is not a value of this run.` });
        }
        await record(outputs[result.key]!.id, 'contains_value', value.id, 1);
      }
    }

    await freezeLineage(tx, projectId, input.datasetVersionIds);

    let report: ImpactReport | null = null;
    if (input.supersedesRunId) {
      const previous = await loadNode(tx, projectId, input.supersedesRunId);
      if (previous.type !== 'analysis_run') throw AppError.validation({ supersedesRunId: 'Not a run.' });
      report = await supersedeInTx(
        tx,
        projectId,
        actor,
        previous.id,
        run.id,
        input.impactAcknowledged,
        `rerun:${previous.id}`,
        [run.id, ...Object.values(outputs).map((node) => node.id)],
      );
    }

    return { run, outputs, report, alreadyRecorded: false };
  });
}

/**
 * A manuscript claim together with its evidence, in one transaction (P1-C):
 * the claim, a `reports` edge to every value it cites, and — when given — the
 * block that asserts it. Every value must be a current result; if anything is
 * refused, nothing is written, so a claim never exists without its evidence.
 */
export async function createClaim(
  projectId: string,
  actor: Actor,
  input: {
    text: string;
    label?: string | null;
    reportIds: string[];
    blockId?: string | null;
    /**
     * WS3-A (N6): the claim this one replaces. Its text and evidence cannot
     * change, so a correction is a new claim that `supersedes` it, written in
     * this same transaction with the usual Impact Report acknowledgement.
     */
    supersedes?: string | null;
    impactAcknowledged?: string;
  },
): Promise<GraphNode> {
  await authorize(projectId, actor, 'EDITOR');
  if (input.reportIds.length === 0) throw AppError.validation({ reportIds: 'A claim reports at least one value.' });
  return db.transaction(async (tx) => {
    const values: GraphNode[] = [];
    for (const id of input.reportIds) {
      const value = await loadNode(tx, projectId, id, 'share');
      if (!(RESULT_TYPES as readonly string[]).includes(value.type)) throw AppError.validation({ reportIds: `${id} is not a result.` });
      const currency = await currencyOf(tx, projectId, value.id);
      if (NOT_CURRENT.has(currency.effective)) {
        throw refuse('stale_target', 'A cited value is out of date (replaced or invalidated); cite the current result.', 'قيمة مستشهد بها غير محدَّثة؛ استشهد بالنتيجة الحالية.', { nodeId: value.id, currency });
      }
      values.push(value);
    }
    let block: GraphNode | null = null;
    if (input.blockId) {
      block = await loadNode(tx, projectId, input.blockId, 'share');
      if (block.type !== 'block') throw AppError.validation({ blockId: 'Not a manuscript block.' });
      if (block.status === 'superseded') throw refuse('superseded', 'This block has been replaced.', 'استُبدلت هذه الكتلة.');
    }
    const claim = await insertNode(tx, projectId, actor, { type: 'claim', label: input.label ?? null, payload: parsePayload('claim', { text: input.text }), status: 'active' });
    const edge = (srcId: string, rel: string, dstId: string, dstVersion: number | null) =>
      tx.insert(graphEdges).values({ projectId, srcId, rel, dstId, dstVersion, dependency: true, createdByUserId: actor.userId, createdByRunId: actor.runId ?? null, createdByStepId: actor.stepId ?? null, origin: actor.origin ?? 'user' });
    for (const value of values) await edge(claim.id, 'reports', value.id, value.currentVersion);
    if (block) await edge(block.id, 'asserts', claim.id, claim.currentVersion);
    if (input.supersedes && block) {
      /*
       * The replacement names its block, so the block now makes the new claim
       * instead of the old one: its assertion moves, in this transaction,
       * before the Impact Report is measured, so the block is not flagged for
       * asserting a claim it no longer asserts. The old claim keeps its
       * evidence and is linked from its replacement by `supersedes`.
       */
      await tx
        .delete(graphEdges)
        .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.srcId, block.id), eq(graphEdges.rel, 'asserts'), eq(graphEdges.dstId, input.supersedes)));
    }
    if (input.supersedes) {
      /*
       * The proposal names the old claim and the new claim's content, never
       * the new claim's id (a fresh one on every attempt), so the report a
       * refused first attempt returns is the one the second must acknowledge.
       * Anything refused rolls the whole replacement back.
       */
      const proposal = `claim-replace:${input.supersedes}:${payloadHash({ text: input.text, reportIds: [...input.reportIds].sort(), blockId: input.blockId ?? null })}`;
      await supersedeInTx(tx, projectId, actor, input.supersedes, claim.id, input.impactAcknowledged, proposal, [claim.id]);
    }
    return claim;
  });
}

/**
 * The Impact Report a re-run replacing `runId` would produce, so the user can
 * review and acknowledge it before the new run is recorded (P1-C). Same
 * proposal and same dependents as `recordRun` computes, hence the same hash.
 */
/**
 * The Impact Report a supersede would produce, without making it (P1-D). The
 * same report — and so the same hash — that `supersede` checks at commit, so
 * an approval can be bound to it before anything changes.
 */
export async function previewSupersede(projectId: string, actor: Actor, oldId: string, newId: string): Promise<ImpactReport> {
  await authorize(projectId, actor, 'VIEWER');
  const previous = await loadNode(db, projectId, oldId);
  await loadNode(db, projectId, newId);
  const { report } = await buildReport(db, projectId, {
    nodeId: previous.id,
    fromVersion: previous.currentVersion,
    kind: 'structural',
    proposalHash: `supersede:${oldId}:${newId}`,
    exclude: [newId],
  });
  return report;
}

export async function previewRerun(projectId: string, actor: Actor, runId: string): Promise<ImpactReport> {
  await authorize(projectId, actor, 'VIEWER');
  const previous = await loadNode(db, projectId, runId);
  if (previous.type !== 'analysis_run') throw AppError.validation({ runId: 'Not a run.' });
  const { report } = await buildReport(db, projectId, { nodeId: previous.id, fromVersion: previous.currentVersion, kind: 'structural', proposalHash: `rerun:${previous.id}` });
  return report;
}

/* -------------------------------------------------------------------------- */
/*                                   Trace                                    */
/* -------------------------------------------------------------------------- */

/**
 * Provenance walk. `up`: what this node rests on (a reported number → its run →
 * the data and the analysis → the model and hypotheses). `down`: what rests on
 * it.
 */
export async function trace(projectId: string, actor: Actor, nodeId: string, direction: 'up' | 'down', maxDepth = 8) {
  await authorize(projectId, actor, 'VIEWER');
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

export async function listStale(projectId: string, actor: Actor, options: { includeResolved?: boolean } = {}) {
  await authorize(projectId, actor, 'VIEWER');
  return db
    .select({
      nodeId: staleMarks.nodeId,
      type: graphNodes.type,
      label: graphNodes.label,
      causeNodeId: staleMarks.causeNodeId,
      causeVersion: staleMarks.causeVersion,
      kind: staleMarks.kind,
      severity: staleMarks.severity,
      path: staleMarks.path,
      reason: staleMarks.reason,
      createdAt: staleMarks.createdAt,
      resolvedAt: staleMarks.resolvedAt,
      resolution: staleMarks.resolution,
    })
    .from(staleMarks)
    .innerJoin(graphNodes, eq(graphNodes.id, staleMarks.nodeId))
    .where(and(eq(staleMarks.projectId, projectId), options.includeResolved ? undefined : isNull(staleMarks.resolvedAt)))
    .orderBy(desc(staleMarks.createdAt))
    .limit(1000);
}

export interface MarkKey {
  causeNodeId: string;
  causeVersion: number;
  kind: string;
}

const markKey = (mark: MarkKey) => `${mark.causeNodeId}@${mark.causeVersion}/${mark.kind}`;

/**
 * Resolves a node's open marks — exactly the ones the caller names, which must
 * be all of them, so a mark that arrived after the caller looked is never
 * resolved unseen (F-13).
 *
 * - `accepted`: judged still valid as it is. Refused when it rests on
 *   something invalidated, untraced or replaced (F-2); refused for a computed
 *   run or result that was invalidated (re-run instead); refused for untraced
 *   or stale-input marks (re-link instead).
 * - `regenerated`: redone — it has a new version, or (for a removed link) a
 *   new provenance link — and what it rests on is current.
 * - `dismissed`: only for `info` marks.
 *
 * Every resolution re-pins the node's dependencies to their current versions,
 * so later changes are measured from here (F-1). A run's record keeps its pins.
 */
export async function resolveStale(
  projectId: string,
  actor: Actor,
  nodeId: string,
  resolution: 'accepted' | 'regenerated' | 'dismissed',
  marks: MarkKey[],
): Promise<{ resolved: number; currency: CurrencyReport }> {
  await authorize(projectId, actor, 'EDITOR');
  return db.transaction(async (tx) => {
    const node = await loadNode(tx, projectId, nodeId, 'update');
    const open = await tx
      .select()
      .from(staleMarks)
      .where(and(eq(staleMarks.projectId, projectId), eq(staleMarks.nodeId, nodeId), isNull(staleMarks.resolvedAt)));

    const named = new Set(marks.map(markKey));
    if (named.size !== open.length || open.some((mark) => !named.has(markKey(mark)))) {
      throw refuse(
        'marks_changed',
        'The open issues on this item have changed. Review them again before resolving.',
        'تغيّرت الملاحظات المفتوحة على هذا العنصر. راجعها مجددًا قبل الحسم.',
        { openMarks: open.map(({ causeNodeId, causeVersion, kind, severity, reason }) => ({ causeNodeId, causeVersion, kind, severity, reason })) },
      );
    }
    if (open.length === 0) return { resolved: 0, currency: await currencyOf(tx, projectId, nodeId) };

    if (resolution === 'dismissed' && open.some((mark) => mark.severity !== 'info')) {
      throw refuse('dismiss_not_allowed', 'Only informational notes can be dismissed; decide on the others.', 'يمكن تجاهل الملاحظات الإعلامية فقط؛ احسم الباقي.');
    }
    if (resolution !== 'dismissed') {
      const currency = await currencyOf(tx, projectId, nodeId);
      if (NOT_CURRENT.has(currency.upstream)) {
        throw refuse(
          'upstream_not_current',
          'This still rests on something replaced or invalidated. Update or re-link that first.',
          'ما زال هذا يعتمد على عنصرٍ مستبدَل أو ملغى. حدّثه أو أعد ربطه أولًا.',
          { currency },
        );
      }
    }
    if (resolution === 'accepted') {
      if (open.some((mark) => mark.kind !== 'stale')) {
        throw refuse('provenance_required', 'Its evidence link was removed or out of date; link current evidence or rewrite it.', 'أُزيل رابط دليله أو كان غير محدَّث؛ اربط دليلًا حاليًا أو أعد كتابته.');
      }
      if (isEngineOutput(node) && open.some((mark) => mark.severity === 'invalidates')) {
        throw refuse('rerun_required', 'An invalidated result cannot be accepted; re-run the analysis.', 'لا يمكن قبول نتيجة ملغاة؛ أعد تشغيل التحليل.');
      }
    }
    if (resolution === 'regenerated') {
      const redoneSince = Math.min(...open.map((mark) => mark.createdAt.getTime()));
      const newVersion = open.every((mark) => node.currentVersion > mark.nodeVersion);
      const [relinked] = await tx
        .select({ id: graphEdges.id })
        .from(graphEdges)
        .where(
          and(
            eq(graphEdges.projectId, projectId),
            eq(graphEdges.srcId, nodeId),
            eq(graphEdges.dependency, true),
            gte(graphEdges.createdAt, new Date(redoneSince)),
          ),
        )
        .limit(1);
      if (!newVersion && !relinked) {
        throw refuse('not_regenerated', 'Nothing has been redone yet: edit it or link current evidence first.', 'لم يُعَد إنجاز شيء بعد: عدّله أو اربط دليلًا حاليًا أولًا.');
      }
    }

    const resolved = await tx
      .update(staleMarks)
      .set({ resolvedAt: new Date(), resolvedByUserId: actor.userId, resolution })
      .where(and(eq(staleMarks.projectId, projectId), eq(staleMarks.nodeId, nodeId), isNull(staleMarks.resolvedAt)))
      .returning({ nodeId: staleMarks.nodeId });

    await tx.execute(sql`
      update graph_edges e set dst_version = n.current_version
      from graph_nodes n
      where e.project_id = ${projectId} and e.src_id = ${nodeId} and e.dependency
        and e.dst_version is not null and n.id = e.dst_id
        and e.rel not in (${sql.join(ENGINE_RELS.map((rel) => sql`${rel}`), sql`, `)})
    `);

    if (node.status === 'stale') {
      await tx.update(graphNodes).set({ status: 'active' }).where(eq(graphNodes.id, nodeId));
    }
    return { resolved: resolved.length, currency: await currencyOf(tx, projectId, nodeId) };
  });
}

export { isResultType };
