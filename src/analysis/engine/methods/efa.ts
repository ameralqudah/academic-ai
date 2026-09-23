/**
 * Exploratory factor analysis.
 *
 * - Sampling adequacy: Kaiser–Meyer–Olkin (overall and per item, from the
 *   anti-image of the correlation matrix) and Bartlett's test of sphericity.
 * - Retention: Kaiser (eigenvalues of R above 1) or a fixed number; the rule is
 *   recorded. Parallel analysis is not implemented and is not claimed.
 * - Extraction: iterated principal-axis factoring from squared multiple
 *   correlations (converged when no communality moves more than 1e-6), or
 *   principal components.
 * - Rotation: varimax and promax exactly as R's `stats::varimax(normalize =
 *   TRUE, eps = 1e-5)` and `stats::promax(m = 4)`, with factor correlations
 *   Φ = (TᵀT)⁻¹ for promax. Factors are then signed so each column's loadings
 *   sum to a positive value and ordered by their sum of squared loadings.
 *
 * Checked against base R (`scripts/references/generate.R`).
 */

import { chiSquareSf } from '../../distributions';

import { completeRows, numeric, pick } from '../data';
import { correlationMatrix, logDeterminantSymmetric, matMul, symmetricEigen, symmetricInverse, transposeOf } from '../numerics';
import type { MethodSpec } from '../spec';
import { ENGINE, type Issue, type NormalisedResult } from '../types';

type Spec = Extract<MethodSpec, { analysisType: 'efa' }>;
type Data = import('../types').EngineDataset;

export class EfaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EfaError';
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Rotation                                  */
/* -------------------------------------------------------------------------- */

/** U·Vᵀ and the sum of singular values of a small square matrix, via the polar decomposition. */
function polar(b: number[][]): { orthogonal: number[][]; singularSum: number } {
  const btb = matMul(transposeOf(b), b);
  const { values, vectors } = symmetricEigen(btb);
  const k = b.length;
  const invSqrt = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => {
      let sum = 0;
      for (let m = 0; m < k; m += 1) sum += ((vectors[i] as number[])[m] as number) * ((vectors[j] as number[])[m] as number) / Math.sqrt(Math.max(values[m] as number, 1e-300));
      return sum;
    }),
  );
  return { orthogonal: matMul(b, invSqrt), singularSum: values.reduce((sum, value) => sum + Math.sqrt(Math.max(value, 0)), 0) };
}

/** R `stats::varimax(x, normalize = TRUE, eps = 1e-5)`. */
export function varimax(loadings: number[][], eps = 1e-5): { loadings: number[][]; rotation: number[][] } {
  const p = loadings.length;
  const k = loadings[0]?.length ?? 0;
  if (k < 2) return { loadings: loadings.map((row) => [...row]), rotation: [[1]] };
  const scale = loadings.map((row) => Math.sqrt(row.reduce((sum, value) => sum + value * value, 0)));
  const x = loadings.map((row, i) => row.map((value) => value / (scale[i] as number)));
  let rotation: number[][] = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));
  let d = 0;
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    const z = matMul(x, rotation);
    const colSq = Array.from({ length: k }, (_, j) => z.reduce((sum, row) => sum + (row[j] as number) ** 2, 0));
    const inner = z.map((row) => row.map((value, j) => value ** 3 - (value * (colSq[j] as number)) / p));
    const b = matMul(transposeOf(x), inner);
    const { orthogonal, singularSum } = polar(b);
    rotation = orthogonal;
    const past = d;
    d = singularSum;
    if (d < past * (1 + eps)) break;
  }
  const rotated = matMul(x, rotation).map((row, i) => row.map((value) => value * (scale[i] as number)));
  return { loadings: rotated, rotation };
}

