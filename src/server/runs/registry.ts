/**
 * The tool registry (P1-D): the one authoritative list of what a research run
 * — or the analysis assistant — may execute.
 *
 * Frozen at module load. A name not in it cannot be executed, whatever a model
 * or a client asks for. Every entry is checked here, at startup, against the
 * rules the policy relies on: a unique provider-safe name, bounded schemas, a
 * keyed idempotency policy for anything that creates or changes something, and
 * exactly one attempt for destructive tools.
 */

import { z } from 'zod';

import type { GatewayTool } from '@/server/ai/gateway/contract';
import { defineTool } from '@/server/ai/gateway/tools';

import { DATA_TOOLS } from './tools/data';
import { GRAPH_TOOLS } from './tools/graph';
import { RESEARCH_TOOLS } from './tools/research';
import { STATISTICS_TOOLS } from './tools/statistics';
import { WRITING_TOOLS } from './tools/writing';
import type { ToolContextKind, ToolDef } from './types';

const NAME = /^[a-zA-Z][a-zA-Z0-9]{2,63}$/;

function check(tool: ToolDef): ToolDef {
  if (!NAME.test(tool.name)) throw new Error(`tool registry: invalid name ${tool.name}`);
  if (!/^\d+\.\d+\.\d+$/.test(tool.version)) throw new Error(`tool registry: ${tool.name} needs a semver version`);
  if (tool.timeoutMs <= 0 || tool.maxAttempts < 1) throw new Error(`tool registry: ${tool.name} needs a timeout and at least one attempt`);
  const creates = tool.sideEffect !== 'read' && tool.sideEffect !== 'external_read' && tool.sideEffect !== 'compute';
  if (creates && tool.idempotency !== 'keyed') throw new Error(`tool registry: ${tool.name} writes, so it must be idempotent on the step key`);
  if (tool.name === 'createAnalysisSpec' || tool.name === 'runAnalysis') {
    if (tool.idempotency !== 'keyed') throw new Error(`tool registry: ${tool.name} creates scientific records, so it must be keyed`);
  }
  if (tool.sideEffect === 'destructive' && tool.maxAttempts !== 1) throw new Error(`tool registry: destructive ${tool.name} is never retried`);
  if (tool.contexts.length === 0 || tool.tiers.length === 0) throw new Error(`tool registry: ${tool.name} is available nowhere`);
  return Object.freeze(tool);
}

const ALL: readonly ToolDef[] = Object.freeze([...DATA_TOOLS, ...STATISTICS_TOOLS, ...RESEARCH_TOOLS, ...WRITING_TOOLS, ...GRAPH_TOOLS].map(check));

const BY_NAME: ReadonlyMap<string, ToolDef> = (() => {
  const map = new Map<string, ToolDef>();
  for (const tool of ALL) {
    if (map.has(tool.name)) throw new Error(`tool registry: duplicate tool ${tool.name}`);
    map.set(tool.name, tool);
  }
  return map;
})();

/** The tool, or null: an unknown name is never executed. */
export function toolByName(name: unknown): ToolDef | null {
  return typeof name === 'string' ? (BY_NAME.get(name) ?? null) : null;
}

export function listTools(context?: ToolContextKind): readonly ToolDef[] {
  return context ? ALL.filter((tool) => tool.contexts.includes(context)) : ALL;
}

export const TOOL_NAMES: readonly string[] = Object.freeze(ALL.map((tool) => tool.name));

/** The gateway's view of the named tools (name, description, JSON Schema, validator), via the gateway's own `defineTool`. */
export function gatewayToolsFor(names: Iterable<string>): GatewayTool[] {
  const wanted = new Set(names);
  return ALL.filter((tool) => wanted.has(tool.name)).map((tool) => defineTool(tool.name, tool.description, tool.input as z.ZodType<Record<string, unknown>>));
}
