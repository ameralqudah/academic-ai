/**
 * Descriptives, reliability, correlation, regression and one-way ANOVA.
 *
 * The core numbers come from the existing, reference-tested routines
 * (`linearRegression` ≡ statsmodels OLS, `oneWayAnova`/`tukeyHsd` ≡ SciPy and
 * statsmodels, `correlationMatrix` ≡ SciPy, `cronbachAlpha` ≡ hand-verified).
 * What the engine adds: the diagnostics those routines lacked (Breusch–Pagan,
 * Cook's distance, leverage), Games–Howell, the post-hoc gate at the
 * specification's α, and one normalised result shape.
 */

import { chiSquareSf, studentizedRangeQuantile, studentizedRangeSf } from '../../distributions';
import { correlationMatrix as correlationMatrixOf, type CorrelationMatrixResult } from '../../inference/correlation';
import { oneWayAnova, tukeyHsd, type TukeyComparison } from '../../inference/anova';
import { linearRegression, type RegressionCoefficient } from '../../inference/regression';
import type { InferentialResult } from '../../inference/types';
import { profileDataset } from '../../profile';
import { cronbachAlpha, type ReliabilityResult } from '../../reliability';
import { kurtosis, mean, median, skewness, standardDeviation, variance } from '../../stats-core';
import type { Dataset } from '../../types';

import { categorical, completeRows, numeric, pick } from '../data';
import { ols } from '../numerics';
import type { MethodSpec } from '../spec';
import { ENGINE, type Estimate, type Issue, type NormalisedResult } from '../types';

type Spec<T extends MethodSpec['analysisType']> = Extract<MethodSpec, { analysisType: T }>;
type Data = import('../types').EngineDataset;

const fin = (value: number | null | undefined): number | null => (value !== null && value !== undefined && Number.isFinite(value) ? value : null);

function base(spec: MethodSpec, method: string, sample: NormalisedResult['sample'], parameters: Record<string, unknown>): NormalisedResult {
  return { analysisType: spec.analysisType, method, engine: ENGINE, sample, estimates: [], assumptions: [], issues: [], parameters, seed: null, payload: {} };
}

