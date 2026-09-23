/**
 * CFA (maximum likelihood, lavaan-checked) and PLS-SEM, through the existing
 * engines, normalised, with validity evidence:
 *
 * - CFA: loadings (unstandardised with SE/z/p; standardised as lavaan std.all),
 *   factor correlations, fit indices, CR and AVE, Fornell–Larcker (√AVE versus
 *   factor correlations) and HTMT (from observed item correlations, absolute,
 *   as `semTools::htmt`).
 * - PLS: path coefficients, outer loadings/weights, R², CR/α/AVE, HTMT,
 *   Fornell–Larcker; optional seeded bootstrap (SE, t, p, percentile CI).
 *   Blindfolding Q² is not part of verified results (non-standard; P1-C audit).
 *
 * Full CB-SEM with structural paths is not implemented here; it belongs to the
 * R engine (lavaan) and is not approximated.
 */

import { confirmatoryFactorAnalysis, type CbSemResult } from '../../inference/cbsem/cfa';
import { estimatePls, validateModel, type PlsEstimate } from '../../inference/pls/algorithm';
import { assessDiscriminantValidity, assessMeasurement, assessStructural } from '../../inference/pls/assessment';
import { bootstrapPls } from '../../inference/pls/bootstrap';
import type { PlsModel } from '../../inference/pls/schema';
import { pearson } from '../../stats-core';

import { completeRows, numeric, pick } from '../data';
import type { MethodSpec } from '../spec';
import { ENGINE, type Estimate, type Issue, type NormalisedResult } from '../types';

type Data = import('../types').EngineDataset;
type Cfa = Extract<MethodSpec, { analysisType: 'cfa' }>;
type Pls = Extract<MethodSpec, { analysisType: 'pls' }>;

function dataMap(data: Data, names: string[]): Map<string, number[]> {
  return new Map(names.map((name) => [name, numeric(data, name).values]));
}

/** HTMT between two constructs, from absolute observed item correlations (semTools `absolute = TRUE`). */
export function htmt(a: string[], b: string[], columns: Map<string, number[]>): number {
  const r = (x: string, y: string) => Math.abs(pearson(columns.get(x)!, columns.get(y)!));
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const hetero = mean(a.flatMap((x) => b.map((y) => r(x, y))));
  const mono = (items: string[]) => mean(items.flatMap((x, i) => items.slice(i + 1).map((y) => r(x, y))));
  return hetero / Math.sqrt(mono(a) * mono(b));
}

