/**
 * What the agent tells the interface while it works.
 *
 * The existing chat streams `delta` and `done` — text arriving a token at a
 * time. That is the right shape for a single answer and the wrong one for a
 * task with stages: a user who asks for an analysis and watches a blank panel
 * for eight seconds cannot tell whether it is thinking, stuck, or broken.
 *
 * So the agent streams structure as well as text. The existing event names keep
 * their meaning, and the new ones sit alongside — an extension rather than a
 * replacement, so the current chat panel is untouched.
 *
 * `result` carries a real object rather than a rendered table. Storing the
 * numbers and letting the interface draw them means reopening a conversation
 * redraws the actual table, and means the same result can be exported or
 * attached to a chapter later without being parsed back out of prose.
 */

import type { InferentialResult } from '@/analysis';

import type { IntentKey } from './registry';

export type AgentEventType =
  /**
   * The conversation this turn belongs to.
   *
   * Sent first, before any work begins, because the client needs it to update
   * the URL — so a refresh in the middle of a long answer returns to the right
   * thread rather than to an empty one.
   */
  | 'conversation'
  /** The agent's reading of the request, before it acts. */
  | 'understanding'
  /** The stages it intends to run, with the estimated cost. */
  | 'plan'
  /** A stage starting or finishing. */
  | 'step'
  /** A structured result — an analysis, a profile, a recommendation. */
  | 'result'
  /** A question the agent needs answered before it can continue. */
  | 'question'
  /** A capability that exists in the catalogue but is not built yet. */
  | 'unavailable'
  /** Streaming prose, same meaning as in the existing chat. */
  | 'delta'
  /** The task finished, with what it actually cost. */
  | 'done'
  | 'error';

export interface ConversationEvent {
  type: 'conversation';
  conversationId: string;
}

export interface UnderstandingEvent {
  type: 'understanding';
  intent: IntentKey;
  confidence: number;
  restatement: string;
  columns: string[];
}

export interface PlanStep {
  id: string;
  /** Message key, so the interface can say it in either language. */
  labelKey: string;
  params?: Record<string, string | number>;
}

export interface PlanEvent {
  type: 'plan';
  steps: PlanStep[];
  /**
   * What this will draw from the user's monthly allowance.
   *
   * Announced before the work starts rather than billed after it. Zero for
   * anything statistical, and that is not a courtesy — an analysis makes no
   * model calls, so there is nothing to charge for.
   */
  estimatedUnits: number;
  /** The task cannot exceed this. A runaway loop costs the developer, not the user. */
  maxUnits: number;
}

export interface StepEvent {
  type: 'step';
  id: string;
  status: 'running' | 'done' | 'failed';
  labelKey: string;
  params?: Record<string, string | number>;
  detail?: string;
}

export type AgentResultKind =
  | 'profile'
  | 'cleaning'
  | 'recommendation'
  | 'analysis'
  | 'reliability'
  | 'correlationMatrix'
  /** Academic sources returned by a real database search. */
  | 'literature';

export interface ResultEvent {
  type: 'result';
  kind: AgentResultKind;
  /** Persisted id, when the result was saved and can be attached to a chapter. */
  runId?: string;
  datasetId?: string;
  payload: InferentialResult | Record<string, unknown>;
}

export interface QuestionEvent {
  type: 'question';
  question: string;
  /** Tappable answers when the choice is closed — a column, a test, a group. */
  options?: { value: string; label: string }[];
}

/**
 * A recognised request the product cannot serve yet.
 *
 * Deliberately its own event rather than an error. The request was understood;
 * declining it precisely — "that is PLS-SEM, which is not built yet" — teaches
 * the user what the tool does, where a generic failure teaches nothing and a
 * substituted analysis actively misleads.
 */
export interface UnavailableEvent {
  type: 'unavailable';
  intent: IntentKey;
  reasonKey: string;
  /** What can be done instead, when something reasonable exists. */
  alternatives: IntentKey[];
}

export interface DeltaEvent {
  type: 'delta';
  text: string;
}

export interface DoneEvent {
  type: 'done';
  taskId: string | null;
  /** What it actually cost, against what was announced. */
  units: number;
  aiRequests: number;
  durationMs: number;
}

export interface ErrorEvent {
  type: 'error';
  messageKey: string;
  message: string;
  params?: Record<string, string | number>;
}

export type AgentEvent =
  | ConversationEvent
  | UnderstandingEvent
  | PlanEvent
  | StepEvent
  | ResultEvent
  | QuestionEvent
  | UnavailableEvent
  | DeltaEvent
  | DoneEvent
  | ErrorEvent;

/** Serialised as one SSE `data:` line, matching the existing chat transport. */
export function encodeEvent(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