/** Carries an engine routine's own warnings into the normalised issues. */
function fromWarnings(warnings: { code: string; severity: string; columns?: string[]; params?: Record<string, string | number> }[]): Issue[] {
  return warnings.map((warning) => ({
    code: warning.code,
    severity: warning.severity === 'error' ? 'WARNING' : warning.severity === 'warning' ? 'WARNING' : 'INFO',
    columns: warning.columns ?? [],
    message: `${warning.code}${warning.params ? ` (${Object.entries(warning.params).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`,
    messageAr: warning.code,
    ...(warning.params ? { details: warning.params } : {}),
  }));
}

/* -------------------------------------------------------------------------- */
/*                                Descriptives                                */
/* -------------------------------------------------------------------------- */

export function descriptives(spec: Spec<'descriptives'>, data: Data): NormalisedResult {
  const result = base(spec, 'descriptives', { supplied: data.rows.length, used: data.rows.length, excluded: 0, missingStrategy: 'pairwise' }, {
    skewness: 'G1 (adjusted Fisher-Pearson)',
    kurtosis: 'G2 (adjusted excess)',
    variance: 'n-1',
  });
  const rows: Record<string, unknown>[] = [];
  for (const name of spec.variables) {
    const col = numeric(data, name);
    const values = col.values.filter(Number.isFinite);
    const n = values.length;
    const sd = n >= 2 ? standardDeviation(values) : Number.NaN;
    /* Undefined moments are reported as not computed, never as 0. */
    const skew = n >= 3 && sd > 0 ? skewness(values) : Number.NaN;
    const kurt = n >= 4 && sd > 0 ? kurtosis(values) : Number.NaN;
    const row = {
      variable: name,
      n,
      missing: col.missing + col.coded,
      invalid: col.invalid,
      mean: n ? mean(values) : Number.NaN,
      median: n ? median(values) : Number.NaN,
      sd,
      variance: n >= 2 ? variance(values) : Number.NaN,
      min: n ? Math.min(...values) : Number.NaN,
      max: n ? Math.max(...values) : Number.NaN,
      skewness: skew,
      kurtosis: kurt,
      seMean: n >= 2 ? sd / Math.sqrt(n) : Number.NaN,
    };
    rows.push(row);
    const add = (stat: string, value: number, label: string) =>
      result.estimates.push({ key: `${stat}:${name}`, label: `${label} of ${name}`, family: 'descriptive', term: name, stat, estimate: value, n });
    add('n', n, 'N');
    add('missing', row.missing, 'Missing');
    for (const stat of ['mean', 'median', 'sd', 'variance', 'min', 'max', 'skewness', 'kurtosis'] as const) {
      if (Number.isFinite(row[stat])) add(stat, row[stat], stat[0]!.toUpperCase() + stat.slice(1));
    }
    if (!Number.isFinite(skew) || !Number.isFinite(kurt)) {
      result.issues.push({ code: 'moment-not-computed', severity: 'INFO', columns: [name], message: 'Skewness needs n ≥ 3 and kurtosis n ≥ 4 with non-zero variance; not computed.', messageAr: 'الالتواء والتفلطح غير محسوبين لقلة البيانات.' });
    }
  }
  result.payload = { rows };
  return result;
}

/* -------------------------------------------------------------------------- */
/*                                 Reliability                                */
/* -------------------------------------------------------------------------- */

/** The existing reliability routine takes the legacy dataset shape; the engine hands it numbers (NaN → null). */
function legacyDataset(columns: { name: string; values: number[] }[]): Dataset {
  const n = columns[0]?.values.length ?? 0;
  return {
    columns: columns.map((column) => column.name),
    rows: Array.from({ length: n }, (_, row) => columns.map((column) => (Number.isFinite(column.values[row]) ? (column.values[row] as number) : null))),
    source: 'engine',
    skippedRows: 0,
  };
}

export function reliability(spec: Spec<'reliability'>, data: Data): NormalisedResult {
  const columns = spec.items.map((name) => ({ name, values: numeric(data, name).values }));
  const dataset = legacyDataset(columns);
  const alpha: ReliabilityResult = cronbachAlpha(dataset, profileDataset(dataset), spec.items);
  const result = base(spec, 'cronbach-alpha', { supplied: alpha.rowsSupplied, used: alpha.sampleSize, excluded: alpha.rowsDropped, missingStrategy: 'listwise' }, {
    itemTotal: 'corrected (item vs sum of the other items)',
    confidenceInterval: 'Feldt',
    confidenceLevel: 0.95,
  });
  const c = spec.construct;
  result.estimates.push({
    key: `alpha:${c}`,
    label: `Cronbach's α (${c})`,
    family: 'reliability',
    term: c,
    stat: 'alpha',
    estimate: alpha.alpha,
    ciLow: alpha.confidenceInterval?.lower ?? null,
    ciHigh: alpha.confidenceInterval?.upper ?? null,
    ciLevel: alpha.confidenceInterval?.level ?? null,
    ciMethod: alpha.confidenceInterval ? 'feldt' : null,
    n: alpha.sampleSize,
  });
  result.estimates.push({ key: `alpha_std:${c}`, label: `Standardised α (${c})`, family: 'reliability', term: c, stat: 'alpha_standardised', estimate: alpha.standardisedAlpha, n: alpha.sampleSize });
  result.estimates.push({ key: `mean_r:${c}`, label: `Mean inter-item r (${c})`, family: 'reliability', term: c, stat: 'mean_inter_item_r', estimate: alpha.averageInterItemCorrelation, n: alpha.sampleSize });
  for (const item of alpha.items) {
    result.estimates.push({ key: `item_total:${item.name}`, label: `Corrected item-total r (${item.name})`, family: 'item', term: item.name, stat: 'item_total_r', estimate: item.itemTotalCorrelation, n: alpha.sampleSize });
    result.estimates.push({ key: `alpha_if_deleted:${item.name}`, label: `α if ${item.name} deleted`, family: 'item', term: item.name, stat: 'alpha_if_deleted', estimate: item.alphaIfDeleted, n: alpha.sampleSize });
  }
  result.issues.push(...fromWarnings(alpha.warnings.map((warning) => ({ ...warning, columns: (warning as { columns?: string[] }).columns ?? [] }))));
  result.payload = { items: alpha.items, scaleMean: alpha.scaleMean, scaleVariance: alpha.scaleVariance, band: alpha.band };
  return result;
}

/* -------------------------------------------------------------------------- */
/*                                 Correlation                                */
/* -------------------------------------------------------------------------- */

export function correlation(spec: Spec<'correlation'>, data: Data): NormalisedResult {
  const raw = spec.variables.map((name) => ({ name, values: numeric(data, name).values }));
  const supplied = data.rows.length;
  let columns = raw;
  let used = supplied;
  if (spec.missing === 'listwise') {
    const rows = completeRows(raw.map((column) => column.values));
    columns = raw.map((column) => ({ name: column.name, values: pick(column.values, rows) }));
    used = rows.length;
  }
  const pAdjust = spec.adjust === 'bh' ? 'benjamini-hochberg' : spec.adjust;
  const matrix: CorrelationMatrixResult = correlationMatrixOf(columns, { method: spec.method, confidenceLevel: spec.confidenceLevel, pAdjust });
  const result = base(spec, `${spec.method}-correlation`, {
    supplied,
    used: spec.missing === 'listwise' ? used : matrix.maxN,
    excluded: supplied - (spec.missing === 'listwise' ? used : matrix.minN),
    missingStrategy: spec.missing,
  }, {
    method: spec.method,
    missing: spec.missing,
    pAdjust: spec.adjust,
    confidenceLevel: spec.confidenceLevel,
    ciMethod: spec.method === 'spearman' ? 'fisher-z (Fieller √1.06)' : 'fisher-z',
    pValue: spec.method === 'spearman' ? 't approximation on n−2 df' : 't on n−2 df',
  });
  const cellOf = (a: string, b: string) => matrix.cells.find((c) => (c.rowVariable === a && c.columnVariable === b) || (c.rowVariable === b && c.columnVariable === a));
  const pairs = spec.variables.flatMap((a, i) => spec.variables.slice(i + 1).map((b) => [a, b] as const));
  for (const [a, b] of pairs) {
    const found = cellOf(a, b);
    if (!found) continue;
    const cell = { ...found, rowVariable: a, columnVariable: b };
    const pair = `${cell.rowVariable}~${cell.columnVariable}`;
    result.estimates.push({
      key: `r:${pair}`,
      label: `${spec.method === 'spearman' ? 'ρ' : 'r'}(${cell.rowVariable}, ${cell.columnVariable})`,
      family: 'correlation',
      term: pair,
      stat: spec.method === 'spearman' ? 'rho' : 'r',
      estimate: cell.r,
      df: cell.n - 2,
      p: spec.adjust === 'none' ? cell.pValue : cell.adjustedPValue,
      ciLow: cell.confidenceInterval?.lower ?? null,
      ciHigh: cell.confidenceInterval?.upper ?? null,
      ciLevel: cell.confidenceInterval?.level ?? null,
      ciMethod: cell.confidenceInterval ? 'fisher-z' : null,
      n: cell.n,
    });
  }
  result.issues.push(...fromWarnings(matrix.warnings));
  result.payload = { variables: matrix.variables, matrix: matrix.matrix, cells: matrix.cells, risk: matrix.risk };
  return result;
}

/* -------------------------------------------------------------------------- */
/*                                 Regression                                 */
/* -------------------------------------------------------------------------- */

export function regression(spec: Spec<'regression'>, data: Data): NormalisedResult {
  const outcome = { name: spec.outcome, values: numeric(data, spec.outcome).values };
  const predictors = spec.predictors.map((name) => ({ name, values: numeric(data, name).values }));
  const fit: InferentialResult = linearRegression(outcome, predictors, { confidenceLevel: spec.confidenceLevel });
  const detail = fit.detail as { coefficients: RegressionCoefficient[]; rSquared: number; adjustedRSquared: number; durbinWatson: number; dfResidual: number; dfModel: number; standardError: number };

  /* Diagnostics on the same listwise sample. */
  const rows = completeRows([outcome.values, ...predictors.map((p) => p.values)]);
  const y = pick(outcome.values, rows);
  const xs = predictors.map((p) => ({ name: p.name, values: pick(p.values, rows) }));
  const diag = ols(y, xs, spec.confidenceLevel);
  const cooks = diag.residuals.map((e, i) => (e * e * (diag.hat[i] as number)) / (diag.k * diag.sigma2 * (1 - (diag.hat[i] as number)) ** 2));
  const squared = diag.residuals.map((e) => e * e);
  const aux = ols(squared, xs);
  const bp = diag.n * aux.rSquared;
  const bpDf = xs.length;
  const bpP = chiSquareSf(bp, bpDf);
  const cookThreshold = 4 / diag.n;
  const influential = cooks.filter((value) => value > cookThreshold).length;
  const maxCook = Math.max(...cooks);
  const maxLeverage = Math.max(...diag.hat);

  const result = base(spec, 'ols', { supplied: fit.rowsSupplied, used: fit.n, excluded: fit.rowsDropped, missingStrategy: 'listwise' }, {
    confidenceLevel: spec.confidenceLevel,
    intercept: true,
    heteroscedasticity: 'Breusch-Pagan (Koenker, studentised)',
    influence: "Cook's distance, threshold 4/n",
  });
  for (const coefficient of detail.coefficients) {
    const term = coefficient.name;
    result.estimates.push({
      key: `coef:${term}`,
      label: `b (${term})`,
      family: 'coefficient',
      term,
      stat: 'b',
      estimate: coefficient.b,
      se: coefficient.standardError,
      statistic: coefficient.t,
      statisticName: 't',
      df: detail.dfResidual,
      p: coefficient.pValue,
      ciLow: coefficient.confidenceInterval.lower,
      ciHigh: coefficient.confidenceInterval.upper,
      ciLevel: coefficient.confidenceInterval.level,
      ciMethod: 't',
      n: fit.n,
    });
    if (term !== '(intercept)') {
      result.estimates.push({ key: `beta:${term}`, label: `β (${term})`, family: 'coefficient', term, stat: 'beta', estimate: coefficient.beta, n: fit.n });
      if (coefficient.vif !== null) result.estimates.push({ key: `vif:${term}`, label: `VIF (${term})`, family: 'diagnostic', term, stat: 'vif', estimate: coefficient.vif, n: fit.n });
    }
  }
  const model = (key: string, label: string, stat: string, estimate: number, extra: Partial<Estimate> = {}) =>
    result.estimates.push({ key: `model:${key}`, label, family: 'model', term: null, stat, estimate, n: fit.n, ...extra });
  model('r2', 'R²', 'r2', detail.rSquared);
  model('adj_r2', 'Adjusted R²', 'adj_r2', detail.adjustedRSquared);
  model('F', 'F', 'F', fit.statistic.value, { statistic: fit.statistic.value, statisticName: 'F', df: detail.dfModel, df2: detail.dfResidual, p: fit.pValue });
  model('rmse', 'Residual standard error', 'sigma', detail.standardError);
  result.estimates.push({ key: 'diag:breusch_pagan', label: 'Breusch–Pagan (Koenker)', family: 'diagnostic', term: null, stat: 'bp', estimate: bp, statistic: bp, statisticName: 'chi2', df: bpDf, p: bpP, n: fit.n });
  result.estimates.push({ key: 'diag:durbin_watson', label: 'Durbin–Watson', family: 'diagnostic', term: null, stat: 'dw', estimate: detail.durbinWatson, n: fit.n });
  result.estimates.push({ key: 'diag:max_cooks', label: "Largest Cook's distance", family: 'diagnostic', term: null, stat: 'cooks_max', estimate: maxCook, n: fit.n });
  result.estimates.push({ key: 'diag:max_leverage', label: 'Largest leverage', family: 'diagnostic', term: null, stat: 'leverage_max', estimate: maxLeverage, n: fit.n });

  const normality = fit.assumptions.find((a) => a.key === 'normality');
  if (normality) result.assumptions.push({ key: 'residual-normality', status: normality.status, statistic: fin(normality.statistic), p: fin(normality.pValue), detail: 'Shapiro–Wilk on residuals' });
  result.assumptions.push({ key: 'homoscedasticity', status: bpP < 0.05 ? 'violated' : 'met', statistic: bp, p: bpP, detail: `Breusch–Pagan χ²(${bpDf})` });
  const worstVif = Math.max(1, ...detail.coefficients.map((c) => c.vif ?? 1));
  result.assumptions.push({ key: 'multicollinearity', status: worstVif >= 10 ? 'violated' : worstVif >= 5 ? 'inconclusive' : 'met', statistic: worstVif, detail: 'largest VIF (5 caution, 10 severe)' });
  result.assumptions.push({ key: 'influence', status: maxCook > 1 ? 'violated' : 'met', statistic: maxCook, detail: `${influential} cases above 4/n` });
  /* Durbin–Watson is about ordered observations; row order in a survey file means nothing, so it is reported, not judged. */
  result.assumptions.push({ key: 'autocorrelation', status: 'info', statistic: detail.durbinWatson, detail: 'Durbin–Watson; meaningful only when rows are in time or collection order' });
  result.assumptions.push({ key: 'independence', status: 'not-testable' });

  result.issues.push(...fromWarnings(fit.warnings.filter((w) => w.code !== 'residual-autocorrelation' && w.code !== 'heteroscedasticity')));
  if (worstVif >= 10) result.issues.push({ code: 'severe-multicollinearity', severity: 'WARNING', columns: spec.predictors, message: `Largest VIF ${worstVif.toFixed(2)} (≥ 10): coefficients are unstable.`, messageAr: 'تعدد خطي شديد.', details: { vif: Number(worstVif.toFixed(3)) } });
  if (bpP < 0.05) result.issues.push({ code: 'heteroscedasticity', severity: 'WARNING', columns: [spec.outcome], message: `Breusch–Pagan p = ${bpP.toPrecision(3)}: residual variance is not constant; standard errors may be biased.`, messageAr: 'تباين البواقي غير ثابت.' });
  if (influential > 0) result.issues.push({ code: 'influential-cases', severity: maxCook > 1 ? 'WARNING' : 'INFO', columns: [], message: `${influential} cases have Cook's distance above 4/n (largest ${maxCook.toFixed(3)}).`, messageAr: 'حالات مؤثرة.', details: { influential, maxCook: Number(maxCook.toFixed(4)) } });
  result.payload = { coefficients: detail.coefficients, dfModel: detail.dfModel, dfResidual: detail.dfResidual };
  return result;
}

/* -------------------------------------------------------------------------- */
/*                                    ANOVA                                   */
/* -------------------------------------------------------------------------- */

export interface GamesHowellComparison {
  groupA: string;
  groupB: string;
  meanDifference: number;
  standardError: number;
  t: number;
  df: number;
  pValue: number;
  confidenceInterval: { level: number; lower: number; upper: number };
}

/**
 * Games–Howell: pairwise comparisons that assume neither equal variances nor
 * equal sizes. Welch's standard error and df per pair, referred to the
 * studentized range with k groups (q = |t|·√2).
 */
export function gamesHowell(groups: number[][], labels: string[], level: number): GamesHowellComparison[] {
  const k = groups.length;
  const stats = groups.map((values) => ({ n: values.length, mean: mean(values), variance: variance(values) }));
  const out: GamesHowellComparison[] = [];
  for (let i = 0; i < k; i += 1) {
    for (let j = i + 1; j < k; j += 1) {
      const a = stats[i]!;
      const b = stats[j]!;
      const va = a.variance / a.n;
      const vb = b.variance / b.n;
      const se = Math.sqrt(va + vb);
      const df = (va + vb) ** 2 / (va ** 2 / (a.n - 1) + vb ** 2 / (b.n - 1));
      const diff = a.mean - b.mean;
      const t = diff / se;
      const critical = studentizedRangeQuantile(level, k, df) / Math.SQRT2;
      out.push({
        groupA: labels[i]!,
        groupB: labels[j]!,
        meanDifference: diff,
        standardError: se,
        t,
        df,
        pValue: studentizedRangeSf(Math.abs(t) * Math.SQRT2, k, df),
        confidenceInterval: { level, lower: diff - critical * se, upper: diff + critical * se },
      });
    }
  }
  return out;
}

export function anova(spec: Spec<'anova'>, data: Data): NormalisedResult {
  const outcome = numeric(data, spec.outcome).values;
  const groupsColumn = categorical(data, spec.group).values;
  const labels: string[] = [];
  const buckets = new Map<string, number[]>();
  let supplied = 0;
  let excluded = 0;
  outcome.forEach((value, row) => {
    supplied += 1;
    const label = groupsColumn[row];
    if (label == null || !Number.isFinite(value)) {
      excluded += 1;
      return;
    }
    if (!buckets.has(label)) {
      buckets.set(label, []);
      labels.push(label);
    }
    buckets.get(label)!.push(value);
  });
  /* Groups in a stable, sorted order so the same data always gives the same keys. */
  labels.sort();
  const groups = labels.map((label) => buckets.get(label)!);
  const fit = oneWayAnova(groups, labels, { confidenceLevel: 1 - spec.alpha });
  const detail = fit.detail as { ssBetween: number; ssWithin: number; dfBetween: number; dfWithin: number; msWithin: number; etaSquared: number; omegaSquared: number; primaryForm: string };
  const homogeneity = fit.assumptions.find((a) => a.key === 'homogeneity-of-variance');
  const unequal = homogeneity?.status === 'violated';
  const omnibusP = fit.pValue;
  const method = spec.postHoc === 'auto' ? (unequal ? 'games-howell' : 'tukey') : spec.postHoc;
  const runPostHoc = method !== 'none' && omnibusP < spec.alpha && groups.length > 2;

  const result = base(spec, `one-way-anova${fit.statistic.name.includes('Welch') ? '(welch)' : ''}${runPostHoc ? `+${method}` : ''}`, {
    supplied,
    used: supplied - excluded,
    excluded,
    missingStrategy: 'listwise',
  }, { alpha: spec.alpha, postHoc: spec.postHoc, postHocUsed: runPostHoc ? method : 'none', postHocGate: `omnibus p < ${spec.alpha}`, homogeneity: 'Levene (Brown-Forsythe, median)' });

  const classical = fit.secondary?.label === 'classical' ? fit.secondary : null;
  const F = classical ? classical.statistic.value : fit.statistic.value;
  const Fdf = (classical ? classical.df : fit.df) as [number, number];
  const Fp = classical ? classical.pValue : fit.pValue;
  result.estimates.push({ key: 'anova:F', label: 'F (classical)', family: 'model', term: spec.group, stat: 'F', estimate: F, statistic: F, statisticName: 'F', df: Fdf[0], df2: Fdf[1], p: Fp, n: fit.n });
  const welch = fit.statistic.name.includes('Welch') ? { value: fit.statistic.value, df: fit.df as [number, number], p: fit.pValue } : fit.secondary?.label === 'welch' ? { value: fit.secondary.statistic.value, df: fit.secondary.df as [number, number], p: fit.secondary.pValue } : null;
  if (welch) result.estimates.push({ key: 'anova:welch_F', label: 'F (Welch)', family: 'model', term: spec.group, stat: 'F_welch', estimate: welch.value, statistic: welch.value, statisticName: 'F', df: welch.df[0], df2: welch.df[1], p: welch.p, n: fit.n });
  result.estimates.push({ key: 'anova:eta2', label: 'η²', family: 'effect', term: spec.group, stat: 'eta2', estimate: detail.etaSquared, n: fit.n });
  result.estimates.push({ key: 'anova:omega2', label: 'ω²', family: 'effect', term: spec.group, stat: 'omega2', estimate: detail.omegaSquared, n: fit.n });
  for (const estimate of fit.estimates) {
    result.estimates.push({ key: `mean:${estimate.label}`, label: `Mean (${estimate.label})`, family: 'group', term: estimate.label, stat: 'mean', estimate: estimate.mean, se: estimate.se, n: estimate.n });
    result.estimates.push({ key: `sd:${estimate.label}`, label: `SD (${estimate.label})`, family: 'group', term: estimate.label, stat: 'sd', estimate: estimate.sd, n: estimate.n });
  }
  if (homogeneity) result.assumptions.push({ key: 'homogeneity-of-variance', status: homogeneity.status, statistic: fin(homogeneity.statistic), p: fin(homogeneity.pValue), detail: 'Levene (median)' });
  result.assumptions.push({ key: 'primary-test', status: 'info', detail: `${detail.primaryForm} F reported as primary` });

  let comparisons: (TukeyComparison | GamesHowellComparison)[] = [];
  if (runPostHoc) {
    comparisons = method === 'tukey' ? tukeyHsd(groups, labels, groups.map(mean), detail.msWithin, detail.dfWithin, 1 - spec.alpha) : gamesHowell(groups, labels, 1 - spec.alpha);
    for (const c of comparisons) {
      const pair = `${c.groupA}|${c.groupB}`;
      result.estimates.push({
        key: `posthoc:${pair}`,
        label: `${c.groupA} − ${c.groupB} (${method})`,
        family: 'posthoc',
        term: pair,
        stat: 'mean_difference',
        estimate: c.meanDifference,
        se: c.standardError,
        statistic: 'q' in c ? c.q : c.t,
        statisticName: 'q' in c ? 'q' : 't',
        df: 'df' in c ? c.df : detail.dfWithin,
        p: c.pValue,
        ciLow: c.confidenceInterval.lower,
        ciHigh: c.confidenceInterval.upper,
        ciLevel: c.confidenceInterval.level,
        ciMethod: method,
      });
    }
  }
  result.issues.push(...fromWarnings(fit.warnings.filter((w) => w.code !== 'tukey-assumes-equal-variances')));
  if (runPostHoc && method === 'tukey' && unequal) {
    result.issues.push({ code: 'tukey-with-unequal-variances', severity: 'WARNING', columns: [spec.group], message: 'Tukey was requested although Levene rejects equal variances; Games–Howell is the appropriate procedure.', messageAr: 'اختبار توكي مع تباينات غير متساوية.' });
  }
  if (excluded > 0) result.issues.push({ code: 'listwise-deletion', severity: excluded / supplied > 0.2 ? 'WARNING' : 'INFO', columns: [spec.outcome, spec.group], message: `${excluded} rows missing the outcome or the group were excluded.`, messageAr: `استُبعد ${excluded} صفًا.`, details: { excluded } });
  result.payload = { groups: labels, comparisons, ssBetween: detail.ssBetween, ssWithin: detail.ssWithin, primaryForm: detail.primaryForm };
  return result;
}
