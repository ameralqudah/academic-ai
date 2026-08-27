/**
 * Probability distributions — the arithmetic behind every p-value.
 *
 * A test statistic on its own says nothing. `t = 2.31` is a number; whether it
 * is evidence depends entirely on the distribution it is compared against.
 * This module is that comparison, and it is deliberately the deepest and most
 * boring layer in the product: no dataset reaches it, no user input reaches it,
 * and nothing above it can be trusted until it is right.
 *
 * Three decisions worth stating.
 *
 * First, everything is built from two special functions — the regularised
 * incomplete gamma and the regularised incomplete beta. The t, F and chi-square
 * distributions are all thin wrappers over those two. Implementing them once,
 * carefully, is far safer than three separate approximations that each drift in
 * a different tail.
 *
 * Second, the survival function (the upper tail) is computed directly wherever
 * a p-value needs it, never as `1 - cdf`. In the tail that matters most — the
 * one where p is small and the finding is significant — `1 - cdf` loses its
 * significant digits to cancellation, and a p of 1e-9 comes out as zero.
 *
 * Third, none of this is delegated to a language model. A p-value produced by a
 * generative model is not evidence, it is a plausible-looking number, and the
 * difference is the entire distinction between a research tool and a fraud.
 *
 * Accuracy target: better than 1e-10 relative across the ranges a researcher
 * meets in practice. Verified against published table values in
 * `scripts/analysis.ts`.
 */

/** Convergence controls. The iteration caps are safety nets, not the plan. */
const EPSILON = 1e-15;
const TINY = 1e-300;
const MAX_ITERATIONS = 500;

/* -------------------------------------------------------------------------- */
/*                             Gamma and beta                                 */
/* -------------------------------------------------------------------------- */

/**
 * Lanczos approximation to log Γ(x), g = 7.
 *
 * The logarithm rather than the value itself: Γ(200) overflows a double, while
 * its logarithm is an unremarkable 857. Degrees of freedom in the hundreds are
 * ordinary in survey research, so the overflow is not hypothetical.
 */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

export function logGamma(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return Number.NaN;

  // Reflection for x < 0.5, where the series is poorly conditioned.
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }

  const z = x - 1;
  let series = LANCZOS[0] as number;
  for (let i = 1; i < LANCZOS.length; i += 1) {
    series += (LANCZOS[i] as number) / (z + i);
  }

  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

/** log B(a, b). Kept separate because every beta-family tail needs it. */
export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/**
 * Regularised lower incomplete gamma P(a, x) = γ(a, x) / Γ(a).
 *
 * Two algorithms, chosen by region. The series converges quickly when x is
 * small relative to a; the continued fraction takes over when it is not. Using
 * either one everywhere is the classic way to get a function that is accurate
 * in one half of its domain and quietly wrong in the other.
 */
export function gammaP(a: number, x: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(x) || a <= 0 || x < 0) return Number.NaN;
  if (x === 0) return 0;
  if (x < a + 1) return gammaSeries(a, x);
  return 1 - gammaContinuedFraction(a, x);
}

/**
 * Regularised upper incomplete gamma Q(a, x) = 1 − P(a, x).
 *
 * Computed directly in the upper region rather than by subtraction, which is
 * what keeps a chi-square p-value of 1e-12 from collapsing to zero.
 */
export function gammaQ(a: number, x: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(x) || a <= 0 || x < 0) return Number.NaN;
  if (x === 0) return 1;
  if (x < a + 1) return 1 - gammaSeries(a, x);
  return gammaContinuedFraction(a, x);
}

function gammaSeries(a: number, x: number): number {
  let term = 1 / a;
  let sum = term;
  let n = a;

  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    n += 1;
    term *= x / n;
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * EPSILON) break;
  }

  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Lentz's method for the continued fraction of Q(a, x). */
function gammaContinuedFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;

  for (let i = 1; i <= MAX_ITERATIONS; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }

  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/**
 * Regularised incomplete beta I_x(a, b) — the workhorse behind t and F.
 *
 * The continued fraction converges only when x is on the correct side of the
 * distribution's centre of mass, so the symmetry I_x(a,b) = 1 − I_{1−x}(b,a)
 * is used to move it there. Without that reflection the function is accurate
 * for half its inputs.
 */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  if (a <= 0 || b <= 0) return Number.NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b));

  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(x, a, b)) / a;
  }
  return 1 - (Math.exp(b * Math.log(1 - x) + a * Math.log(x) - logBeta(a, b)) * betaContinuedFraction(1 - x, b, a)) / b;
}

