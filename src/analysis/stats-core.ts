/**
 * The arithmetic every other module borrows.
 *
 * Deliberately small, deliberately explicit, and deliberately not delegated to
 * a language model: a mean is a mean, and a p-value that came out of a
 * generative model is not evidence. Everything statistical in this product is
 * computed here or in modules that build on here.
 */

/** Sample standard deviation (n − 1). The population form is almost never what a researcher wants. */
export function standardDeviation(values: number[]): number {
  return Math.sqrt(variance(values));
}

export function variance(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let sum = 0;
  for (const value of values) sum += (value - m) ** 2;
  return sum / (n - 1);
}

export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

export function median(values: number[]): number {
  return quantile(values, 0.5);
}

/**
 * Linear-interpolation quantile (the "type 7" definition), which is what R,
 * NumPy and Excel's PERCENTILE all use. Stating the definition matters: the
 * nine competing ones disagree, and a quartile that does not match the
 * researcher's other software reads as a bug.
 */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;

  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;

  if (lower === upper) return sorted[lower] as number;
  return (sorted[lower] as number) * (1 - weight) + (sorted[upper] as number) * weight;
}

/** Fisher–Pearson standardised moment coefficient (g1). */
export function skewness(values: number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const m = mean(values);
  const sd = standardDeviation(values);
  if (sd === 0) return 0;
  let sum = 0;
  for (const value of values) sum += ((value - m) / sd) ** 3;
  return (n / ((n - 1) * (n - 2))) * sum;
}

/** Excess kurtosis (g2): zero for a normal distribution. */
export function kurtosis(values: number[]): number {
  const n = values.length;
  if (n < 4) return 0;
  const m = mean(values);
  const sd = standardDeviation(values);
  if (sd === 0) return 0;
  let sum = 0;
  for (const value of values) sum += ((value - m) / sd) ** 4;
  const a = (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3));
  const b = (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return a * sum - b;
}

export function mode(values: (string | number)[]): { value: string | number; count: number } | null {
  if (values.length === 0) return null;
  const counts = new Map<string | number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: { value: string | number; count: number } | null = null;
  for (const [value, count] of counts) {
    if (!best || count > best.count) best = { value, count };
  }
  return best;
}

/**
 * Parses a number the way a spreadsheet would, and refuses everything else.
 *
 * Handles thousands separators, Arabic-Indic digits, the Arabic decimal
 * separator, a trailing percent sign and parentheses for negatives. Returns
 * `null` rather than `NaN` so that "not a number" is a value the caller must
 * handle rather than one that silently poisons an average.
 */
const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return null;

  let text = value.trim();
  if (text.length === 0) return null;

  text = text.replace(ARABIC_DIGITS, (digit) => {
    const code = digit.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });

  // Arabic decimal separator and thousands mark.
  text = text.replace(/٫/g, '.').replace(/٬/g, '');

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  let percent = false;
  if (text.endsWith('%')) {
    percent = true;
    text = text.slice(0, -1).trim();
  }

  text = text.replace(/[\s,_']/g, '');
  if (text.startsWith('+')) text = text.slice(1);
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  }

  if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;

  const signed = negative ? -parsed : parsed;
  return percent ? signed / 100 : signed;
}

/**
 * Pearson's product-moment correlation between two equal-length series.
 *
 * Returns `NaN` when either series is constant, which is the honest answer: a
 * variable that does not vary cannot co-vary with anything, and returning zero
 * would state independence where nothing was measured. Callers are expected to
 * check, and the reliability module reports such items rather than averaging
 * them in.
 *
 * Computed in two passes from the means rather than from the sums of squares.
 * The single-pass form is famous for losing every significant digit when the
 * values are large and their spread is small — a 5-point Likert item is safe,
 * but an income column in the same table is not.
 */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return Number.NaN;

  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));

  let sxy = 0;
  let sxx = 0;
  let syy = 0;

  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }

  if (sxx === 0 || syy === 0) return Number.NaN;
  return sxy / Math.sqrt(sxx * syy);
}

/** Ranks with ties averaged — the basis of Spearman's correlation. */
export function rank(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);

  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]!.value === indexed[i]!.value) j += 1;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[indexed[k]!.index] = averageRank;
    i = j + 1;
  }

  return ranks;
}
