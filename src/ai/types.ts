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

export interface AIRequest {
  task: AITask;
  locale: 'ar' | 'en';
  /** System prompt assembled by the PromptRegistry. */
  system: string;
  messages: AIChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** When set, the provider is asked to return JSON only. */
  json?: boolean;
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
