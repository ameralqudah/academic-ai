/**
 * Research Graph tools: read the graph, add a hypothesis/construct/note, and
 * cite verified values in a manuscript claim. Writes go through the graph
 * service (P1-A/A.1 rules unchanged) with the run and step recorded as
 * provenance; a step creates at most one node of a type (unique index), so a
 * retried step finds what it already created.
 */

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/server/db';
import { graphNodes } from '@/server/db/schema';
import * as graph from '@/server/graph/service';
import { AppError } from '@/server/http/errors';
import { insertClaim } from '@/server/stats/manuscript';
import { requireRun } from '@/server/stats/runs';

import { defineRunTool, type ToolContext } from '../types';

const id = z.string().min(1).max(64);
const record = z.record(z.string(), z.unknown());

const agentActor = (ctx: ToolContext): graph.Actor => ({ userId: ctx.userId, runId: ctx.runId, stepId: ctx.stepId, origin: 'agent' });

/** What this step already created, if a previous attempt got that far. */
async function createdByStep(ctx: ToolContext, type: string) {
  if (!ctx.stepId) return null;
  const [node] = await db
    .select()
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, ctx.projectId), eq(graphNodes.createdByStepId, ctx.stepId), eq(graphNodes.type, type)))
    .limit(1);
  return node ?? null;
}

const isUniqueViolation = (error: unknown) => String((error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code) === '23505';

export const readGraph = defineRunTool({
  name: 'readGraph',
  version: '1.0.0',
  description: 'Read the Research Graph: nodes of a type, or the provenance trace of one node (up: what it rests on; down: what rests on it).',
  category: 'graph',
  input: z
    .object({
      type: z.string().max(40).optional(),
      nodeId: id.optional(),
      direction: z.enum(['up', 'down']).default('up'),
      limit: z.number().int().min(1).max(50).default(25),
    })
    .strict(),
  output: z.object({ nodes: z.array(record).max(200), edges: z.array(record).max(400) }).strict(),
  sideEffect: 'read',
  risk: 'low',
  requiredRole: 'VIEWER',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run'],
  timeoutMs: 30_000,
  maxAttempts: 2,
  idempotency: 'natural',
  estimatedModelCalls: 0,
  resources: (input) => (input.nodeId ? [{ kind: 'graphNode', id: input.nodeId }] : []),
  approval: async () => null,
  async execute(input, ctx) {
    const pick = (node: { id: string; type: string; label: string | null; status: string; data: unknown }) => ({ id: node.id, type: node.type, label: node.label, status: node.status, data: node.data });
    if (input.nodeId) {
      const traced = await graph.trace(ctx.projectId, { userId: ctx.userId }, input.nodeId, input.direction, 4);
      return {
        output: {
          nodes: (traced.nodes as Parameters<typeof pick>[0][]).slice(0, 200).map(pick),
          edges: (traced.edges as { srcId: string; rel: string; dstId: string }[]).slice(0, 400).map((edge) => ({ srcId: edge.srcId, rel: edge.rel, dstId: edge.dstId })),
        },
      };
    }
    const nodes = await graph.listNodes(ctx.projectId, { userId: ctx.userId }, { type: input.type as never, limit: input.limit });
    return { output: { nodes: nodes.slice(0, input.limit).map(pick), edges: [] } };
  },
});

const WRITABLE_TYPES = ['hypothesis', 'construct', 'note'] as const;

export const createGraphNode = defineRunTool({
  name: 'createGraphNode',
  version: '1.0.0',
  description: 'Add a hypothesis, construct or note to the Research Graph. Results and runs are never created this way.',
  category: 'graph',
  input: z.object({ type: z.enum(WRITABLE_TYPES), label: z.string().trim().max(200).optional(), data: record }).strict(),
  output: z.object({ nodeId: id, type: z.string(), created: z.boolean() }).strict(),
  sideEffect: 'write',
  risk: 'low',
  requiredRole: 'EDITOR',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run'],
  timeoutMs: 30_000,
  maxAttempts: 2,
  idempotency: 'keyed',
  estimatedModelCalls: 0,
  resources: () => [],
  approval: async () => null,
  async execute(input, ctx) {
    const existing = await createdByStep(ctx, input.type);
    if (existing) return { output: { nodeId: existing.id, type: existing.type, created: false }, ref: { kind: 'graph_node', id: existing.id } };
    try {
      const node = await graph.createNode(ctx.projectId, agentActor(ctx), { type: input.type, label: input.label ?? null, data: input.data, status: 'active' });
      return { output: { nodeId: node.id, type: node.type, created: true }, ref: { kind: 'graph_node', id: node.id } };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const made = await createdByStep(ctx, input.type);
        if (made) return { output: { nodeId: made.id, type: made.type, created: false }, ref: { kind: 'graph_node', id: made.id } };
      }
      throw error;
    }
  },
});

export const createClaim = defineRunTool({
  name: 'createClaim',
  version: '1.0.0',
  description: 'Write a manuscript claim that cites verified values of a statistics run. Numbers only as {{value:key}} tokens. Always needs approval.',
  category: 'graph',
  input: z.object({ runId: id, keys: z.array(z.string().min(1).max(1000)).min(1).max(50), text: z.string().trim().max(2000).optional() }).strict(),
  output: z.object({ claimId: id, text: z.string().max(6000), keys: z.array(z.string()).max(50), created: z.boolean() }).strict(),
  sideEffect: 'write',
  risk: 'medium',
  requiredRole: 'EDITOR',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run'],
  timeoutMs: 30_000,
  maxAttempts: 2,
  idempotency: 'keyed',
  estimatedModelCalls: 0,
  resources: (input) => [{ kind: 'statRun', id: input.runId }],
  async approval(input, ctx) {
    const run = await requireRun(input.runId, { userId: ctx.userId }, 'VIEWER', ctx.projectId);
    return {
      reason: 'manuscript_claim',
      summary: {
        en: `Add a manuscript claim citing ${input.keys.length} verified value(s) of this analysis.`,
        ar: `إضافة ادعاء إلى المخطوطة يستشهد بـ ${input.keys.length} قيمة موثّقة من هذا التحليل.`,
      },
      targets: { statRunId: run.id, resultHash: run.resultHash ?? '' },
      preview: { keys: input.keys.slice(0, 20), text: input.text ?? null },
    };
  },
  async execute(input, ctx) {
    const existing = await createdByStep(ctx, 'claim');
    if (existing) {
      const text = String((existing.data as { text?: string }).text ?? '');
      return { output: { claimId: existing.id, text: text.slice(0, 6000), keys: input.keys, created: false }, ref: { kind: 'claim', id: existing.id } };
    }
    try {
      const made = await insertClaim({ userId: ctx.userId }, ctx.projectId, input.runId, { keys: input.keys, text: input.text, actor: agentActor(ctx) });
      return { output: { claimId: made.claim.id, text: made.text.slice(0, 6000), keys: made.keys.slice(0, 50), created: true }, ref: { kind: 'claim', id: made.claim.id } };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const made = await createdByStep(ctx, 'claim');
        if (made) return { output: { claimId: made.id, text: String((made.data as { text?: string }).text ?? '').slice(0, 6000), keys: input.keys, created: false }, ref: { kind: 'claim', id: made.id } };
      }
      if (error instanceof AppError) throw error;
      throw error;
    }
  },
});

export const GRAPH_TOOLS = [readGraph, createGraphNode, createClaim];