/** R `stats::promax(x, m)`: varimax, then a power target fitted by least squares. */
export function promax(loadings: number[][], power = 4): { pattern: number[][]; rotation: number[][]; phi: number[][] } {
  const k = loadings[0]?.length ?? 0;
  if (k < 2) return { pattern: loadings.map((row) => [...row]), rotation: [[1]], phi: [[1]] };
  const vm = varimax(loadings);
  const x = vm.loadings;
  const q = x.map((row) => row.map((value) => value * Math.abs(value) ** (power - 1)));
  const xtxInv = symmetricInverse(matMul(transposeOf(x), x));
  let u = matMul(xtxInv, matMul(transposeOf(x), q));
  const d = symmetricInverse(matMul(transposeOf(u), u)).map((row, i) => row[i] as number);
  u = u.map((row) => row.map((value, j) => value * Math.sqrt(d[j] as number)));
  const pattern = matMul(x, u);
  const rotation = matMul(vm.rotation, u);
  const phi = symmetricInverse(matMul(transposeOf(rotation), rotation));
  return { pattern, rotation, phi };
}

/* -------------------------------------------------------------------------- */
/*                                 Extraction                                 */
/* -------------------------------------------------------------------------- */

function topLoadings(matrix: number[][], k: number): number[][] {
  const { values, vectors } = symmetricEigen(matrix);
  return matrix.map((_, i) => Array.from({ length: k }, (_, j) => ((vectors[i] as number[])[j] as number) * Math.sqrt(Math.max(values[j] as number, 0))));
}

export function principalAxis(r: number[][], k: number, start: number[]): { loadings: number[][]; iterations: number; converged: boolean } {
  let h = [...start];
  for (let iteration = 1; iteration <= 1000; iteration += 1) {
    const reduced = r.map((row, i) => row.map((value, j) => (i === j ? (h[i] as number) : value)));
    const loadings = topLoadings(reduced, k);
    const next = loadings.map((row) => row.reduce((sum, value) => sum + value * value, 0));
    const change = Math.max(...next.map((value, i) => Math.abs(value - (h[i] as number))));
    h = next;
    if (change < 1e-6) return { loadings, iterations: iteration, converged: true };
  }
  const reduced = r.map((row, i) => row.map((value, j) => (i === j ? (h[i] as number) : value)));
  return { loadings: topLoadings(reduced, k), iterations: 1000, converged: false };
}

/* -------------------------------------------------------------------------- */
/*                                     EFA                                    */
/* -------------------------------------------------------------------------- */

