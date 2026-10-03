/**
 * The memory.propose capability (P1-E, PR #5), as the run tool `proposeMemory`
 * (tool names are provider-safe identifiers, so no dot).
 *
 * An agent may only **propose** a memory. The tool takes no status and no
 * source: it always writes `source: agent, status: proposed`, and the
 * database's guard refuses an agent memory in any other status even if this
 * code were changed. A proposal is never used in context; it becomes a
 * memory only when a person confirms it (`memory/service.confirmMemoryIn`,
 * through the memory API). The run and step that proposed it are kept in the
 * memory's origin.
 *
 * It writes through the memory scope as the run's user, so RLS applies: a
 * project proposal needs the EDITOR role (the tool's own requirement and the
 * database's create policy). Keyed on the step, so a retried step never
 * proposes twice.
 */

import { z } from 'zod';

import { createMemory, findByStep } from '@/server/memory/repository';

import { defineRunTool } from '../types';

const KINDS = ['preference', 'fact', 'instruction', 'style', 'decision'] as const;

export const proposeMemory = defineRunTool({
  name: 'proposeMemory',
  version: '1.0.0',
  description:
    'Propose something to remember: a preference, fact, instruction, style or decision, for the user or for the project. It is only a proposal: it is never used until the user confirms it.',
  category: 'memory',
  input: z
    .object({
      scope: z.enum(['user', 'project']),
      kind: z.enum(KINDS),
      content: z.string().trim().min(1).max(2000),
    })
    .strict(),
  output: z.object({ memoryId: z.string().max(64), status: z.literal('proposed'), created: z.boolean() }).strict(),
  sideEffect: 'write',
  risk: 'low',
  requiredRole: 'EDITOR',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run'],
  timeoutMs: 15_000,
  maxAttempts: 2,
  idempotency: 'keyed',
  estimatedModelCalls: 0,
  resources: () => [],
  /* Nothing is applied: the user's confirmation is the approval. */
  approval: async () => null,
  async execute(input, ctx) {
    if (ctx.stepId) {
      const existing = await findByStep(ctx.userId, ctx.stepId);
      if (existing) return { output: { memoryId: existing.id, status: 'proposed' as const, created: false }, ref: { kind: 'memory', id: existing.id } };
    }
    const memory = await createMemory(ctx.userId, {
      scope: input.scope,
      projectId: input.scope === 'project' ? ctx.projectId : null,
      kind: input.kind,
      content: input.content,
      source: 'agent',
      status: 'proposed',
      origin: { runId: ctx.runId ?? null, stepId: ctx.stepId ?? null, tool: 'proposeMemory', projectId: ctx.projectId },
    });
    return { output: { memoryId: memory.id, status: 'proposed' as const, created: true }, ref: { kind: 'memory', id: memory.id } };
  },
});

export const MEMORY_TOOLS = [proposeMemory];
