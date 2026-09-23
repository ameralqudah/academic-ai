/**
 * Native tool calling (P1-B §2.7): declaration, permission, validation.
 *
 * - One zod schema per tool is both the JSON Schema sent to the provider and
 *   the validator its arguments must pass. Nothing the model returns is treated
 *   as data before it passes.
 * - A tool is offered to the model only if the run is permitted to use it, and
 *   a call is accepted only if the tool was both offered and permitted — a
 *   model cannot widen its own permissions by naming another tool.
 * - What a model may execute is defined in one place: the research-run tool
 *   registry (`src/server/runs/registry.ts`, P1-D), which builds its gateway
 *   tools with `defineTool` and decides `permittedTools` through its policy.
 *   `capabilityTool` projects the task capability registry for tests only.
 */

import { z } from 'zod';

import { isKnownCapability } from '@/server/tasks/capabilities';

import type { GatewayTool, ValidatedToolCall } from './contract';
import { GatewayError } from './errors';

const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** Declares a tool from one zod object schema. */
export function defineTool<T extends z.ZodType<Record<string, unknown>>>(name: string, description: string, schema: T): GatewayTool {
  if (!TOOL_NAME.test(name)) throw new GatewayError('invalid_request', `Invalid tool name "${name}".`);
  return { name, description, parameters: z.toJSONSchema(schema) as Record<string, unknown>, validate: schema };
}

/**
 * A tool for a capability of the existing registry. The capability id must
 * exist; providers accept only `[a-zA-Z0-9_-]`, so `web.search` is exposed as
 * `web_search` and mapped back by `capabilityOf`.
 */
export function capabilityTool<T extends z.ZodType<Record<string, unknown>>>(capabilityId: string, description: string, schema: T): GatewayTool {
  if (!isKnownCapability(capabilityId)) {
    throw new GatewayError('invalid_request', `Unknown capability "${capabilityId}".`);
  }
  return defineTool(capabilityId.replace(/\./g, '_'), description, schema);
}

export function capabilityOf(toolName: string): string {
  return toolName.replace(/_/g, '.');
}

export interface RejectedToolCall {
  id: string;
  name: string;
  reason: 'not_offered' | 'not_permitted' | 'invalid_arguments';
  detail: string;
  raw: string;
}

/** The tools the model may see: declared and permitted. */
export function offeredTools(tools: GatewayTool[], permitted: ReadonlySet<string>): GatewayTool[] {
  return tools.filter((tool) => permitted.has(tool.name));
}

/** Splits the model's calls into validated ones and rejected ones. Never throws on model output. */
export function validateToolCalls(
  calls: { id: string; name: string; arguments: unknown }[],
  offered: GatewayTool[],
  permitted: ReadonlySet<string>,
): { accepted: ValidatedToolCall[]; rejected: RejectedToolCall[] } {
  const byName = new Map(offered.map((tool) => [tool.name, tool]));
  const accepted: ValidatedToolCall[] = [];
  const rejected: RejectedToolCall[] = [];

  for (const call of calls) {
    const raw = (typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? null)).slice(0, 4000);
    const tool = byName.get(call.name);
    if (!permitted.has(call.name)) {
      rejected.push({ id: call.id, name: call.name, reason: 'not_permitted', detail: 'The tool is not permitted for this run.', raw });
      continue;
    }
    if (!tool) {
      rejected.push({ id: call.id, name: call.name, reason: 'not_offered', detail: 'The tool was not offered.', raw });
      continue;
    }
    const parsed = tool.validate.safeParse(call.arguments);
    if (!parsed.success) {
      rejected.push({
        id: call.id,
        name: call.name,
        reason: 'invalid_arguments',
        detail: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ').slice(0, 1000),
        raw,
      });
      continue;
    }
    accepted.push({ id: call.id, name: call.name, arguments: parsed.data });
  }
  return { accepted, rejected };
}