export function efa(spec: Spec, data: Data): NormalisedResult {
  const columns = spec.items.map((name) => numeric(data, name).values);
  const rows = completeRows(columns);
  const x = columns.map((values) => pick(values, rows));
  const n = rows.length;
  const p = spec.items.length;
  const issues: Issue[] = [];

  const r = correlationMatrix(x);
  let rInverse: number[][];
  try {
    rInverse = symmetricInverse(r);
  } catch {
    throw new EfaError('singular-correlation-matrix', 'The correlation matrix is singular (an item is a linear combination of others, or duplicated); EFA cannot be run.');
  }

  /* Sampling adequacy. */
  const partial = r.map((row, i) => row.map((_, j) => (i === j ? 1 : -((rInverse[i] as number[])[j] as number) / Math.sqrt(((rInverse[i] as number[])[i] as number) * ((rInverse[j] as number[])[j] as number)))));
  let r2 = 0;
  let p2 = 0;
  const msa = spec.items.map((_, i) => {
    let ri = 0;
    let pi = 0;
    for (let j = 0; j < p; j += 1) {
      if (i === j) continue;
      ri += ((r[i] as number[])[j] as number) ** 2;
      pi += ((partial[i] as number[])[j] as number) ** 2;
    }
    r2 += ri;
    p2 += pi;
    return ri / (ri + pi);
  });
  const kmo = r2 / (r2 + p2);
  const bartlett = -(n - 1 - (2 * p + 5) / 6) * logDeterminantSymmetric(r);
  const bartlettDf = (p * (p - 1)) / 2;
  const bartlettP = chiSquareSf(bartlett, bartlettDf);

  /* Retention. */
  const eigenvalues = symmetricEigen(r).values;
  const kaiser = Math.max(1, eigenvalues.filter((value) => value > 1).length);
  const k = spec.retention === 'fixed' ? (spec.nFactors as number) : kaiser;
  if (k >= p) throw new EfaError('too-many-factors', `${k} factors cannot be extracted from ${p} items.`);

  /* Extraction. */
  let unrotated: number[][];
  let iterations = 0;
  let converged = true;
  if (spec.extraction === 'pca') {
    unrotated = topLoadings(r, k);
  } else {
    const smc = rInverse.map((row, i) => 1 - 1 / (row[i] as number));
    const fit = principalAxis(r, k, smc);
    unrotated = fit.loadings;
    iterations = fit.iterations;
    converged = fit.converged;
  }
  const communalities = unrotated.map((row) => row.reduce((sum, value) => sum + value * value, 0));

  /* Rotation. */
  let pattern = unrotated.map((row) => [...row]);
  let phi: number[][] | null = null;
  if (k > 1 && spec.rotation === 'varimax') pattern = varimax(unrotated).loadings;
  if (k > 1 && spec.rotation === 'promax') {
    const rotated = promax(unrotated, spec.promaxPower);
    pattern = rotated.pattern;
    phi = rotated.phi;
  }

  /* Sign and order, so the same data always gives the same factors. */
  const signs = Array.from({ length: k }, (_, j) => (pattern.reduce((sum, row) => sum + (row[j] as number), 0) < 0 ? -1 : 1));
  pattern = pattern.map((row) => row.map((value, j) => value * (signs[j] as number)));
  if (phi) phi = phi.map((row, i) => row.map((value, j) => value * (signs[i] as number) * (signs[j] as number)));
  const ss = Array.from({ length: k }, (_, j) => pattern.reduce((sum, row) => sum + (row[j] as number) ** 2, 0));
  const order = Array.from({ length: k }, (_, j) => j).sort((a, b) => (ss[b] as number) - (ss[a] as number) || a - b);
  pattern = pattern.map((row) => order.map((j) => row[j] as number));
  if (phi) phi = order.map((i) => order.map((j) => (phi as number[][])[i]![j] as number));
  const ssOrdered = order.map((j) => ss[j] as number);
  const structure = phi ? matMul(pattern, phi) : null;
  const factors = Array.from({ length: k }, (_, j) => `F${j + 1}`);

  /* Issues. */
  if (kmo < 0.5) issues.push({ code: 'kmo-unacceptable', severity: 'WARNING', columns: spec.items, message: `KMO = ${kmo.toFixed(3)} (< .50): the correlations are not suitable for factor analysis.`, messageAr: 'مؤشر KMO غير مقبول.', details: { kmo } });
  else if (kmo < 0.6) issues.push({ code: 'kmo-mediocre', severity: 'INFO', columns: spec.items, message: `KMO = ${kmo.toFixed(3)} (.50–.60, mediocre).`, messageAr: 'مؤشر KMO ضعيف.', details: { kmo } });
  const weakItems = spec.items.filter((_, i) => (msa[i] as number) < 0.5);
  if (weakItems.length) issues.push({ code: 'low-msa', severity: 'WARNING', columns: weakItems, message: 'Items with MSA below .50 do not share enough variance with the others.', messageAr: 'بنود بكفاية عينة منخفضة.' });
  if (bartlettP >= 0.05) issues.push({ code: 'bartlett-not-significant', severity: 'WARNING', columns: spec.items, message: `Bartlett's test is not significant (p = ${bartlettP.toPrecision(3)}): the items may be uncorrelated.`, messageAr: 'اختبار بارتلت غير دال.' });
  const heywood = spec.items.filter((_, i) => (communalities[i] as number) >= 1);
  if (heywood.length) issues.push({ code: 'heywood-case', severity: 'WARNING', columns: heywood, message: 'A communality reached 1 or more (Heywood case): the solution is improper; consider fewer factors.', messageAr: 'حالة هيوود.' });
  if (!converged) issues.push({ code: 'not-converged', severity: 'WARNING', columns: spec.items, message: 'Principal-axis factoring did not converge in 1000 iterations.', messageAr: 'لم يتقارب الاستخراج.' });
  if (n < 5 * p) issues.push({ code: 'low-case-to-item-ratio', severity: 'INFO', columns: spec.items, message: `${n} cases for ${p} items (fewer than 5 per item).`, messageAr: 'نسبة الحالات إلى البنود منخفضة.' });

  const result: NormalisedResult = {
    analysisType: 'efa',
    method: `${spec.extraction}${k > 1 && spec.rotation !== 'none' ? `+${spec.rotation}` : ''}`,
    engine: ENGINE,
    sample: { supplied: data.rows.length, used: n, excluded: data.rows.length - n, missingStrategy: 'listwise' },
    estimates: [],
    assumptions: [
      { key: 'sampling-adequacy', status: kmo >= 0.6 ? 'met' : kmo >= 0.5 ? 'inconclusive' : 'violated', statistic: kmo, detail: 'KMO' },
      { key: 'sphericity', status: bartlettP < 0.05 ? 'met' : 'violated', statistic: bartlett, p: bartlettP, detail: `Bartlett χ²(${bartlettDf})` },
    ],
    issues,
    parameters: {
      extraction: spec.extraction,
      rotation: k > 1 ? spec.rotation : 'none (one factor)',
      retention: spec.retention,
      nFactors: k,
      kaiserSuggests: kaiser,
      promaxPower: spec.rotation === 'promax' ? spec.promaxPower : null,
      convergence: spec.extraction === 'paf' ? 'max |Δ communality| < 1e-6, ≤ 1000 iterations, SMC start' : null,
      varimax: 'R stats::varimax(normalize = TRUE, eps = 1e-5)',
      factorOrder: 'by sum of squared loadings, descending; each factor signed to a positive loading sum',
    },
    seed: null,
    payload: { factors, eigenvalues, unrotated, pattern, structure, phi, communalities, msa, iterations, converged, correlation: r },
  };
  const e = result.estimates;
  e.push({ key: 'kmo:overall', label: 'KMO', family: 'adequacy', term: null, stat: 'kmo', estimate: kmo, n });
  spec.items.forEach((item, i) => e.push({ key: `msa:${item}`, label: `MSA (${item})`, family: 'adequacy', term: item, stat: 'msa', estimate: msa[i] as number, n }));
  e.push({ key: 'bartlett', label: "Bartlett's test of sphericity", family: 'adequacy', term: null, stat: 'chi2', estimate: bartlett, statistic: bartlett, statisticName: 'chi2', df: bartlettDf, p: bartlettP, n });
  eigenvalues.forEach((value, i) => e.push({ key: `eigen:${i + 1}`, label: `Eigenvalue ${i + 1}`, family: 'eigenvalue', term: String(i + 1), stat: 'eigenvalue', estimate: value, n }));
  spec.items.forEach((item, i) => {
    factors.forEach((factor, j) => e.push({ key: `loading:${item}|${factor}`, label: `${item} on ${factor}`, family: 'loading', term: `${item}|${factor}`, stat: phi ? 'pattern_loading' : 'loading', estimate: (pattern[i] as number[])[j] as number, n }));
    e.push({ key: `communality:${item}`, label: `h² (${item})`, family: 'communality', term: item, stat: 'communality', estimate: communalities[i] as number, n });
  });
  factors.forEach((factor, j) => {
    e.push({ key: `ss:${factor}`, label: `SS loadings (${factor})`, family: 'variance', term: factor, stat: 'ss_loadings', estimate: ssOrdered[j] as number, n });
    e.push({ key: `prop_var:${factor}`, label: `Proportion of variance (${factor})`, family: 'variance', term: factor, stat: 'proportion_variance', estimate: (ssOrdered[j] as number) / p, n });
  });
  if (phi) {
    factors.forEach((a, i) => factors.forEach((b, j) => {
      if (j > i) e.push({ key: `factor_r:${a}|${b}`, label: `r(${a}, ${b})`, family: 'factor-correlation', term: `${a}|${b}`, stat: 'factor_r', estimate: (phi as number[][])[i]![j] as number, n });
    }));
  }
  return result;
}