/** Lentz's method for the continued fraction of I_x(a, b). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;

    // Even step.
    let an = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + an * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;

    // Odd step.
    an = (-((a + m) * (qab + m) * x)) / ((a + m2) * (qap + m2));
    d = 1 + an * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;

    if (Math.abs(delta - 1) < EPSILON) break;
  }

  return h;
}

/* -------------------------------------------------------------------------- */
/*                            Normal distribution                             */
/* -------------------------------------------------------------------------- */

/** Φ(z): P(Z ≤ z) for the standard normal. */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return Number.NaN;
  if (z === 0) return 0.5;
  const half = 0.5 * gammaP(0.5, (z * z) / 2);
  return z > 0 ? 0.5 + half : 0.5 - half;
}

/** P(Z > z), computed in the tail so small probabilities keep their digits. */
export function normalSf(z: number): number {
  return normalCdf(-z);
}

/**
 * Φ⁻¹(p) — Acklam's rational approximation, refined by one Halley step.
 *
 * The refinement costs one evaluation of Φ and takes the error from about 1e-9
 * to the limit of double precision, which matters because this is what draws
 * confidence-interval bounds a researcher will print.
 */
export function normalQuantile(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return Number.NaN;

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const low = 0.02425;
  let x: number;

  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      ((((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q + (c[3] as number)) * q + (c[4] as number)) * q + (c[5] as number)) /
      (((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] as number) * r + (a[1] as number)) * r + (a[2] as number)) * r + (a[3] as number)) * r + (a[4] as number)) * r + (a[5] as number)) * q /
      ((((((b[0] as number) * r + (b[1] as number)) * r + (b[2] as number)) * r + (b[3] as number)) * r + (b[4] as number)) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -((((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q + (c[3] as number)) * q + (c[4] as number)) * q + (c[5] as number)) /
      (((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) * q + 1);
  }

  // Halley refinement.
  const error = normalCdf(x) - p;
  const density = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  if (density > 0) {
    const u = error / density;
    x -= u / (1 + (x * u) / 2);
  }

  return x;
}

/* -------------------------------------------------------------------------- */
/*                          Student's t distribution                          */
/* -------------------------------------------------------------------------- */

/** P(T ≤ t) with `df` degrees of freedom. */
export function tCdf(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return Number.NaN;
  if (t === 0) return 0.5;

  const x = df / (df + t * t);
  const half = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t > 0 ? 1 - half : half;
}

/** P(T > t). */
export function tSf(t: number, df: number): number {
  return tCdf(-t, df);
}

/**
 * The two-tailed p-value for a t statistic — what a t-test actually reports.
 *
 * Written as a single incomplete beta rather than `2 * (1 - tCdf(|t|))`: the
 * subtraction form returns exactly 0 once |t| is large enough, and "p = 0" is
 * never a true statement about a continuous distribution.
 */
export function tTwoTailed(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return Number.NaN;
  const x = df / (df + t * t);
  return incompleteBeta(x, df / 2, 0.5);
}

/** t such that P(T ≤ t) = p. Used for confidence-interval bounds. */
export function tQuantile(p: number, df: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1 || df <= 0) return Number.NaN;
  if (p === 0.5) return 0;
  return solveQuantile((t) => tCdf(t, df), p, -1e4, 1e4);
}

/* -------------------------------------------------------------------------- */
/*                          Chi-square distribution                           */
/* -------------------------------------------------------------------------- */

export function chiSquareCdf(x: number, df: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(df) || df <= 0) return Number.NaN;
  if (x <= 0) return 0;
  return gammaP(df / 2, x / 2);
}

/** The upper tail — the p-value of a chi-square test. */
export function chiSquareSf(x: number, df: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(df) || df <= 0) return Number.NaN;
  if (x <= 0) return 1;
  return gammaQ(df / 2, x / 2);
}

export function chiSquareQuantile(p: number, df: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1 || df <= 0) return Number.NaN;
  return solveQuantile((x) => chiSquareCdf(x, df), p, 0, Math.max(1000, df * 100));
}

/* -------------------------------------------------------------------------- */
/*                              F distribution                                */
/* -------------------------------------------------------------------------- */

export function fCdf(f: number, df1: number, df2: number): number {
  if (!Number.isFinite(f) || df1 <= 0 || df2 <= 0) return Number.NaN;
  if (f <= 0) return 0;
  return incompleteBeta((df1 * f) / (df1 * f + df2), df1 / 2, df2 / 2);
}

