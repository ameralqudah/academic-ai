/**
 * Numbers in a chat reply (WS2 N11).
 *
 * Chat is conversation, not manuscript: a reply is never rewritten, and it
 * never reaches a section (only `generateSection`, which quarantines, writes
 * model text into one). What this adds is an accurate flag. A research number
 * in a reply is traced to what this conversation and project computed, and to
 * the researcher's current message; anything else is flagged as untraced and
 * the flag is stored on the assistant message.
 *
 * The allowed values follow the same rules as section writing:
 * - analyses attached to the project and runs recorded in the conversation,
 *   through `allowedFromLegacyResults`, so windowed runs contribute nothing
 *   (WS2 D3);
 * - result payloads the conversation stored with no run row behind them
 *   (a profile, a PLS estimate shown in chat) count as unpinned results,
 *   never as verified ones;
 * - only the current message is the researcher's. An earlier turn is not: a
 *   number the assistant wrote before, and the user did not restate, is not
 *   made legitimate by having been said.
 */

import { inspectOutput, type GuardrailResult } from '@/ai/guardrails';
import { logger } from '@/lib/logger';
import { allowedFromLegacyResults, emptyScopedValues, type LegacyResultLike, type ScopedValues } from '@/server/integrity/numbers';
import * as analysisRunsRepo from '@/server/repositories/analysis-runs.repository';
import * as conversationsRepo from '@/server/repositories/conversations.repository';

export interface ChatScope {
  userId: string;
  projectId?: string | null;
  conversationId?: string | null;
}

/** Result payloads stored on the conversation's messages (`payload.results`). */
function storedResults(payload: unknown): { runId?: unknown; payload?: unknown }[] {
  const results = (payload as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? (results.filter((item) => item && typeof item === 'object') as { runId?: unknown; payload?: unknown }[]) : [];
}

/** The values a chat reply may repeat in this scope, by class. */
export async function chatAllowedValues(scope: ChatScope): Promise<ScopedValues> {
  const [attached, recorded, messages] = await Promise.all([
    scope.projectId ? analysisRunsRepo.listAttached(scope.projectId, scope.userId) : Promise.resolve([]),
    scope.conversationId ? analysisRunsRepo.listByConversation(scope.conversationId, scope.userId) : Promise.resolve([]),
    scope.conversationId ? conversationsRepo.listMessagesOwned(scope.conversationId, scope.userId, 50) : Promise.resolve([]),
  ]);

  const runs = new Map<string, LegacyResultLike>();
  for (const run of [...attached, ...recorded]) runs.set(run.id, run);

  const unpinned: LegacyResultLike[] = [];
  for (const message of messages) {
    for (const item of storedResults(message.payload)) {
      const runId = typeof item.runId === 'string' ? item.runId : null;
      if (runId && runs.has(runId)) continue;
      if (runId) {
        const run = await analysisRunsRepo.findOwned(runId, scope.userId);
        if (run) {
          runs.set(run.id, run);
          continue;
        }
      }
      /* No run row: a computed payload, counted as unpinned (never verified). */
      if (item.payload && typeof item.payload === 'object') unpinned.push({ result: item.payload });
    }
  }

  return allowedFromLegacyResults([...runs.values(), ...unpinned]).values;
}

/** The flags for a reply, given the allowed values and the current message. Never changes the text. */
export function inspectChatReply(text: string, input: { allowed: ScopedValues; message: string }): GuardrailResult {
  return inspectOutput(text, {
    verifiedNumbers: input.allowed,
    ...(input.message.trim() ? { context: [input.message] } : {}),
    surface: 'chat',
  });
}

/**
 * Checks a finished reply. A failure to read the allowed values must not fail
 * the answer: the reply is then checked against nothing, so its numbers are
 * flagged rather than passed.
 */
export async function checkChatReply(input: ChatScope & { message: string; text: string }): Promise<GuardrailResult> {
  const allowed = await chatAllowedValues(input).catch((error: unknown) => {
    logger.warn('chat.integrity.allowedUnavailable', { error: String(error).slice(0, 200) });
    return emptyScopedValues();
  });
  return inspectChatReply(input.text, { allowed, message: input.message });
}
