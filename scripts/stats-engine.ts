/**
 * The P1-C statistics engine, without a database.
 *
 *   npm run test:stats
 *
 * Golden tests against R (evals/fixtures/references/engine.json, produced by
 * scripts/references/engine.R from the committed dataset
 * evals/fixtures/datasets/engine_survey.csv), plus edge cases, determinism,
 * validation severities, normalisation, tables and figures. No R at test time.
 */

import { readFileSync } from 'node:fs';

import { inspectOutput, numberSpellings } from '@/ai/guardrails';
import { parseCsv } from '@/analysis/parse';
import { toNumber } from '@/analysis/stats-core';
import { figuresFor } from '@/analysis/engine/figures';
import { promax, varimax } from '@/analysis/engine/methods/efa';
import { htmt } from '@/analysis/engine/methods/latent';
import { symmetricEigen } from '@/analysis/engine/numerics';
import { execute } from '@/analysis/engine/run';
import { isRandomised } from '@/analysis/engine/spec';
import { formatP, tablesFor } from '@/analysis/engine/tables';
import { canonicalJson, ENGINE, type ColumnType, type EngineDataset, type Estimate, type NormalisedResult } from '@/analysis/engine/types';
import { validateDataset, validateSpec } from '@/analysis/engine/validate';
import { methodSpecSchema } from '@/analysis/engine/spec';
import { confirmatoryFactorAnalysis } from '@/analysis/inference/cbsem/cfa';

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  if (!condition) console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}
function close(name: string, actual: number | null | undefined, expected: number, tolerance = 1e-8) {
  const good = typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));
  ok(name, good, `expected ${expected}, got ${actual}`);
}
const section = (title: string) => console.log(`\n${title}`);

/* ------------------------------------------------------------------ data */

const ref = JSON.parse(readFileSync('evals/fixtures/references/engine.json', 'utf8'));
const csv = parseCsv(readFileSync('evals/fixtures/datasets/engine_survey.csv', 'utf8'), 'engine_survey.csv');
const TYPES: Record<string, ColumnType> = { group: 'nominal', bin: 'binary' };
const survey: EngineDataset = {
  columns: csv.columns.map((name) => ({ name, type: TYPES[name] ?? (/^[TS]\d$/.test(name) ? 'ordinal' : 'numeric'), ...(/^[TS]\d$/.test(name) ? { scaleMin: 1, scaleMax: 5 } : {}) })),
  rows: csv.rows.map((row) => row.map((cell) => (typeof cell === 'boolean' ? String(cell) : cell))),
};

function run(spec: unknown, data: EngineDataset = survey): NormalisedResult {
  const outcome = execute(spec, data);
  if (outcome.status !== 'succeeded') throw new Error(`${JSON.stringify(spec)} → ${outcome.status}: ${JSON.stringify(outcome.status === 'failed' ? outcome.error : outcome.issues)}`);
  return outcome.result;
}
const est = (result: NormalisedResult, key: string): Estimate => {
  const found = result.estimates.find((e) => e.key === key);
  if (!found) throw new Error(`no estimate ${key} in ${result.analysisType}`);
  return found;
};

