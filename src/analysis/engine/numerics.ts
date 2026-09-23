/**
 * Numerical building blocks for the engine's methods: an OLS fit that returns
 * the full coefficient covariance matrix and per-case diagnostics, a symmetric
 * eigensolver, and the seeded generator every randomised method must use.
 */

import { fSf, tQuantile, tTwoTailed } from '../distributions';
import { inverseFromR, leastSquares, qrDecompose, SingularMatrixError, type Matrix } from '../linear-algebra';

/* -------------------------------------------------------------------------- */
/*                                    OLS                                     */
/* -------------------------------------------------------------------------- */

export interface OlsFit {
  names: string[];
  b: number[];
  se: number[];
  t: number[];
  p: number[];
  ciLow: number[];
  ciHigh: number[];
  /** Covariance matrix of the coefficients: σ²(XᵀX)⁻¹. */
  vcov: number[][];
  fitted: number[];
  residuals: number[];
  /** Leverage: the diagonal of the hat matrix. */
  hat: number[];
  n: number;
  /** Parameters including the intercept. */
  k: number;
  dfResidual: number;
  sigma2: number;
  rSquared: number;
  adjustedRSquared: number;
  f: number;
  fDf1: number;
  fP: number;
  ssResidual: number;
  ssTotal: number;
}

/**
 * Ordinary least squares with an intercept. `columns` are the predictors, all
 * of length n, already complete (the caller does listwise deletion and counts it).
 */
export function ols(y: number[], columns: { name: string; values: number[] }[], level = 0.95): OlsFit {
  const n = y.length;
  const k = columns.length + 1;
  const dfResidual = n - k;
  if (dfResidual < 1) throw new SingularMatrixError('engine.singularMatrix');
  const design: Matrix = Array.from({ length: n }, (_, row) => [1, ...columns.map((column) => column.values[row] as number)]);
  const b = leastSquares(design, y);
  const xtxInverse = inverseFromR(qrDecompose(design, y).r);
  const fitted = design.map((row) => row.reduce((sum, value, index) => sum + value * (b[index] as number), 0));
  const residuals = y.map((value, index) => value - (fitted[index] as number));
  const ssResidual = residuals.reduce((sum, value) => sum + value * value, 0);
  const meanY = y.reduce((sum, value) => sum + value, 0) / n;
  const ssTotal = y.reduce((sum, value) => sum + (value - meanY) ** 2, 0);
  const sigma2 = ssResidual / dfResidual;
  const vcov = xtxInverse.map((row) => row.map((value) => value * sigma2));
  const critical = tQuantile(1 - (1 - level) / 2, dfResidual);
  const se = b.map((_, index) => Math.sqrt((vcov[index] as number[])[index] as number));
  const t = b.map((value, index) => value / (se[index] as number));
  const p = t.map((value) => (Number.isFinite(value) ? tTwoTailed(value, dfResidual) : Number.NaN));
  const hat = design.map((row) => {
    let sum = 0;
    for (let i = 0; i < k; i += 1) for (let j = 0; j < k; j += 1) sum += (row[i] as number) * ((xtxInverse[i] as number[])[j] as number) * (row[j] as number);
    return sum;
  });
  const rSquared = ssTotal === 0 ? Number.NaN : 1 - ssResidual / ssTotal;
  const fDf1 = k - 1;
  const f = fDf1 > 0 ? (ssTotal - ssResidual) / fDf1 / sigma2 : Number.NaN;
  return {
    names: ['(intercept)', ...columns.map((column) => column.name)],
    b,
    se,
    t,
    p,
    ciLow: b.map((value, index) => value - critical * (se[index] as number)),
    ciHigh: b.map((value, index) => value + critical * (se[index] as number)),
    vcov,
    fitted,
    residuals,
    hat,
    n,
    k,
    dfResidual,
    sigma2,
    rSquared,
    adjustedRSquared: 1 - ((1 - rSquared) * (n - 1)) / dfResidual,
    f,
    fDf1,
    fP: Number.isFinite(f) ? fSf(f, fDf1, dfResidual) : Number.NaN,
    ssResidual,
    ssTotal,
  };
}

/** Just the coefficients, for resampling loops where nothing else is needed. */
export function olsCoefficients(y: number[], columns: number[][]): number[] {
  const design: Matrix = y.map((_, row) => [1, ...columns.map((values) => values[row] as number)]);
  return leastSquares(design, y);
}

