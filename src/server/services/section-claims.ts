/**
 * Claims referenced from manuscript sections (WS3-D, D1 and D2).
 *
 * D1 — the reference is the source of truth. A section names a claim as
 * `{{claim:<id>}}` (`@/server/integrity/claims`). Before the text is saved,
 * every reference is resolved here: the claim must exist in the same project,
 * be current (not replaced, not resting on invalidated or replaced evidence),
 * and, if its text carries research numbers, show only verified values — that
 * is, it was written through the strict claim path (WS3-A) and its values are
 * still current. What resolves becomes part of the section's integrity record
 * (its numbers count as traced); what does not is refused (a person's edit) or
 * quarantined (a model's text) by the callers, never kept as manual numbers.
 *
 * D2 — the graph mirror is derived from the validated references, never the
 * other way round. For each section that references claims, the graph holds
 *
 *   section ─has_block→ block ─asserts→ claim   (one block per section)
 *
 * written through the ordinary graph service (its rules, currency and impact
 * protocol apply). Each save brings the block's `asserts` edges in line with
 * the references it saved: missing ones are linked, dropped ones unlinked, and
 * nothing is duplicated, so saving the same text again changes nothing. Behind
 * `FF_GRAPH`: with the graph off nothing is mirrored, and the next save after
 * it is turned on brings the mirror up to date.
 */

import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { SectionKey } from '@/config/research';
import { logger } from '@/lib/logger';
import { db } from '@/server/db';
import { graphEdges, graphNodes, staleMarks } from '@/server/db/schema';
import { graphEnabled } from '@/server/graph/access';
import * as graph from '@/server/graph/service';
import { claimIdsIn } from '@/server/integrity/claims';
import { researchNumbers } from '@/server/integrity/numbers';
import type { SectionClaim, UnresolvedClaim } from '@/server/integrity/section';

/** More references than this in one section are refused as a whole (a bound on the work one save does). */
const MAX_REFERENCES = 200;

export interface ClaimReferences {
  /** Current, verified claims, in order of first reference. */
  claims: SectionClaim[];
  unresolved: UnresolvedClaim[];
}

/**
 * Resolves every `{{claim:id}}` in `text` against the project's graph, as
 * `userId` (who must be able to read the project). Read-only.
 */
export async function resolveClaimReferences(projectId: string, userId: string, text: string): Promise<ClaimReferences> {
  const ids = claimIdsIn(text);
  if (ids.length === 0) return { claims: [], unresolved: [] };
  if (ids.length > MAX_REFERENCES) return { claims: [], unresolved: ids.map((id) => ({ id, reason: 'not_found' as const })) };

  const rows = await db
    .select({ id: graphNodes.id, type: graphNodes.type, data: graphNodes.data })
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), inArray(graphNodes.id, ids)));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const claims: SectionClaim[] = [];
  const unresolved: UnresolvedClaim[] = [];
  for (const id of ids) {
    const node = byId.get(id);
    if (!node) {
      unresolved.push({ id, reason: 'not_found' });
      continue;
    }
    if (node.type !== 'claim') {
      unresolved.push({ id, reason: 'not_a_claim' });
      continue;
    }
    const currency = await graph.assess(projectId, { userId }, id);
    if (currency.effective !== 'current') {
      unresolved.push({ id, reason: 'not_current' });
      continue;
    }
    /*
     * A claim with research numbers shows only verified values: computed by
     * the engine and current (WS3-A: only the strict claim path links them).
     * One without (from the literature, say) reports nothing and stays so.
     */
    const numbers = researchNumbers(String((node.data as { text?: unknown }).text ?? ''), 'person').length;
    const verified = numbers > 0 ? currency.verification === 'verified' : currency.verification === 'none' || currency.verification === 'verified';
    if (!verified) {
      unresolved.push({ id, reason: 'not_verified' });
      continue;
    }
    claims.push({ id, numbers });
  }
  return { claims, unresolved };
}

/* -------------------------------------------------------------------------- */
/*                                 The mirror                                 */
/* -------------------------------------------------------------------------- */