async function main() {
  /* ---------------------------------------------------------------- basics */
  section('Numerics and parsing');
  const eig = symmetricEigen([[4, 1, 2], [1, 3, 0.5], [2, 0.5, 5]]);
  close('eigenvalues sum to the trace', eig.values.reduce((a, b) => a + b, 0), 12, 1e-12);
  close('largest eigenvalue', eig.values[0], 6.831254430698207, 1e-10);
  ok('"3,5" is refused, never 35', toNumber('3,5') === null);
  ok('"1,234.5" is a thousands grouping', toNumber('1,234.5') === 1234.5);
  ok('"12,34" is refused', toNumber('12,34') === null);
  ok('canonical JSON sorts keys and keeps NaN as text', canonicalJson({ b: 1, a: Number.NaN }) === '{"a":"NaN","b":1}');
  ok('the engine names itself and its version', ENGINE.id === 'academic-ai-ts-core' && /^\d+\.\d+\.\d+$/.test(ENGINE.version));

  /* ---------------------------------------------------------- descriptives */
  section('Descriptives (R: base, G1/G2)');
  const desc = run({ analysisType: 'descriptives', variables: ['x', 'y', 'score'] });
  for (const r of ref.descriptives) {
    close(`${r.variable} n`, est(desc, `n:${r.variable}`).estimate, r.n, 0);
    close(`${r.variable} missing`, est(desc, `missing:${r.variable}`).estimate, r.missing, 0);
    for (const stat of ['mean', 'median', 'sd', 'variance', 'min', 'max', 'skewness', 'kurtosis']) close(`${r.variable} ${stat}`, est(desc, `${stat}:${r.variable}`).estimate, r[stat], 1e-10);
  }
  const tiny: EngineDataset = { columns: [{ name: 'v', type: 'numeric' }], rows: [[1], [2]] };
  const tinyResult = run({ analysisType: 'descriptives', variables: ['v'] }, tiny);
  ok('skewness with n < 3 is not computed (never reported as 0)', !tinyResult.estimates.some((e) => e.stat === 'skewness'));
  ok('… and says so', tinyResult.issues.some((i) => i.code === 'moment-not-computed'));

  /* ----------------------------------------------------------- reliability */
  section("Reliability (R: Cronbach's α, corrected item-total)");
  const rel = run({ analysisType: 'reliability', construct: 'Trust', items: ['T1', 'T2', 'T3', 'T4'] });
  close('α', est(rel, 'alpha:Trust').estimate, ref.reliability.alpha, 1e-10);
  close('standardised α', est(rel, 'alpha_std:Trust').estimate, ref.reliability.standardised, 1e-10);
  close('n after listwise deletion', rel.sample.used, ref.reliability.n, 0);
  for (const item of ref.reliability.items) {
    close(`${item.item} corrected item-total r`, est(rel, `item_total:${item.item}`).estimate, item.itemTotal, 1e-10);
    close(`${item.item} α if deleted`, est(rel, `alpha_if_deleted:${item.item}`).estimate, item.alphaIfDeleted, 1e-10);
  }

  /* ----------------------------------------------------------- correlation */
  section('Correlation (R: cor.test)');
  const cor = run({ analysisType: 'correlation', variables: ['x', 'm', 'y'] });
  for (const r of ref.correlation) {
    const e = est(cor, `r:${r.a}~${r.b}`);
    close(`r(${r.a}, ${r.b})`, e.estimate, r.r, 1e-10);
    close(`p(${r.a}, ${r.b})`, e.p, r.p, 1e-6);
    close(`CI lower (${r.a}, ${r.b})`, e.ciLow, r.lower, 1e-8);
    close(`CI upper (${r.a}, ${r.b})`, e.ciHigh, r.upper, 1e-8);
    close(`pairwise n (${r.a}, ${r.b})`, e.n, r.n, 0);
  }
  const rho = run({ analysisType: 'correlation', variables: ['x', 'm', 'y'], method: 'spearman' });
  for (const r of ref.spearman) close(`ρ(${r.a}, ${r.b})`, est(rho, `r:${r.a}~${r.b}`).estimate, r.rho, 1e-10);

  /* ------------------------------------------------------------ regression */
  section('Regression (R: lm, cooks.distance, hatvalues, Koenker BP)');
  const reg = run({ analysisType: 'regression', outcome: 'y', predictors: ['x', 'm', 'bin'] });
  for (const c of ref.regression.coefficients) {
    const e = est(reg, `coef:${c.term === '(Intercept)' ? '(intercept)' : c.term}`);
    close(`${c.term} b`, e.estimate, c.b, 1e-9);
    close(`${c.term} SE`, e.se, c.se, 1e-9);
    close(`${c.term} t`, e.statistic, c.t, 1e-8);
    close(`${c.term} p`, e.p, c.p, 1e-6);
    close(`${c.term} CI lower`, e.ciLow, c.lower, 1e-8);
    close(`${c.term} CI upper`, e.ciHigh, c.upper, 1e-8);
  }
  close('R²', est(reg, 'model:r2').estimate, ref.regression.r2, 1e-10);
  close('adjusted R²', est(reg, 'model:adj_r2').estimate, ref.regression.adjR2, 1e-10);
  close('F', est(reg, 'model:F').estimate, ref.regression.F, 1e-8);
  close('F p', est(reg, 'model:F').p, ref.regression.Fp, 1e-6);
  close('residual SE', est(reg, 'model:rmse').estimate, ref.regression.sigma, 1e-10);
  close("largest Cook's distance", est(reg, 'diag:max_cooks').estimate, ref.regression.maxCooks, 1e-8);
  close('largest leverage', est(reg, 'diag:max_leverage').estimate, ref.regression.maxLeverage, 1e-8);
  close('Breusch–Pagan (Koenker)', est(reg, 'diag:breusch_pagan').estimate, ref.regression.bp, 1e-8);
  close('Breusch–Pagan p', est(reg, 'diag:breusch_pagan').p, ref.regression.bpP, 1e-6);
  close('Durbin–Watson', est(reg, 'diag:durbin_watson').estimate, ref.regression.dw, 1e-10);
  ok('Durbin–Watson is reported, not judged (row order carries no meaning in a survey)', reg.assumptions.find((a) => a.key === 'autocorrelation')?.status === 'info');
  close('listwise n', reg.sample.used, ref.regression.n, 0);

  /* ----------------------------------------------------------------- ANOVA */
  section('One-way ANOVA (R: aov, oneway.test, TukeyHSD, Games–Howell via ptukey)');
  const av = run({ analysisType: 'anova', outcome: 'score', group: 'group', postHoc: 'tukey' });
  close('F', est(av, 'anova:F').estimate, ref.anova.F, 1e-9);
  close('F p', est(av, 'anova:F').p, ref.anova.p, 1e-6);
  close('Welch F', est(av, 'anova:welch_F').estimate, ref.anova.welchF, 1e-8);
  close('Welch df2', est(av, 'anova:welch_F').df2, ref.anova.welchDf2, 1e-8);
  close('Welch p', est(av, 'anova:welch_F').p, ref.anova.welchP, 1e-6);
  close('η²', est(av, 'anova:eta2').estimate, ref.anova.eta2, 1e-10);
  close('ω²', est(av, 'anova:omega2').estimate, ref.anova.omega2, 1e-10);
  for (const t of ref.anova.tukey) {
    const [b, a] = t.pair.split('-');
    const e = est(av, `posthoc:${a}|${b}`);
    close(`Tukey ${t.pair} difference`, -e.estimate, t.diff, 1e-10);
    close(`Tukey ${t.pair} p`, e.p, t.p, 2e-4);
    close(`Tukey ${t.pair} CI`, -(e.ciHigh as number), t.lower, 1e-4);
  }
  const gh = run({ analysisType: 'anova', outcome: 'score', group: 'group', postHoc: 'games-howell' });
  for (const g of ref.anova.gamesHowell) {
    const e = est(gh, `posthoc:${g.a}|${g.b}`);
    close(`Games–Howell ${g.a}−${g.b} difference`, e.estimate, g.diff, 1e-10);
    close(`Games–Howell ${g.a}−${g.b} SE`, e.se, g.se, 1e-10);
    close(`Games–Howell ${g.a}−${g.b} df`, e.df, g.df, 1e-8);
    close(`Games–Howell ${g.a}−${g.b} p`, e.p, g.p, 2e-4);
    close(`Games–Howell ${g.a}−${g.b} CI lower`, e.ciLow, g.lower, 1e-4);
  }
  const auto = run({ analysisType: 'anova', outcome: 'score', group: 'group' });
  ok('auto post-hoc uses Games–Howell when Levene rejects equal variances', auto.parameters.postHocUsed === 'games-howell');

  /* ------------------------------------------------------------------- EFA */
  section('EFA (R: KMO/Bartlett formulas, PAF, stats::varimax / stats::promax)');
  const items = ref.efa.items as string[];
  const efaV = run({ analysisType: 'efa', items, extraction: 'paf', rotation: 'varimax', retention: 'fixed', nFactors: 2 });
  close('KMO', est(efaV, 'kmo:overall').estimate, ref.efa.kmo, 1e-10);
  items.forEach((item, i) => close(`MSA ${item}`, est(efaV, `msa:${item}`).estimate, ref.efa.msa[i], 1e-10));
  close('Bartlett χ²', est(efaV, 'bartlett').estimate, ref.efa.bartlett, 1e-8);
  close('Bartlett p', est(efaV, 'bartlett').p, ref.efa.bartlettP, 1e-6);
  (ref.efa.eigenvalues as number[]).forEach((value, i) => close(`eigenvalue ${i + 1}`, est(efaV, `eigen:${i + 1}`).estimate, value, 1e-10));
  items.forEach((item, i) => close(`communality ${item}`, est(efaV, `communality:${item}`).estimate, ref.efa.communalities[i], 1e-5));
  items.forEach((item, i) => [0, 1].forEach((j) => close(`PAF+varimax ${item} F${j + 1}`, est(efaV, `loading:${item}|F${j + 1}`).estimate, ref.efa.pafVarimax[i][j], 1e-5)));
  const efaP = run({ analysisType: 'efa', items, extraction: 'paf', rotation: 'promax', retention: 'fixed', nFactors: 2 });
  items.forEach((item, i) => [0, 1].forEach((j) => close(`PAF+promax ${item} F${j + 1}`, est(efaP, `loading:${item}|F${j + 1}`).estimate, ref.efa.pafPromax[i][j], 1e-5)));
  close('promax factor correlation', est(efaP, 'factor_r:F1|F2').estimate, ref.efa.promaxPhi[0][1], 1e-5);
  const efaC = run({ analysisType: 'efa', items, extraction: 'pca', rotation: 'varimax', retention: 'fixed', nFactors: 2 });
  items.forEach((item, i) => [0, 1].forEach((j) => close(`PCA+varimax ${item} F${j + 1}`, est(efaC, `loading:${item}|F${j + 1}`).estimate, ref.efa.pcaVarimax[i][j], 1e-8)));
  const kaiser = run({ analysisType: 'efa', items });
  ok('Kaiser retention agrees with the eigenvalues', kaiser.parameters.nFactors === (ref.efa.eigenvalues as number[]).filter((v) => v > 1).length);
  const vmIdentity = varimax([[0.7], [0.6]]);
  ok('varimax leaves a single factor unchanged', vmIdentity.loadings[0]![0] === 0.7);
  ok('promax of one factor has Φ = [1]', promax([[0.7], [0.6]]).phi[0]![0] === 1);

  /* ------------------------------------------------------------- mediation */
  section('Mediation (R: lm paths; seeded bootstrap)');
  const medSpec = { analysisType: 'mediation', x: 'x', m: 'm', y: 'y', bootstrap: { resamples: 2000, seed: 20260924 } };
  const med = run(medSpec);
  for (const [key, r] of [['path:a', ref.mediation.a], ['path:b', ref.mediation.b], ['effect:direct', ref.mediation.direct], ['effect:total', ref.mediation.total]] as const) {
    const e = est(med, key);
    close(`${key} b`, e.estimate, r.b, 1e-9);
    close(`${key} SE`, e.se, r.se, 1e-9);
    close(`${key} p`, e.p, r.p, 1e-6);
    close(`${key} CI`, e.ciLow, r.lower, 1e-8);
  }
  close('indirect a·b', est(med, 'effect:indirect').estimate, ref.mediation.indirect, 1e-10);
  close('total = direct + indirect (OLS identity)', est(med, 'effect:total').estimate, est(med, 'effect:direct').estimate + est(med, 'effect:indirect').estimate, 1e-9);
  close('completely standardised indirect', est(med, 'effect:indirect_std').estimate, (ref.mediation.indirect * ref.mediation.sdX) / ref.mediation.sdY, 1e-9);
  const indirect = est(med, 'effect:indirect');
  ok('bootstrap interval brackets the point estimate', (indirect.ciLow as number) < indirect.estimate && indirect.estimate < (indirect.ciHigh as number));
  ok('the seed is recorded on the result', med.seed === 20260924);
  const again = run(medSpec);
  ok('same seed, same data → byte-identical result', canonicalJson(again) === canonicalJson(med));
  const other = run({ ...medSpec, bootstrap: { resamples: 2000, seed: 7 } });
  ok('a different seed gives a different interval (the seed is really used)', est(other, 'effect:indirect').ciLow !== indirect.ciLow);
  ok('a different seed does not change the point estimate', est(other, 'effect:indirect').estimate === indirect.estimate);
  ok('mediation without a seed is refused by the schema', !methodSpecSchema.safeParse({ analysisType: 'mediation', x: 'x', m: 'm', y: 'y', bootstrap: { resamples: 2000 } }).success);
  ok('mediation and PLS-with-bootstrap are declared randomised', isRandomised({ analysisType: 'mediation', x: 'x', m: 'm', y: 'y', bootstrap: { seed: 1 } } as never) && isRandomised({ analysisType: 'pls', constructs: [], paths: [], bootstrap: { seed: 1 } } as never));

  /* ------------------------------------------------------------ moderation */
  section('Moderation (R: lm with centred product, vcov conditional effects)');
  const mod = run({ analysisType: 'moderation', x: 'x', w: 'w', y: 'y', centering: 'mean' });
  const names = ['coef:(intercept)', 'coef:x', 'coef:w', 'coef:interaction'];
  (ref.moderation.coefficients as { b: number; se: number; p: number }[]).forEach((c, i) => {
    close(`${names[i]} b`, est(mod, names[i]!).estimate, c.b, 1e-9);
    close(`${names[i]} SE`, est(mod, names[i]!).se, c.se, 1e-9);
    close(`${names[i]} p`, est(mod, names[i]!).p, c.p, 1e-6);
  });
  close('R²', est(mod, 'model:r2').estimate, ref.moderation.r2, 1e-10);
  close('ΔR² of the interaction', est(mod, 'model:delta_r2').estimate, ref.moderation.deltaR2, 1e-10);
  close('F change', est(mod, 'model:delta_r2').statistic, ref.moderation.Fchange, 1e-8);
  (ref.moderation.conditional as { effect: number; se: number; p: number; lower: number; upper: number }[]).forEach((c, i) => {
    const e = est(mod, `conditional:${i + 1}`);
    close(`conditional effect ${i + 1}`, e.estimate, c.effect, 1e-9);
    close(`conditional SE ${i + 1}`, e.se, c.se, 1e-9);
    close(`conditional p ${i + 1}`, e.p, c.p, 1e-6);
    close(`conditional CI ${i + 1}`, e.ciLow, c.lower, 1e-8);
  });
  const raw = run({ analysisType: 'moderation', x: 'x', w: 'w', y: 'y', centering: 'none' });
  close('centring never changes the interaction coefficient', est(raw, 'coef:interaction').estimate, est(mod, 'coef:interaction').estimate, 1e-9);
  close('… nor the conditional effects', est(raw, 'conditional:2').estimate, est(mod, 'conditional:2').estimate, 1e-8);

  /* ------------------------------------------------------ CFA and validity */
  section('CFA standardisation (lavaan std.all) and HTMT (semTools)');
  const hsRef = JSON.parse(readFileSync('evals/fixtures/references/cfa-hs1939.json', 'utf8'));
  const hsCsv = parseCsv(readFileSync('evals/fixtures/datasets/holzinger_swineford_1939.csv', 'utf8'), 'hs');
  const hs = new Map(hsCsv.columns.map((name, i) => [name, hsCsv.rows.map((row) => toNumber(row[i]) ?? Number.NaN)]));
  const hsModel = { constructs: [{ name: 'visual', indicators: ['x1', 'x2', 'x3'], mode: 'reflective' as const }, { name: 'textual', indicators: ['x4', 'x5', 'x6'], mode: 'reflective' as const }, { name: 'speed', indicators: ['x7', 'x8', 'x9'], mode: 'reflective' as const }], paths: [] };
  const hsFit = confirmatoryFactorAnalysis(hsModel as never, hs);
  for (const l of hsRef.loadings) {
    const mine = hsFit.loadings.find((entry) => entry.construct === l.lhs && entry.indicator === l.rhs);
    close(`std.all ${l.lhs} =~ ${l.rhs}`, mine?.standardised, l['std.all'], 1e-4);
  }
  close('HTMT visual–textual', htmt(['x1', 'x2', 'x3'], ['x4', 'x5', 'x6'], hs), ref.htmt.visualTextual, 1e-10);
  close('HTMT visual–speed', htmt(['x1', 'x2', 'x3'], ['x7', 'x8', 'x9'], hs), ref.htmt.visualSpeed, 1e-10);
  close('HTMT textual–speed', htmt(['x4', 'x5', 'x6'], ['x7', 'x8', 'x9'], hs), ref.htmt.textualSpeed, 1e-10);
  const hsData: EngineDataset = { columns: hsCsv.columns.map((name) => ({ name, type: 'numeric' as const })), rows: hsCsv.rows as EngineDataset['rows'] };
  const cfaRun = run({ analysisType: 'cfa', constructs: hsModel.constructs.map(({ name, indicators }) => ({ name, indicators })) }, hsData);
  close('engine CFA χ² equals lavaan', est(cfaRun, 'fit:chi2').estimate, hsRef.fit.chisq, 1e-5);
  close('engine CFA CFI equals lavaan', est(cfaRun, 'fit:cfi').estimate, hsRef.fit.cfi, 1e-5);
  ok('CFA reports HTMT and AVE for every construct', cfaRun.estimates.filter((e) => e.stat === 'htmt').length === 3 && cfaRun.estimates.filter((e) => e.stat === 'ave').length === 3);

  /* --------------------------------------------------------------- PLS */
  section('PLS through the engine');
  const plsSpec = { analysisType: 'pls', constructs: [{ name: 'T', indicators: ['T1', 'T2', 'T3', 'T4'] }, { name: 'S', indicators: ['S1', 'S2', 'S3', 'S4'] }], paths: [{ from: 'T', to: 'S' }], bootstrap: { resamples: 300, seed: 99 } };
  const plsRun = run(plsSpec);
  const plsAgain = run(plsSpec);
  ok('PLS with a seeded bootstrap is reproducible', canonicalJson(plsRun) === canonicalJson(plsAgain));
  ok('PLS α comes from observed indicator correlations (equals the standardised α of the items)', Math.abs(est(plsRun, 'alpha:T').estimate - run({ analysisType: 'reliability', construct: 'T', items: ['T1', 'T2', 'T3', 'T4'] }).estimates.find((e) => e.key === 'alpha_std:T')!.estimate) < 1e-10);
  ok('Q² is not reported as a verified result', !plsRun.estimates.some((e) => e.key.startsWith('q2')) && plsRun.issues.some((i) => i.code === 'q2-not-verified'));
  const isolated = execute({ analysisType: 'pls', constructs: [...plsSpec.constructs, { name: 'U', indicators: ['x', 'w'] }], paths: [{ from: 'T', to: 'S' }] }, survey);
  ok('an isolated PLS construct fails the run, with no numbers', isolated.status === 'failed' && isolated.error.code === 'analysis.pls.error.isolatedConstruct');

  /* ------------------------------------------------------------ guardrails */
  section('Validation and guardrails');
  const quality = validateDataset(survey);
  ok('missing values are reported per column', quality.some((i) => i.code === 'missing-values' && i.columns[0] === 'x'));
  const bad: EngineDataset = {
    columns: [{ name: 'a', type: 'numeric' }, { name: 'c', type: 'numeric' }, { name: 'g', type: 'nominal' }, { name: 'r', type: 'ordinal', scaleMin: 1, scaleMax: 5, missingCodes: [99] }],
    rows: Array.from({ length: 40 }, (_, i) => [i % 7 === 0 ? '' : i % 11 === 0 ? '3,5' : String(i), '5', i % 2 ? 'A' : 'B', i === 3 ? 99 : i === 4 ? 9 : (i % 5) + 1]),
  };
  const badIssues = validateDataset(bad);
  ok('blank cells are missing, never zero', badIssues.some((i) => i.code === 'missing-values' && i.columns[0] === 'a'));
  ok('an ambiguous decimal comma is reported as invalid', badIssues.some((i) => i.code === 'invalid-numeric' && i.columns[0] === 'a'));
  ok('a constant column is reported', badIssues.some((i) => i.code === 'constant' && i.columns[0] === 'c'));
  ok('a value outside the declared scale is reported', badIssues.some((i) => i.code === 'out-of-range' && i.columns[0] === 'r'));
  ok('a declared missing code is counted as missing', badIssues.some((i) => i.code === 'missing-values' && i.columns[0] === 'r' && i.details?.coded === 1));
  const constant = execute({ analysisType: 'regression', outcome: 'a', predictors: ['c'] }, bad);
  ok('a constant predictor BLOCKS the regression before any number is computed', constant.status === 'refused' && constant.issues.some((i) => i.code === 'constant' && i.severity === 'BLOCKING'));
  const categoricalPearson = execute({ analysisType: 'correlation', variables: ['a', 'g'] }, bad);
  ok('Pearson on a nominal variable is an ERROR', categoricalPearson.status === 'refused' && categoricalPearson.issues.some((i) => i.code === 'incompatible-type'));
  const ordinalPearson = validateSpec({ analysisType: 'correlation', variables: ['T1', 'T2'], method: 'pearson', missing: 'pairwise', adjust: 'none', confidenceLevel: 0.95 }, survey);
  ok('Pearson on ordinal items is a WARNING that names Spearman', ordinalPearson.some((i) => i.code === 'pearson-on-ordinal' && i.severity === 'WARNING'));
  const unknown = execute({ analysisType: 'descriptives', variables: ['nope'] }, survey);
  ok('an unknown column is an ERROR', unknown.status === 'refused' && unknown.issues[0]?.code === 'unknown-column');
  const small = execute({ analysisType: 'efa', items: ['a', 'c', 'r'] }, bad);
  ok('EFA on 40 cases is BLOCKED for insufficient sample', small.status === 'refused' && small.issues.some((i) => i.code === 'insufficient-sample'));
  const underIdentified = execute({ analysisType: 'cfa', constructs: [{ name: 'A', indicators: ['T1', 'T2'] }] }, survey);
  ok('a two-indicator CFA factor fails clearly (not identified), no partial numbers', underIdentified.status === 'refused' && underIdentified.issues.some((i) => i.code === 'under-identified'));
  const collinear: EngineDataset = { columns: [{ name: 'y', type: 'numeric' }, { name: 'a', type: 'numeric' }, { name: 'b', type: 'numeric' }], rows: Array.from({ length: 60 }, (_, i) => [String(i * 0.5 + (i % 3)), String(i), String(i * 2 + (i % 2) * 0.01)]) };
  const collinearRun = run({ analysisType: 'regression', outcome: 'y', predictors: ['a', 'b'] }, collinear);
  ok('severe multicollinearity is reported with the VIF', collinearRun.issues.some((i) => i.code === 'severe-multicollinearity') && collinearRun.estimates.some((e) => e.stat === 'vif' && e.estimate > 10));
  const invalidSpec = execute({ analysisType: 'regression', outcome: 'y' }, survey);
  ok('a malformed specification is refused with structured issues', invalidSpec.status === 'refused' && invalidSpec.issues.every((i) => i.severity === 'ERROR'));
  ok('every issue carries English and Arabic text', [...quality, ...badIssues].every((i) => i.message.length > 0 && i.messageAr.length > 0));

  /* ------------------------------------------------------ tables, figures */
  section('Tables and figures come only from estimates');
  for (const result of [desc, rel, cor, reg, av, efaP, cfaRun, plsRun, med, mod]) {
    const tables = tablesFor(result);
    const keys = new Set(result.estimates.map((e) => e.key));
    ok(`${result.analysisType}: at least one table`, tables.length > 0);
    ok(`${result.analysisType}: every numeric cell names an estimate of this run`, tables.every((t) => t.rows.flat().every((cell) => !cell.key || keys.has(cell.key))));
    ok(`${result.analysisType}: no digits in a cell that names no estimate (except labels)`, tables.every((t) => t.rows.every((row) => row.slice(1).every((cell) => cell.key || cell.text === '—'))));
  }
  const regTable = tablesFor(reg)[0]!;
  const xRow = regTable.rows.find((row) => row[0]?.text === 'x')!;
  ok('a table cell shows the stored estimate, formatted', xRow[1]?.text === est(reg, 'coef:x').estimate.toFixed(2));
  ok('p is formatted APA-style', formatP(0.0004) === '< .001' && formatP(0.0234) === '.023');
  const medFigure = figuresFor(med)[0]!;
  ok('the mediation diagram draws only this run’s estimates', medFigure.kind === 'path-diagram' && medFigure.keys.every((key) => med.estimates.some((e) => e.key === key)));
  ok('figures are deterministic', figuresFor(med)[0]!.svg === medFigure.svg);
  ok('EFA gets a scree plot from the eigenvalues', figuresFor(efaP).some((f) => f.kind === 'scree' && f.keys.every((k) => k.startsWith('eigen:'))));
  ok('moderation gets a simple-slopes figure', figuresFor(mod).some((f) => f.kind === 'simple-slopes'));

  /* --------------------------------------------- results-section guardrail */
  section('Legacy results sections: numbers must match an attached verified analysis');
  const verified = numberSpellings(reg.estimates.flatMap((e) => [e.estimate, e.p ?? Number.NaN, e.se ?? Number.NaN]));
  const b = est(reg, 'coef:x');
  const traced = `x predicted y (b = ${b.estimate.toFixed(3)}, SE = ${(b.se as number).toFixed(3)}).`;
  ok('a number taken from the attached run is traced', !inspectOutput(traced, { verifiedNumbers: verified }).flags.includes('UNTRACED_STATISTIC'));
  ok('an invented number is flagged, with a notice', inspectOutput('x predicted y (b = 0.777, p = .013).', { verifiedNumbers: verified }).flags.includes('UNTRACED_STATISTIC'));
  ok('with nothing attached, every statistic is untraced', inspectOutput('r = .45', { verifiedNumbers: new Set() }).flags.includes('UNTRACED_STATISTIC'));
  ok('counts and years are not statistics', !inspectOutput('Two groups, 240 students, in 2024.', { verifiedNumbers: new Set() }).flags.includes('UNTRACED_STATISTIC'));

  /* ---------------------------------------------------------- determinism */
  section('Determinism and normalisation');
  ok('every result carries engine, method, sample, parameters', [desc, rel, cor, reg, av, efaP, cfaRun, plsRun, med, mod].every((r) => r.engine.id === ENGINE.id && r.method && r.sample.used > 0 && r.parameters));
  ok('estimate keys are unique within a run', [desc, rel, cor, reg, av, efaP, cfaRun, plsRun, med, mod].every((r) => new Set(r.estimates.map((e) => e.key)).size === r.estimates.length));
  ok('no estimate is NaN or infinite', [desc, rel, cor, reg, av, efaP, cfaRun, plsRun, med, mod].every((r) => r.estimates.every((e) => Number.isFinite(e.estimate))));
  ok('EFA is deterministic (same bytes twice)', canonicalJson(run({ analysisType: 'efa', items })) === canonicalJson(run({ analysisType: 'efa', items })));
  const shuffled: EngineDataset = { columns: survey.columns, rows: [...survey.rows].reverse() };
  close('row order does not change a regression coefficient', est(run({ analysisType: 'regression', outcome: 'y', predictors: ['x', 'm', 'bin'] }, shuffled), 'coef:x').estimate, est(reg, 'coef:x').estimate, 1e-10);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
