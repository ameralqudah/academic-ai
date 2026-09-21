import { logger } from '@/lib/logger';

/**
 * What a model costs, by model.
 *
 * Each provider carried one constant, and it was the price of whichever model
 * was the default when the provider was written. Google's was Gemini 2.5 Pro's;
 * the model actually serving requests was Gemini 3.6 Flash, at a little over
 * half that, so the admin dashboard overstated the month's spend by about 45%
 * and nobody could have known. A price belongs to a model, not to a company.
 *
 * US dollars per million tokens, from the providers' own pricing pages
 * (checked 2026-09-21). These are estimates for the dashboard — the invoice is
 * the provider's — but an estimate should at least be of the right model.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

interface DatedPrice extends ModelPrice {
  /** ISO date this price starts to apply. The latest one not after "now" wins. */
  from: string;
}

/*
 * Matched by prefix, longest first, so `claude-haiku-4-5-20251001` finds
 * `claude-haiku-4-5` and a dated snapshot never needs an entry of its own.
 */
const PRICES: Record<string, DatedPrice[]> = {
  /* Cache write and read are Anthropic's standard 1.25x and 0.1x of the input price. */
  'claude-opus-5': [{ from: '2000-01-01', input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }],
  'claude-sonnet-5': [{ from: '2000-01-01', input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }],
  'claude-sonnet-4': [{ from: '2000-01-01', input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }],
  'claude-haiku-4-5': [{ from: '2000-01-01', input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }],

  /*
   * Promotional until the end of 2026, then double. Dated rather than left for
   * someone to remember: on 1 January the dashboard would otherwise start
   * understating the spend by half, silently, which is the same mistake as the
   * one this file fixes pointed the other way.
   */
  'gemini-3.6-flash': [
    { from: '2000-01-01', input: 0.75, output: 3.75 },
    { from: '2027-01-01', input: 1.5, output: 7.5 },
  ],
  'gemini-3.5-flash': [{ from: '2000-01-01', input: 1.5, output: 9 }],
  'gemini-2.5-pro': [{ from: '2000-01-01', input: 1.25, output: 5 }],

  'gpt-4.1': [{ from: '2000-01-01', input: 2.5, output: 10 }],
};

const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/** Warned once per model, not once per request. */
const warned = new Set<string>();

export function priceFor(model: string, fallback: ModelPrice, now: Date = new Date()): ModelPrice {
  const key = KEYS.find((candidate) => model.startsWith(candidate));

  if (!key) {
    if (!warned.has(model)) {
      warned.add(model);
      /*
       * Loud, because the quiet version of this is how the wrong price went
       * unnoticed: a model nobody priced is costed at a guess, and says so.
       */
      logger.warn('ai.price.unknownModel', { model });
    }
    return fallback;
  }

  const today = now.toISOString().slice(0, 10);
  const dated = PRICES[key] ?? [];
  const current = [...dated].reverse().find((price) => price.from <= today) ?? dated[0];

  return current ?? fallback;
}

export function costMicroUsd(
  price: ModelPrice,
  usage: { tokensIn: number; tokensOut: number; cacheWriteTokens?: number; cacheReadTokens?: number },
): number {
  const dollars =
    (usage.tokensIn / 1_000_000) * price.input +
    (usage.tokensOut / 1_000_000) * price.output +
    ((usage.cacheWriteTokens ?? 0) / 1_000_000) * (price.cacheWrite ?? price.input) +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * (price.cacheRead ?? price.input);

  return Math.round(dollars * 1_000_000);
}

/**
 * The cost of a request, by the model that actually served it.
 *
 * When an overloaded model hands a request to its sibling, the sibling's price
 * applies — and the provider object in hand is still the first model's. Usage
 * was recorded under the right name at the wrong price. `estimate` is the
 * provider's own figure, used only for a model this table does not know.
 */
export function costFor(
  model: string,
  usage: { tokensIn: number; tokensOut: number; cacheWriteTokens?: number; cacheReadTokens?: number },
  estimate: () => number,
  now: Date = new Date(),
): number {
  const known = KEYS.some((candidate) => model.startsWith(candidate));
  return known ? costMicroUsd(priceFor(model, { input: 0, output: 0 }, now), usage) : estimate();
}
