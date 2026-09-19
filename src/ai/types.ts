import type { SectionKey, ToolKey } from '@/config/research';

export type ProviderName = 'anthropic' | 'openai' | 'google';

export type AITask =
  | 'titles.generate'
  | 'titles.improve'
  | 'titles.compare'
  | 'wizard.section'
  | 'chat'
  | `tool.${ToolKey}`;

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
  /**
   * Prompt-caching counters. Every request carries the project context, which is
   * large and mostly unchanged between calls — caching it is the single biggest
   * lever on input cost. Providers that cache implicitly leave these at zero.
   */
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

export interface AIChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The compact snapshot of a project that travels with every request.
 * This is what keeps the problem, questions, objectives, hypotheses and
 * methodology consistent with one another across separate generations.
 */
export interface ProjectContext {
  title: string;
  academicField: string;
  specialization: string | null;
  degree: 'BACHELOR' | 'MASTER' | 'PHD' | 'PAPER';
  language: 'AR' | 'EN';
  researchType: string;
  docType: 'PAPER' | 'PROPOSAL' | 'THESIS';
  keywords: string[];
  problemArea: string | null;
  /** Approved / edited sections, already truncated to fit the context budget. */
  sections: { key: SectionKey; heading: string; excerpt: string; approved: boolean }[];
}

export type AIEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AIRequest {
  task: AITask;
  locale: 'ar' | 'en';
  /** System prompt assembled by the PromptRegistry. */
  system: string;
  messages: AIChatMessage[];
  maxTokens?: number;
  /**
   * Ignored by models that reason adaptively, which reject it outright — see
   * `AIEffort`. Still honoured by OpenAI, Google, and older Claude models.
   */
  temperature?: number;
  /**
   * How hard the model should think, on providers that expose the choice.
   *
   * This is the knob that replaced `temperature` for the Claude 4.6 generation
   * onwards: instead of sampling more loosely for creative work, the model
   * reasons for longer before answering. Reasoning tokens are billed as output,
   * so this is the cost/quality dial — `low` for extraction and classification,
   * `high` (the default everywhere it applies) for research design and
   * statistics, where being right matters more than being cheap.
   */
  effort?: AIEffort;
  /** When set, the provider is asked to return JSON only. */
  json?: boolean;
  /**
   * The shape that JSON must take, as JSON Schema.
   *
   * `json: true` is a request; this is a guarantee. OpenAI and Google have a
   * schema-less JSON mode, so `json` alone is enough for them, but Claude has
   * no such mode — asking it for JSON without a schema is just a sentence in
   * the prompt, which is why `parseJsonOutput` exists to dig an object out of
   * whatever came back. Give a schema and the answer is constrained to it
   * instead, and there is nothing left to dig through.
   *
   * Optional, and ignored where unsupported, so a call site can adopt it
   * without every other one changing.
   */
  jsonSchema?: Record<string, unknown>;
  /**
   * Ask the provider to cache the system prompt. Default true — the system block
   * holds the project context, which repeats across every call in a session.
   */
  cacheSystem?: boolean;
}

export interface AIResult {
  text: string;
  usage: TokenUsage;
  provider: ProviderName;
  model: string;
  stopReason?: string;
  /**
   * Why the model declined, when `stopReason` says it did.
   *
   * A refusal arrives as a successful response with no answer in it — HTTP
   * 200, `stopReason: 'refusal'`, and usually no text at all. The stop reason
   * already distinguishes that from a model with nothing to say; this carries
   * the explanation that came with it, which otherwise reached the logs as an
   * empty string and told nobody anything.
   */
  refusalReason?: string;
}

export interface AIChunk {
  delta: string;
  done: boolean;
  usage?: TokenUsage;
}

export class AIProviderError extends Error {
  readonly provider: ProviderName;
  readonly status?: number;

  constructor(provider: ProviderName, message: string, status?: number) {
    super(message);
    this.name = 'AIProviderError';
    this.provider = provider;
    this.status = status;
  }
}
