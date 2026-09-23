/**
 * Finding numbers in prose that did not come from a verified result (P1-C).
 *
 * Text may carry a number only as a `{{value:<key>}}` token; the server renders
 * it from the stored estimate. This module finds numbers written any other way:
 * Arabic-Indic and Persian digits (normalised first), comma or Arabic decimal
 * separators, statistic symbols in any script (β, α, χ², ρ — which a JavaScript
 * `\b` never precedes), integers after a statistic ("β = 1", "χ²(3) = 45").
 *
 * Two strengths:
 * - `strict` (model-written text): any digit outside a token is refused. A model
 *   has no reason to write a digit itself.
 * - default (a person's sentence): statistic-like numbers are refused, while
 *   labels such as "H1" or "Table 2" are allowed.
 */

export const VALUE_TOKEN = /\{\{value:([^{}]{1,300})\}\}/g;

/** Arabic-Indic (U+0660–0669) and extended (U+06F0–06F9) digits to ASCII; Arabic decimal/thousands marks to "." / ",". */
export function normaliseDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/−/g, '-');
}

const SYMBOL = String.raw`(?:p|r|t|F|b|B|z|d|g|n|N|M|SD|SE|CI|df|OR|RR|HR|R2|R²|η²|ω²|η2|ω2|α|β|γ|δ|λ|ρ|τ|φ|χ²|χ2|chi2?|KMO|CFI|TLI|RMSEA|SRMR|AVE|CR|HTMT|VIF)`;
const NUMBER = String.raw`[-+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)`;
/** "β = 1", "t(234) = 6.1", "p < .05", "χ²(3) = 45" — symbol not preceded by a letter or digit. */
const ASSIGNMENT = new RegExp(String.raw`(?<![\p{L}\p{N}])${SYMBOL}\s*(?:\(\s*[\d.,\s]+\))?\s*[=<>≤≥]\s*${NUMBER}`, 'gu');
/** Any decimal number (dot or comma), and percentages. */
const DECIMAL = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:\d+[.,]\d+|[.,]\d+)(?![\p{N}])|\d+(?:[.,]\d+)?\s?%`, 'gu');

export function stripTokens(text: string): string {
  return text.replace(VALUE_TOKEN, ' ');
}

/** Statistic-like numbers outside tokens. `strict`: every digit outside a token. */
export function untracedNumbers(text: string, options: { strict?: boolean } = {}): string[] {
  const outside = normaliseDigits(stripTokens(text));
  if (options.strict) return [...outside.matchAll(/\d[\d.,]*/g)].map((match) => match[0]);
  const found = new Set<string>();
  for (const match of outside.matchAll(ASSIGNMENT)) found.add(match[0].trim());
  for (const match of outside.matchAll(DECIMAL)) found.add(match[0].trim());
  return [...found];
}

export function tokensIn(text: string): string[] {
  return [...text.matchAll(VALUE_TOKEN)].map((match) => match[1]!.trim());
}