/* -------------------------------------------------------------------------- */
/*                            Symmetric eigensolver                           */
/* -------------------------------------------------------------------------- */

/**
 * Eigenvalues (descending) and unit eigenvectors (as columns) of a symmetric
 * matrix, by cyclic Jacobi rotations. Deterministic; accurate to ~1e-12 for the
 * correlation matrices used here. Each eigenvector's sign is fixed so that its
 * largest-magnitude component is positive, so the output does not depend on
 * rotation order.
 */
export function symmetricEigen(input: number[][]): { values: number[]; vectors: number[][] } {
  const size = input.length;
  const a = input.map((row) => [...row]);
  const v: number[][] = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0;
    for (let i = 0; i < size; i += 1) for (let j = i + 1; j < size; j += 1) off += (a[i]![j] as number) ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < size; p += 1) {
      for (let q = p + 1; q < size; q += 1) {
        const apq = a[p]![q] as number;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = ((a[q]![q] as number) - (a[p]![p] as number)) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < size; k += 1) {
          const akp = a[k]![p] as number;
          const akq = a[k]![q] as number;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < size; k += 1) {
          const apk = a[p]![k] as number;
          const aqk = a[q]![k] as number;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < size; k += 1) {
          const vkp = v[k]![p] as number;
          const vkq = v[k]![q] as number;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: size }, (_, i) => i).sort((x, y) => (a[y]![y] as number) - (a[x]![x] as number));
  const values = order.map((i) => a[i]![i] as number);
  const vectors = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  order.forEach((source, target) => {
    let largest = 0;
    for (let k = 0; k < size; k += 1) if (Math.abs(v[k]![source] as number) > Math.abs(v[largest]![source] as number)) largest = k;
    const sign = (v[largest]![source] as number) < 0 ? -1 : 1;
    for (let k = 0; k < size; k += 1) vectors[k]![target] = sign * (v[k]![source] as number);
  });
  return { values, vectors };
}

/** Inverse of a symmetric positive-definite matrix, via its eigendecomposition. Throws if singular. */
export function symmetricInverse(m: number[][]): number[][] {
  const { values, vectors } = symmetricEigen(m);
  if (values.some((value) => !(value > 1e-12 * Math.max(1, Math.abs(values[0] ?? 1))))) throw new SingularMatrixError('engine.singularMatrix');
  const size = m.length;
  return Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => {
      let sum = 0;
      for (let k = 0; k < size; k += 1) sum += ((vectors[i] as number[])[k] as number) * ((vectors[j] as number[])[k] as number) / (values[k] as number);
      return sum;
    }),
  );
}

export function logDeterminantSymmetric(m: number[][]): number {
  return symmetricEigen(m).values.reduce((sum, value) => sum + Math.log(value), 0);
}

/* -------------------------------------------------------------------------- */
/*                                 Randomness                                 */
/* -------------------------------------------------------------------------- */

/**
 * The only random source a research result may use: Mulberry32, seeded
 * explicitly. The same generator as the PLS bootstrap, so a seed means the same
 * thing everywhere. `Math.random` is never used for a result.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Quantile type 7 (R's default) of an ascending-sorted array. */
export function quantileSorted(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return (sorted[lo] as number) + (h - lo) * ((sorted[hi] as number) - (sorted[lo] as number));
}

export function correlationMatrix(columns: number[][]): number[][] {
  const n = columns[0]?.length ?? 0;
  const means = columns.map((values) => values.reduce((sum, value) => sum + value, 0) / n);
  const centred = columns.map((values, index) => values.map((value) => value - (means[index] as number)));
  const norms = centred.map((values) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)));
  return centred.map((a, i) =>
    centred.map((b, j) => {
      if (i === j) return 1;
      let sum = 0;
      for (let row = 0; row < n; row += 1) sum += (a[row] as number) * (b[row] as number);
      return sum / ((norms[i] as number) * (norms[j] as number));
    }),
  );
}

export function matMul(a: number[][], b: number[][]): number[][] {
  return a.map((row) => (b[0] ?? []).map((_, j) => row.reduce((sum, value, k) => sum + value * ((b[k] as number[])[j] as number), 0)));
}

export function transposeOf(a: number[][]): number[][] {
  return (a[0] ?? []).map((_, j) => a.map((row) => row[j] as number));
}