const warn = (warnings: { code: string; severity: string; params?: Record<string, string | number> }[], columns: string[]): Issue[] =>
  warnings.map((warning) => ({
    code: warning.code,
    severity: warning.severity === 'info' ? 'INFO' : 'WARNING',
    columns,
    message: `${warning.code}${warning.params ? ` (${Object.entries(warning.params).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`,
    messageAr: warning.code,
    ...(warning.params ? { details: warning.params } : {}),
  }));

/* -------------------------------------------------------------------------- */
/*                                     CFA                                    */
/* -------------------------------------------------------------------------- */

export function cfa(spec: Cfa, data: Data): NormalisedResult {
  const indicators = spec.constructs.flatMap((c) => c.indicators);
  const map = dataMap(data, indicators);
  const model = { constructs: spec.constructs.map((c) => ({ ...c, mode: 'reflective' as const })), paths: [] } as unknown as PlsModel;
  const fit: CbSemResult = confirmatoryFactorAnalysis(model, map);
  const n = fit.n;
  const e: Estimate[] = [];
  for (const loading of fit.loadings) {
    const term = `${loading.construct}=~${loading.indicator}`;
    e.push({
      key: `loading:${term}`,
      label: `${loading.indicator} on ${loading.construct}`,
      family: 'loading',
      term,
      stat: 'loading',
      estimate: loading.estimate,
      se: loading.isReference ? null : loading.standardError,
      statistic: loading.isReference ? null : loading.zValue,
      statisticName: loading.isReference ? null : 'z',
      p: loading.isReference ? null : loading.pValue,
      n,
    });
    e.push({ key: `std_loading:${term}`, label: `Standardised loading (${loading.indicator})`, family: 'loading', term, stat: 'std_loading', estimate: loading.standardised, n });
  }
  for (const r of fit.factorCorrelations) {
    e.push({ key: `factor_r:${r.first}|${r.second}`, label: `r(${r.first}, ${r.second})`, family: 'factor-correlation', term: `${r.first}|${r.second}`, stat: 'factor_r', estimate: r.estimate, se: r.standardError, statistic: r.zValue, statisticName: 'z', p: r.pValue, n });
  }
  const f = fit.fit;
  e.push({ key: 'fit:chi2', label: 'χ²', family: 'fit', term: null, stat: 'chi2', estimate: f.chiSquare, statistic: f.chiSquare, statisticName: 'chi2', df: f.df, p: f.pValue, n });
  for (const [key, label, value] of [
    ['cfi', 'CFI', f.cfi],
    ['tli', 'TLI', f.tli],
    ['rmsea', 'RMSEA', f.rmsea],
    ['srmr', 'SRMR', f.srmr],
    ['normed_chi2', 'χ²/df', f.normedChiSquare],
  ] as const) {
    e.push({ key: `fit:${key}`, label, family: 'fit', term: null, stat: key, estimate: value, n });
  }
  for (const entry of fit.reliability) {
    e.push({ key: `cr:${entry.construct}`, label: `Composite reliability (${entry.construct})`, family: 'validity', term: entry.construct, stat: 'cr', estimate: entry.compositeReliability, n });
    e.push({ key: `ave:${entry.construct}`, label: `AVE (${entry.construct})`, family: 'validity', term: entry.construct, stat: 'ave', estimate: entry.ave, n });
  }

  /* Discriminant validity, on the same listwise rows as the fit. */
  const rows = completeRows(indicators.map((name) => map.get(name)!));
  const complete = new Map(indicators.map((name) => [name, pick(map.get(name)!, rows)]));
  const issues: Issue[] = warn(fit.warnings, indicators);
  const ave = new Map(fit.reliability.map((entry) => [entry.construct, entry.ave]));
  for (let i = 0; i < spec.constructs.length; i += 1) {
    for (let j = i + 1; j < spec.constructs.length; j += 1) {
      const a = spec.constructs[i]!;
      const b = spec.constructs[j]!;
      if (a.indicators.length < 2 || b.indicators.length < 2) continue;
      const value = htmt(a.indicators, b.indicators, complete);
      e.push({ key: `htmt:${a.name}|${b.name}`, label: `HTMT (${a.name}, ${b.name})`, family: 'validity', term: `${a.name}|${b.name}`, stat: 'htmt', estimate: value, n });
      if (value >= 0.85) issues.push({ code: 'htmt-high', severity: value >= 0.9 ? 'WARNING' : 'INFO', columns: [...a.indicators, ...b.indicators], message: `HTMT(${a.name}, ${b.name}) = ${value.toFixed(3)}: discriminant validity is doubtful (thresholds .85/.90).`, messageAr: 'صدق تمييزي مشكوك فيه.' });
      const r = fit.factorCorrelations.find((entry) => (entry.first === a.name && entry.second === b.name) || (entry.first === b.name && entry.second === a.name));
      if (r) {
        const holds = Math.sqrt(ave.get(a.name) ?? 0) > Math.abs(r.estimate) && Math.sqrt(ave.get(b.name) ?? 0) > Math.abs(r.estimate);
        if (!holds) issues.push({ code: 'fornell-larcker-violated', severity: 'WARNING', columns: [...a.indicators, ...b.indicators], message: `√AVE does not exceed |r| between ${a.name} and ${b.name}.`, messageAr: 'معيار فورنل-لاركر غير متحقق.' });
      }
    }
  }
  const convergent = fit.reliability.filter((entry) => entry.ave < 0.5 || entry.compositeReliability < 0.7);
  for (const entry of convergent) issues.push({ code: 'convergent-validity', severity: 'WARNING', columns: spec.constructs.find((c) => c.name === entry.construct)?.indicators ?? [], message: `${entry.construct}: CR ${entry.compositeReliability.toFixed(3)}, AVE ${entry.ave.toFixed(3)} (CR ≥ .70 and AVE ≥ .50 expected).`, messageAr: 'الصدق التقاربي غير كافٍ.' });
  if (!fit.converged) issues.push({ code: 'not-converged', severity: 'ERROR', columns: indicators, message: 'The estimation did not converge; no estimate from it is reported as valid.', messageAr: 'لم يتقارب التقدير.' });

  return {
    analysisType: 'cfa',
    method: 'ml-wishart+expected-information',
    engine: ENGINE,
    sample: { supplied: data.rows.length, used: n, excluded: fit.rowsDropped, missingStrategy: 'listwise' },
    estimates: e,
    assumptions: [{ key: 'model-fit', status: f.verdict === 'poor' ? 'violated' : f.verdict === 'acceptable' ? 'inconclusive' : 'met', detail: `CFI ${f.cfi.toFixed(3)}, RMSEA ${f.rmsea.toFixed(3)}, SRMR ${f.srmr.toFixed(3)}` }],
    issues,
    parameters: { estimator: 'ML', likelihood: 'wishart', information: 'expected', identification: 'marker (first indicator = 1)', standardisation: 'std.all (model-implied variances)', htmt: 'absolute observed correlations' },
    seed: null,
    payload: { iterations: fit.iterations, converged: fit.converged, parameters: fit.parameters, fit: f },
  };
}

/* -------------------------------------------------------------------------- */
/*                                     PLS                                    */
/* -------------------------------------------------------------------------- */

export function pls(spec: Pls, data: Data): NormalisedResult {
  const indicators = spec.constructs.flatMap((c) => c.indicators);
  const map = dataMap(data, indicators);
  const model: PlsModel = { constructs: spec.constructs.map((c) => ({ name: c.name, indicators: c.indicators, mode: c.mode })), paths: spec.paths };
  /* Model checks first (cycles, shared or unknown indicators, isolated constructs): a bad model yields no numbers. */
  validateModel(model, data.columns.map((c) => c.name));
  const estimate: PlsEstimate = estimatePls(model, map, { innerWeighting: spec.innerWeighting });
  const measurement = assessMeasurement(model, estimate, map);
  const discriminant = assessDiscriminantValidity(model, estimate, map, measurement);
  const structural = assessStructural(model, estimate);
  const boot = spec.bootstrap ? bootstrapPls(model, map, estimate, { resamples: spec.bootstrap.resamples, confidenceLevel: spec.bootstrap.confidenceLevel, seed: spec.bootstrap.seed }) : null;
  const n = estimate.n;
  const e: Estimate[] = [];
  const bootFor = (list: { key: string; standardError: number; tStatistic: number; pValue: number; lower: number; upper: number }[] | undefined, key: string) => list?.find((entry) => entry.key === key);
  for (const [key, value] of estimate.pathCoefficients) {
    const b = bootFor(boot?.paths, key);
    e.push({
      key: `path:${key}`,
      label: `Path ${key}`,
      family: 'path',
      term: key,
      stat: 'path',
      estimate: value,
      se: b?.standardError ?? null,
      statistic: b?.tStatistic ?? null,
      statisticName: b ? 't' : null,
      p: b?.pValue ?? null,
      ciLow: b?.lower ?? null,
      ciHigh: b?.upper ?? null,
      ciLevel: b ? spec.bootstrap!.confidenceLevel : null,
      ciMethod: b ? 'bootstrap-percentile' : null,
      n,
    });
  }
  for (const outer of estimate.outer) {
    const term = `${outer.construct}:${outer.indicator}`;
    const b = bootFor(boot?.loadings, term);
    e.push({ key: `loading:${term}`, label: `Loading ${outer.indicator} (${outer.construct})`, family: 'loading', term, stat: 'loading', estimate: outer.loading, se: b?.standardError ?? null, statistic: b?.tStatistic ?? null, statisticName: b ? 't' : null, p: b?.pValue ?? null, ciLow: b?.lower ?? null, ciHigh: b?.upper ?? null, ciLevel: b ? spec.bootstrap!.confidenceLevel : null, ciMethod: b ? 'bootstrap-percentile' : null, n });
    e.push({ key: `weight:${term}`, label: `Weight ${outer.indicator} (${outer.construct})`, family: 'weight', term, stat: 'weight', estimate: outer.weight, n });
  }
  for (const construct of measurement) {
    if (construct.compositeReliability) e.push({ key: `cr:${construct.construct}`, label: `ρc (${construct.construct})`, family: 'validity', term: construct.construct, stat: 'cr', estimate: construct.compositeReliability.value, n });
    if (construct.cronbachAlpha) e.push({ key: `alpha:${construct.construct}`, label: `α (${construct.construct})`, family: 'validity', term: construct.construct, stat: 'alpha', estimate: construct.cronbachAlpha.value, n });
    if (construct.ave) e.push({ key: `ave:${construct.construct}`, label: `AVE (${construct.construct})`, family: 'validity', term: construct.construct, stat: 'ave', estimate: construct.ave.value, n });
  }
  for (const [pair, criterion] of discriminant.htmt) {
    e.push({ key: `htmt:${pair}`, label: `HTMT (${pair})`, family: 'validity', term: pair, stat: 'htmt', estimate: criterion.value, n });
  }
  const issues: Issue[] = [];
  for (const endogenous of structural.endogenous) {
    e.push({ key: `r2:${endogenous.construct}`, label: `R² (${endogenous.construct})`, family: 'model', term: endogenous.construct, stat: 'r2', estimate: endogenous.rSquared, n });
    e.push({ key: `adj_r2:${endogenous.construct}`, label: `Adjusted R² (${endogenous.construct})`, family: 'model', term: endogenous.construct, stat: 'adj_r2', estimate: endogenous.adjustedRSquared, n });
  }
  for (const path of structural.paths) {
    e.push({ key: `f2:${path.from}→${path.to}`, label: `f² (${path.from} → ${path.to})`, family: 'effect', term: `${path.from}→${path.to}`, stat: 'f2', estimate: path.fSquared, n });
  }
  for (const entry of discriminant.fornellLarcker) {
    if (entry.verdict === 'violated') issues.push({ code: 'fornell-larcker-violated', severity: 'WARNING', columns: [], message: `√AVE of ${entry.construct} (${entry.sqrtAve.toFixed(3)}) does not exceed its correlation with ${entry.with} (${entry.highestCorrelation.toFixed(3)}).`, messageAr: 'معيار فورنل-لاركر غير متحقق.' });
  }
  if (!estimate.converged) issues.push({ code: 'not-converged', severity: 'ERROR', columns: indicators, message: 'The PLS algorithm did not converge; no estimate from it is reported as valid.', messageAr: 'لم تتقارب الخوارزمية.' });
  if (boot && boot.failed > 0) issues.push({ code: 'bootstrap-failures', severity: 'WARNING', columns: indicators, message: `${boot.failed} resamples failed to converge and were discarded.`, messageAr: 'فشلت بعض إعادات المعاينة.', details: { failed: boot.failed } });
  if (!boot) issues.push({ code: 'no-inference', severity: 'INFO', columns: [], message: 'No bootstrap was requested: paths have no standard errors, p-values or intervals.', messageAr: 'لم يُطلب البوتستراب.' });
  issues.push({ code: 'q2-not-verified', severity: 'INFO', columns: [], message: 'Blindfolding Q² is not included: the current implementation is not the standard Stone–Geisser procedure.', messageAr: 'لم يُدرج Q².' });
  return {
    analysisType: 'pls',
    method: `pls-sem(${spec.innerWeighting})${boot ? '+bootstrap' : ''}`,
    engine: ENGINE,
    sample: { supplied: data.rows.length, used: n, excluded: estimate.rowsDropped, missingStrategy: 'listwise' },
    estimates: e,
    assumptions: [],
    issues,
    parameters: { innerWeighting: spec.innerWeighting, maxIterations: 300, tolerance: 1e-7, alpha: 'standardised, from observed indicator correlations', bootstrap: spec.bootstrap, pValue: boot ? 'normal approximation to t = estimate/SE' : null },
    seed: spec.bootstrap?.seed ?? null,
    payload: { iterations: estimate.iterations, converged: estimate.converged, bootstrapFailed: boot?.failed ?? null },
  };
}