/**
 * The upper tail — the p-value of an F test (ANOVA, regression).
 *
 * Uses the mirrored form of the incomplete beta rather than `1 - fCdf`, for the
 * same tail-precision reason as everywhere else in this file.
 */
export function fSf(f: number, df1: number, df2: number): number {
  if (!Number.isFinite(f) || df1 <= 0 || df2 <= 0) return Number.NaN;
  if (f <= 0) return 1;
  return incompleteBeta(df2 / (df2 + df1 * f), df2 / 2, df1 / 2);
}

/**
 * F such that P(F ≤ f) = p.
 *
 * Needed by the confidence interval for Cronbach's alpha, which is defined
 * through F quantiles rather than through a standard error.
 */
export function fQuantile(p: number, df1: number, df2: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1 || df1 <= 0 || df2 <= 0) return Number.NaN;
  return solveQuantile((f) => fCdf(f, df1, df2), p, 0, 1e8);
}

/* -------------------------------------------------------------------------- */
/*                       Studentized range distribution                       */
/* -------------------------------------------------------------------------- */

/**
 * The distribution of q, the studentized range — needed by Tukey's HSD and by
 * nothing else in this product.
 *
 * This is the odd one out in this file. The other four distributions have
 * closed forms built from the incomplete gamma and beta functions; q does not.
 * Its cumulative distribution is a double integral with no elementary
 * antiderivative, so it is computed by numerical quadrature.
 *
 * Why it has to exist at all: after an ANOVA says "these groups are not all
 * equal", the researcher needs to know *which* pairs differ. Running ordinary
 * t-tests on every pair inflates the error rate — with five groups there are
 * ten comparisons, and the chance of at least one false positive rises to
 * about 40%. Tukey's HSD controls that by comparing against the distribution of
 * the largest difference among k means rather than the distribution of one
 * difference, and this function is that distribution.
 *
 * P(q ≤ value) = k ∫ φ(z) [Φ(z) − Φ(z − q·s)]^(k−1) dz, averaged over the
 * sampling distribution of s, the estimated standard deviation on `df` degrees
 * of freedom. Both integrals are evaluated with Gauss–Legendre quadrature over
 * a truncated range; the integrands decay rapidly, so a fixed number of nodes
 * reaches the accuracy needed for a p-value.
 */

/**
 * Gauss–Legendre nodes and weights, computed rather than transcribed.
 *
 * The tables for these are printed in every numerical-methods reference and it
 * is tempting to paste one in. This function exists because that is exactly
 * what was tried first, and one weight in the middle of thirty was wrong: the
 * set summed to 1.807 instead of 2, and every studentized-range probability
 * came out 9.7% too small — a uniform bias that looked entirely plausible and
 * would have quietly shifted every Tukey p-value in the product.
 *
 * Computing them makes the error impossible. The nodes are the roots of the
 * n-th Legendre polynomial, found by Newton's method from the standard
 * asymptotic starting guess, and the weights follow from the derivative at each
 * root. The result is exact to machine precision and, unlike a table, cannot be
 * mistyped. Computed once and cached; the cost is invisible.
 */
const quadratureCache = new Map<number, { nodes: number[]; weights: number[] }>();

function gaussLegendre(n: number): { nodes: number[]; weights: number[] } {
  const cached = quadratureCache.get(n);
  if (cached) return cached;

  const nodes = new Array<number>(n).fill(0);
  const weights = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i += 1) {
    // Chebyshev-like starting guess, accurate enough for Newton to converge fast.
    let x = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let derivative = 0;

    for (let iteration = 0; iteration < 100; iteration += 1) {
      // Legendre recurrence: (m+1)P_{m+1} = (2m+1)xP_m − mP_{m−1}
      let previous = 1;
      let current = x;

      for (let m = 1; m < n; m += 1) {
        const next = ((2 * m + 1) * x * current - m * previous) / (m + 1);
        previous = current;
        current = next;
      }

      derivative = (n * (x * current - previous)) / (x * x - 1);
      const step = current / derivative;
      x -= step;
      if (Math.abs(step) < 1e-15) break;
    }

    nodes[i] = x;
    weights[i] = 2 / ((1 - x * x) * derivative * derivative);
  }

  const result = { nodes, weights };
  quadratureCache.set(n, result);
  return result;
}