/** The mirror block of a section is found by its role, which names the section. */
const blockRole = (sectionKey: SectionKey) => `claims:${sectionKey}`;

async function lockAnd<T>(key: string, work: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    return work();
  });
}

export interface SectionMirror {
  blockId: string | null;
  linked: string[];
  unlinked: string[];
}

/**
 * Brings the section's graph mirror in line with the claims its saved text
 * references (already validated by `resolveClaimReferences`). Serialised per
 * section, so two saves at once cannot create two mirrors. Null when the graph
 * is off.
 */
export async function mirrorSectionClaims(projectId: string, userId: string, sectionKey: SectionKey, claimIds: readonly string[]): Promise<SectionMirror | null> {
  if (!graphEnabled()) return null;
  const actor: graph.Actor = { userId };
  const role = blockRole(sectionKey);
  const wanted = [...new Set(claimIds)];

  return lockAnd(`graph-section-mirror:${projectId}:${sectionKey}`, async () => {
    const [existing] = await db
      .select({ id: graphNodes.id })
      .from(graphNodes)
      .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.type, 'block'), ne(graphNodes.status, 'superseded'), sql`${graphNodes.data} ->> 'role' = ${role}`))
      .limit(1);
    /* A section that never referenced a claim gets no mirror. */
    if (!existing && wanted.length === 0) return { blockId: null, linked: [], unlinked: [] };

    let blockId = existing?.id;
    if (!blockId) {
      const section = await graph.createNode(projectId, actor, { type: 'section', label: sectionKey, data: { key: sectionKey }, status: 'active' });
      const block = await graph.createNode(projectId, actor, { type: 'block', label: `${sectionKey} · claims`, data: { text: '', role }, status: 'active' });
      await graph.link(projectId, actor, { srcId: section.id, rel: 'has_block', dstId: block.id });
      blockId = block.id;
    }

    const asserted = await db
      .select({ id: graphEdges.id, dstId: graphEdges.dstId })
      .from(graphEdges)
      .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.srcId, blockId), eq(graphEdges.rel, 'asserts')));
    const unlinked: string[] = [];
    for (const edge of asserted.filter((candidate) => !wanted.includes(candidate.dstId))) {
      await graph.unlink(projectId, actor, edge.id);
      unlinked.push(edge.dstId);
    }
    const linked: string[] = [];
    for (const claimId of wanted.filter((id) => !asserted.some((edge) => edge.dstId === id))) {
      await graph.link(projectId, actor, { srcId: blockId, rel: 'asserts', dstId: claimId });
      linked.push(claimId);
    }

    /*
     * The block may still carry marks from a claim it asserted that was since
     * replaced or invalidated. Once the saved text references only current,
     * verified claims and the block has been re-linked to them, that is the
     * graph's "regenerated" resolution — which itself refuses if anything the
     * block rests on is still not current.
     */
    if (linked.length > 0) {
      const open = await db
        .select({ causeNodeId: staleMarks.causeNodeId, causeVersion: staleMarks.causeVersion, kind: staleMarks.kind })
        .from(staleMarks)
        .where(and(eq(staleMarks.projectId, projectId), eq(staleMarks.nodeId, blockId), isNull(staleMarks.resolvedAt)));
      if (open.length > 0) {
        try {
          await graph.resolveStale(projectId, actor, blockId, 'regenerated', open);
        } catch (error) {
          logger.warn('section.claims.markNotResolved', { projectId, sectionKey, blockId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return { blockId, linked, unlinked };
  });
}

/**
 * The mirror after a save. The saved text is the record: if the graph write
 * fails, the save stands and the next save brings the mirror up to date.
 */
export async function mirrorAfterSave(projectId: string, userId: string, sectionKey: SectionKey, claimIds: readonly string[]): Promise<SectionMirror | null> {
  try {
    return await mirrorSectionClaims(projectId, userId, sectionKey, claimIds);
  } catch (error) {
    logger.error('section.claims.mirrorFailed', { projectId, sectionKey, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
