/**
 * Mediation (PROCESS model 4) and moderation (PROCESS model 1), by OLS.
 *
 * Mediation: M = i₁ + aX (+ covariates); Y = i₂ + c′X + bM (+ covariates);
 * Y = i₃ + cX (+ covariates). Indirect effect a·b with a percentile bootstrap
 * interval (B resamples of whole cases, Mulberry32 with the specification's
 * seed, quantile type 7). Sobel's normal-theory test is reported as a secondary
 * result only. Completely standardised effects multiply by SD(X)/SD(Y).
 *
 * Moderation: Y = b₀ + b₁X + b₂W + b₃XW (+ covariates), with X and W optionally
 * mean-centred before the product is formed (recorded). Conditional effects of
 * X at W = mean − SD, mean, mean + SD (or at the two codes of a binary W):
 * θ = b₁ + b₃w, SE² = v₁₁ + w²v₃₃ + 2w·v₁₃, t on the residual df.
 *
 * Coefficients, SEs and conditional effects are checked against R `lm`/`vcov`.
 */

import { fSf, normalSf, tQuantile, tTwoTailed } from '../../distributions';
import { mean, standardDeviation } from '../../stats-core';

import { completeRows, numeric, pick } from '../data';
import { ols, olsCoefficients, quantileSorted, seededRandom, type OlsFit } from '../numerics';
import type { MethodSpec } from '../spec';
import { ENGINE, type Estimate, type Issue, type NormalisedResult } from '../types';

type Data = import('../types').EngineDataset;
type Mediation = Extract<MethodSpec, { analysisType: 'mediation' }>;
type Moderation = Extract<MethodSpec, { analysisType: 'moderation' }>;