/** Integrates `f` over [a, b] by composite Gauss–Legendre with `panels` panels. */
function quadrature(f: (x: number) => number, a: number, b: number, panels: number, order = 24): number {
  const { nodes, weights } = gaussLegendre(order);
  const width = (b - a) / panels;
  let total = 0;

  for (let panel = 0; panel < panels; panel += 1) {
    const centre = a + panel * width + width / 2;
    const halfWidth = width / 2;

    for (let i = 0; i < nodes.length; i += 1) {
      total += (weights[i] as number) * f(centre + halfWidth * (nodes[i] as number));
    }
  }

  return total * (width / 2);
}

/** The standard normal density. */
function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/**
 * P(range ≤ q) for k independent standard normals — the inner integral, with
 * the standard deviation treated as known.
 */
function rangeCdfKnownSigma(q: number, k: number): number {
  if (q <= 0) return 0;

  const integrand = (z: number) => {
    const upper = normalCdf(z);
    const lower = normalCdf(z - q);
    const gap = upper - lower;
    if (gap <= 0) return 0;
    return normalPdf(z) * Math.pow(gap, k - 1);
  };

  // The integrand is negligible beyond ±8 standard deviations either side.
  return Math.min(1, k * quadrature(integrand, -8, 8 + q, 16));
}

/**
 * P(q ≤ value) for the studentized range with `k` groups and `df` degrees of
 * freedom on the error term.
 *
 * The outer integral averages the known-sigma result over the χ distribution of
 * the estimated standard deviation. For large df the estimate is essentially
 * exact, so the outer integral is skipped — which also avoids the loss of
 * precision in the χ density at large df.
 */
export function studentizedRangeCdf(q: number, k: number, df: number): number {
  if (!Number.isFinite(q) || q <= 0 || k < 2 || df < 1) return Number.NaN;
  if (df > 25_000) return rangeCdfKnownSigma(q, k);

  const half = df / 2;
  const logConstant = half * Math.log(half) - logGamma(half);

  const integrand = (s: number) => {
    if (s <= 0) return 0;
    // Density of s = sqrt(chi2_df / df), written in logs to survive large df.
    const logDensity = logConstant + (df - 1) * Math.log(s) - (half * s * s) + Math.log(2);
    const density = Math.exp(logDensity);
    if (!Number.isFinite(density) || density === 0) return 0;
    return density * rangeCdfKnownSigma(q * s, k);
  };

  /*
   * s concentrates around 1 and its spread shrinks as df grows, so the range of
   * integration is scaled to the standard deviation of s rather than fixed.
   */
  const spread = 1 / Math.sqrt(2 * df);
  const lower = Math.max(1e-8, 1 - 10 * spread);
  const upper = 1 + 10 * spread;

  return Math.min(1, Math.max(0, quadrature(integrand, lower, upper, 12)));
}

/** The upper tail — the p-value of a Tukey comparison. */
export function studentizedRangeSf(q: number, k: number, df: number): number {
  const cdf = studentizedRangeCdf(q, k, df);
  return Number.isFinite(cdf) ? Math.min(1, Math.max(0, 1 - cdf)) : Number.NaN;
}

/** The critical value of q — what a Tukey confidence interval is built from. */
export function studentizedRangeQuantile(p: number, k: number, df: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1 || k < 2 || df < 1) return Number.NaN;
  return solveQuantile((q) => studentizedRangeCdf(q, k, df), p, 1e-6, 200);
}

/* -------------------------------------------------------------------------- */
/*                                  Solver                                    */
/* -------------------------------------------------------------------------- */

/**
 * Inverts a CDF by bisection.
 *
 * Bisection rather than Newton's method on purpose. It is slower and it does
 * not care: a quantile is computed a handful of times per analysis, never in a
 * loop over rows. What it buys is that it cannot diverge, cannot overshoot into
 * a region where the density underflows, and cannot fail to terminate — which
 * a Newton iteration on a distribution tail can do all three of.
 */
function solveQuantile(
  cdf: (x: number) => number,
  p: number,
  lowerBound: number,
  upperBound: number,
): number {
  let low = lowerBound;
  let high = upperBound;

  for (let i = 0; i < 200; i += 1) {
    const middle = (low + high) / 2;
    const value = cdf(middle);

    if (!Number.isFinite(value)) return Number.NaN;
    if (value < p) low = middle;
    else high = middle;

    if (high - low < Math.max(1e-12, Math.abs(middle) * 1e-14)) break;
  }

  return (low + high) / 2;
}
