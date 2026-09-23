/**
 * The contract every provider adapter implements. Provider-specific request
 * shapes, response shapes, headers and quirks stay inside the adapter; what
 * crosses this line is normalised and validated.
 */

import type { AdapterResult, GatewayRequest, GatewayTool, Provider, ToolChoice, Usage } from '../contract';

export interface AdapterCall {
  request: GatewayRequest;
  model: string;
  tools?: GatewayTool[];
  toolChoice?: ToolChoice;
  /** JSON Schema for native structured output. */
  responseSchema?: { name: string; schema: Record<string, unknown> };
  signal: AbortSignal;
}

export type AdapterStreamEvent = { type: 'text'; text: string } | { type: 'final'; result: AdapterResult };

export interface ModelCapabilities {
  tools: boolean;
  structured: boolean;
  images: boolean;
  /** Tokens the model can take as input. */
  contextTokens: number;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  configured(): boolean;
  capabilities(model: string): ModelCapabilities;
  send(call: AdapterCall): Promise<AdapterResult>;
  stream(call: AdapterCall): AsyncIterable<AdapterStreamEvent>;
  embed?(input: { inputs: string[]; model: string; signal: AbortSignal }): Promise<{ vectors: number[][]; usage: Usage; model: string }>;
  /** The embedding model this provider uses by default, when it has one. */
  readonly embeddingModel?: string;
}

/** Shared fetch for adapters: every call carries the signal; nothing else is special. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export const defaultFetcher: Fetcher = (url, init) => fetch(url, init);