function coefficient(fit: OlsFit, name: string, key: string, label: string, n: number): Estimate {
  const i = fit.names.indexOf(name);
  return {
    key,
    label,
    family: 'path',
    term: name,
    stat: 'b',
    estimate: fit.b[i] as number,
    se: fit.se[i] as number,
    statistic: fit.t[i] as number,
    statisticName: 't',
    df: fit.dfResidual,
    p: fit.p[i] as number,
    ciLow: fit.ciLow[i] as number,
    ciHigh: fit.ciHigh[i] as number,
    ciLevel: null,
    ciMethod: 't',
    n,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Mediation                                 */
/* -------------------------------------------------------------------------- */

export function mediation(spec: Mediation, data: Data): NormalisedResult {
  const names = [spec.x, spec.m, spec.y, ...spec.covariates];
  const columns = names.map((name) => numeric(data, name).values);
  const rows = completeRows(columns);
  const [x, m, y, ...covariates] = columns.map((values) => pick(values, rows)) as number[][];
  const n = rows.length;
  const level = spec.bootstrap.confidenceLevel;
  const cov = spec.covariates.map((name, i) => ({ name, values: covariates[i] as number[] }));

  const aFit = ols(m!, [{ name: spec.x, values: x! }, ...cov], level);
  const bFit = ols(y!, [{ name: spec.x, values: x! }, { name: spec.m, values: m! }, ...cov], level);
  const cFit = ols(y!, [{ name: spec.x, values: x! }, ...cov], level);
  const a = aFit.b[1] as number;
  const b = bFit.b[2] as number;
  const cPrime = bFit.b[1] as number;
  const c = cFit.b[1] as number;
  const indirect = a * b;

  /* Percentile bootstrap of a·b. */
  const random = seededRandom(spec.bootstrap.seed);
  const draws: number[] = [];
  let failed = 0;
  for (let draw = 0; draw < spec.bootstrap.resamples; draw += 1) {
    const sample = Array.from({ length: n }, () => Math.floor(random() * n));
    const bx = sample.map((i) => x![i] as number);
    const bm = sample.map((i) => m![i] as number);
    const by = sample.map((i) => y![i] as number);
    const bcov = covariates.map((values) => sample.map((i) => values[i] as number));
    try {
      const ba = olsCoefficients(bm, [bx, ...bcov])[1] as number;
      const bb = olsCoefficients(by, [bx, bm, ...bcov])[2] as number;
      if (Number.isFinite(ba * bb)) draws.push(ba * bb);
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  draws.sort((p, q) => p - q);
  const lower = quantileSorted(draws, (1 - level) / 2);
  const upper = quantileSorted(draws, 1 - (1 - level) / 2);
  const bootSe = standardDeviation(draws);

  const seA = aFit.se[1] as number;
  const seB = bFit.se[2] as number;
  const sobelSe = Math.sqrt(b * b * seA * seA + a * a * seB * seB);
  const sobelZ = indirect / sobelSe;
  const sobelP = 2 * normalSf(Math.abs(sobelZ));

  const sdX = standardDeviation(x!);
  const sdY = standardDeviation(y!);
  const toStd = sdX / sdY;

  const issues: Issue[] = [];
  if (failed > 0) issues.push({ code: 'bootstrap-failures', severity: failed / spec.bootstrap.resamples > 0.01 ? 'WARNING' : 'INFO', columns: names, message: `${failed} of ${spec.bootstrap.resamples} resamples could not be estimated and were discarded.`, messageAr: 'فشلت بعض إعادات المعاينة.', details: { failed } });
  const excluded = data.rows.length - n;
  if (excluded > 0) issues.push({ code: 'listwise-deletion', severity: excluded / data.rows.length > 0.2 ? 'WARNING' : 'INFO', columns: names, message: `${excluded} rows with a missing value in X, M, Y or a covariate were excluded.`, messageAr: `استُبعد ${excluded} صفًا.`, details: { excluded } });
  issues.push({ code: 'causal-assumptions', severity: 'INFO', columns: names, message: 'Mediation estimates are causal only under the design’s assumptions (temporal order, no unmeasured confounding); the analysis cannot check them.', messageAr: 'تفسير الوساطة سببيًا يتطلب افتراضات التصميم.' });

  const withLevel = (estimate: Estimate): Estimate => ({ ...estimate, ciLevel: level });
  const estimates: Estimate[] = [
    withLevel(coefficient(aFit, spec.x, 'path:a', `a (${spec.x} → ${spec.m})`, n)),
    withLevel(coefficient(bFit, spec.m, 'path:b', `b (${spec.m} → ${spec.y} | ${spec.x})`, n)),
    withLevel(coefficient(bFit, spec.x, 'effect:direct', `Direct effect c′ (${spec.x} → ${spec.y})`, n)),
    withLevel(coefficient(cFit, spec.x, 'effect:total', `Total effect c (${spec.x} → ${spec.y})`, n)),
    {
      key: 'effect:indirect',
      label: `Indirect effect a·b (${spec.x} → ${spec.m} → ${spec.y})`,
      family: 'effect',
      term: `${spec.x}>${spec.m}>${spec.y}`,
      stat: 'indirect',
      estimate: indirect,
      se: bootSe,
      ciLow: lower,
      ciHigh: upper,
      ciLevel: level,
      ciMethod: 'bootstrap-percentile',
      n,
    },
    { key: 'effect:indirect_std', label: 'Completely standardised indirect effect', family: 'effect', term: `${spec.x}>${spec.m}>${spec.y}`, stat: 'indirect_std', estimate: indirect * toStd, ciLow: lower * toStd, ciHigh: upper * toStd, ciLevel: level, ciMethod: 'bootstrap-percentile', n },
    { key: 'effect:direct_std', label: 'Completely standardised direct effect', family: 'effect', term: spec.x, stat: 'direct_std', estimate: cPrime * toStd, n },
    { key: 'effect:total_std', label: 'Completely standardised total effect', family: 'effect', term: spec.x, stat: 'total_std', estimate: c * toStd, n },
    { key: 'test:sobel', label: 'Sobel test (normal theory; secondary)', family: 'test', term: null, stat: 'z', estimate: sobelZ, se: sobelSe, statistic: sobelZ, statisticName: 'z', p: sobelP, n },
    { key: 'model:r2_m', label: `R² (${spec.m})`, family: 'model', term: spec.m, stat: 'r2', estimate: aFit.rSquared, statistic: aFit.f, statisticName: 'F', df: aFit.fDf1, df2: aFit.dfResidual, p: aFit.fP, n },
    { key: 'model:r2_y', label: `R² (${spec.y})`, family: 'model', term: spec.y, stat: 'r2', estimate: bFit.rSquared, statistic: bFit.f, statisticName: 'F', df: bFit.fDf1, df2: bFit.dfResidual, p: bFit.fP, n },
  ];
  cov.forEach((covariate) => estimates.push(withLevel(coefficient(bFit, covariate.name, `covariate:${covariate.name}`, `Covariate ${covariate.name} (→ ${spec.y})`, n))));

  return {
    analysisType: 'mediation',
    method: 'process-model-4-ols+percentile-bootstrap',
    engine: ENGINE,
    sample: { supplied: data.rows.length, used: n, excluded, missingStrategy: 'listwise' },
    estimates,
    assumptions: [
      { key: 'indirect-effect', status: 'info', detail: lower > 0 || upper < 0 ? 'bootstrap interval excludes zero' : 'bootstrap interval includes zero' },
      { key: 'causal-order', status: 'not-testable' },
    ],
    issues,
    parameters: { resamples: spec.bootstrap.resamples, confidenceLevel: level, interval: 'percentile, quantile type 7', rng: 'mulberry32', resampling: 'cases with replacement', covariates: spec.covariates, discarded: failed },
    seed: spec.bootstrap.seed,
    payload: { draws: draws.length, bootstrapMean: mean(draws), pathFits: { a: aFit.b, bAndCPrime: bFit.b, c: cFit.b } },
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Moderation                                */
/* -------------------------------------------------------------------------- */

export function moderation(spec: Moderation, data: Data): NormalisedResult {
  const names = [spec.x, spec.w, spec.y, ...spec.covariates];
  const columns = names.map((name) => numeric(data, name).values);
  const rows = completeRows(columns);
  const [xRaw, wRaw, y, ...covariates] = columns.map((values) => pick(values, rows)) as number[][];
  const n = rows.length;
  const level = spec.confidenceLevel;
  const meanX = mean(xRaw!);
  const meanW = mean(wRaw!);
  const x = spec.centering === 'mean' ? xRaw!.map((v) => v - meanX) : xRaw!;
  const w = spec.centering === 'mean' ? wRaw!.map((v) => v - meanW) : wRaw!;
  const product = x.map((v, i) => v * (w[i] as number));
  const interaction = `${spec.x}×${spec.w}`;
  const cov = spec.covariates.map((name, i) => ({ name, values: covariates[i] as number[] }));
  const fit = ols(y!, [{ name: spec.x, values: x }, { name: spec.w, values: w }, { name: interaction, values: product }, ...cov], level);
  const reduced = ols(y!, [{ name: spec.x, values: x }, { name: spec.w, values: w }, ...cov], level);
  const deltaR2 = fit.rSquared - reduced.rSquared;
  const fChange = (deltaR2 / 1) / ((1 - fit.rSquared) / fit.dfResidual);
  const fChangeP = fSf(fChange, 1, fit.dfResidual);

  /* Probe values of W, on the scale W entered the model. */
  const distinct = [...new Set(wRaw!)].sort((p, q) => p - q);
  const binary = distinct.length === 2;
  const sdW = standardDeviation(wRaw!);
  const probes = binary
    ? distinct.map((value) => ({ label: `${spec.w} = ${value}`, raw: value }))
    : [
        { label: `${spec.w} = M − 1 SD`, raw: meanW - sdW },
        { label: `${spec.w} = M`, raw: meanW },
        { label: `${spec.w} = M + 1 SD`, raw: meanW + sdW },
      ];
  const critical = tQuantile(1 - (1 - level) / 2, fit.dfResidual);
  const v = fit.vcov;
  const conditional = probes.map((probe) => {
    const wValue = spec.centering === 'mean' ? probe.raw - meanW : probe.raw;
    const effect = (fit.b[1] as number) + (fit.b[3] as number) * wValue;
    const se = Math.sqrt((v[1]![1] as number) + wValue * wValue * (v[3]![3] as number) + 2 * wValue * (v[1]![3] as number));
    const t = effect / se;
    return { ...probe, wValue, effect, se, t, p: tTwoTailed(t, fit.dfResidual), lower: effect - critical * se, upper: effect + critical * se };
  });

  const withLevel = (estimate: Estimate): Estimate => ({ ...estimate, ciLevel: level });
  const estimates: Estimate[] = [
    withLevel(coefficient(fit, '(intercept)', 'coef:(intercept)', 'Intercept', n)),
    withLevel(coefficient(fit, spec.x, `coef:${spec.x}`, `b₁ (${spec.x}${spec.centering === 'mean' ? ', centred' : ''})`, n)),
    withLevel(coefficient(fit, spec.w, `coef:${spec.w}`, `b₂ (${spec.w}${spec.centering === 'mean' ? ', centred' : ''})`, n)),
    withLevel(coefficient(fit, interaction, 'coef:interaction', `b₃ (${interaction})`, n)),
    { key: 'model:r2', label: 'R²', family: 'model', term: null, stat: 'r2', estimate: fit.rSquared, statistic: fit.f, statisticName: 'F', df: fit.fDf1, df2: fit.dfResidual, p: fit.fP, n },
    { key: 'model:delta_r2', label: 'ΔR² from the interaction', family: 'model', term: interaction, stat: 'delta_r2', estimate: deltaR2, statistic: fChange, statisticName: 'F', df: 1, df2: fit.dfResidual, p: fChangeP, n },
  ];
  cov.forEach((covariate) => estimates.push(withLevel(coefficient(fit, covariate.name, `covariate:${covariate.name}`, `Covariate ${covariate.name}`, n))));
  conditional.forEach((effect, i) =>
    estimates.push({
      key: `conditional:${i + 1}`,
      label: `Effect of ${spec.x} at ${effect.label}`,
      family: 'conditional',
      term: effect.label,
      stat: 'conditional_effect',
      estimate: effect.effect,
      se: effect.se,
      statistic: effect.t,
      statisticName: 't',
      df: fit.dfResidual,
      p: effect.p,
      ciLow: effect.lower,
      ciHigh: effect.upper,
      ciLevel: level,
      ciMethod: 't',
      n,
    }),
  );

  const issues: Issue[] = [];
  const excluded = data.rows.length - n;
  if (excluded > 0) issues.push({ code: 'listwise-deletion', severity: excluded / data.rows.length > 0.2 ? 'WARNING' : 'INFO', columns: names, message: `${excluded} rows with a missing value were excluded.`, messageAr: `استُبعد ${excluded} صفًا.`, details: { excluded } });
  if (!binary && distinct.length < 5) issues.push({ code: 'few-moderator-values', severity: 'INFO', columns: [spec.w], message: `${spec.w} has only ${distinct.length} distinct values; probing at ±1 SD may fall between observed values.`, messageAr: 'قيم المعدِّل قليلة.' });

  return {
    analysisType: 'moderation',
    method: 'process-model-1-ols',
    engine: ENGINE,
    sample: { supplied: data.rows.length, used: n, excluded, missingStrategy: 'listwise' },
    estimates,
    assumptions: [{ key: 'probe', status: 'info', detail: binary ? 'binary moderator: effects at its two codes' : 'effects at mean and ±1 SD of the moderator' }],
    issues,
    parameters: { centering: spec.centering, confidenceLevel: level, probe: binary ? 'binary codes' : 'mean ± 1 SD', covariates: spec.covariates, means: { [spec.x]: meanX, [spec.w]: meanW }, sdW },
    seed: null,
    payload: { coefficients: fit.names.map((name, i) => ({ name, b: fit.b[i], se: fit.se[i] })), vcov: fit.vcov, conditional },
  };
}
