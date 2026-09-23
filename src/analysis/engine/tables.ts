/**
 * Statistical tables, generated only from a run's stored estimates.
 *
 * Every numeric cell names the estimate it came from (`key` + `field`), so a
 * table can be re-rendered, audited and linked in the Research Graph
 * (`result_table —contains_value→ result_value`). Nothing here computes a
 * statistic; it only formats one (APA style: no leading zero for bounded
 * statistics, p < .001).
 */

import type { Estimate, NormalisedResult } from './types';

export interface TableCell {
  text: string;
  /** The estimate this cell shows, and which field of it. Absent for labels. */
  key?: string;
  field?: 'estimate' | 'se' | 'statistic' | 'p' | 'ci' | 'n' | 'df';
}

export interface StatTable {
  kind: string;
  title: string;
  columns: string[];
  rows: TableCell[][];
  note: string;
  /** Every estimate key the table shows. */
  keys: string[];
}

const BOUNDED = new Set(['r', 'rho', 'alpha', 'alpha_standardised', 'item_total_r', 'alpha_if_deleted', 'r2', 'adj_r2', 'eta2', 'omega2', 'beta', 'std_loading', 'factor_r', 'cr', 'ave', 'kmo', 'msa', 'communality', 'cfi', 'tli', 'rmsea', 'srmr', 'loading', 'pattern_loading', 'path', 'htmt', 'delta_r2', 'proportion_variance']);

export function formatNumber(value: number | null | undefined, stat = '', decimals = BOUNDED.has(stat) ? 3 : 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const text = value.toFixed(decimals);
  return BOUNDED.has(stat) && Math.abs(value) < 1 ? text.replace(/^(-?)0\./, '$1.') : text;
}

export function formatP(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  if (p < 0.001) return '< .001';
  return p.toFixed(3).replace(/^0\./, '.');
}

function cells(estimate: Estimate | undefined, fields: TableCell['field'][]): TableCell[] {
  return fields.map((field) => {
    if (!estimate) return { text: '—' };
    const key = estimate.key;
    switch (field) {
      case 'estimate':
        return { text: formatNumber(estimate.estimate, estimate.stat), key, field };
      case 'se':
        return { text: formatNumber(estimate.se), key, field };
      case 'statistic':
        return { text: formatNumber(estimate.statistic), key, field };
      case 'p':
        return { text: formatP(estimate.p), key, field };
      case 'n':
        return { text: estimate.n === null || estimate.n === undefined ? '—' : String(estimate.n), key, field };
      case 'df':
        return { text: estimate.df === null || estimate.df === undefined ? '—' : String(Number(estimate.df.toFixed(2))), key, field };
      case 'ci':
        return {
          text: estimate.ciLow === null || estimate.ciLow === undefined ? '—' : `[${formatNumber(estimate.ciLow, estimate.stat)}, ${formatNumber(estimate.ciHigh, estimate.stat)}]`,
          key,
          field,
        };
      default:
        return { text: '—' };
    }
  });
}

const label = (text: string): TableCell => ({ text });

function build(kind: string, title: string, columns: string[], rows: TableCell[][], note: string): StatTable {
  const keys = [...new Set(rows.flat().map((cell) => cell.key).filter((key): key is string => Boolean(key)))];
  return { kind, title, columns, rows, note, keys };
}

/** The tables a result supports, most important first. */
export function tablesFor(result: NormalisedResult): StatTable[] {
  const by = new Map(result.estimates.map((estimate) => [estimate.key, estimate]));
  const family = (name: string) => result.estimates.filter((estimate) => estimate.family === name);
  const n = result.sample.used;
  const tables: StatTable[] = [];
  const ciPct = (e?: Estimate | null) => `${Math.round((e?.ciLevel ?? 0.95) * 100)}% CI`;

  switch (result.analysisType) {
    case 'descriptives': {
      const variables = [...new Set(family('descriptive').map((e) => e.term as string))];
      const stats = ['n', 'mean', 'sd', 'median', 'min', 'max', 'skewness', 'kurtosis'];
      tables.push(build('descriptives', 'Descriptive statistics', ['Variable', 'N', 'M', 'SD', 'Mdn', 'Min', 'Max', 'Skewness', 'Kurtosis'], variables.map((v) => [label(v), ...stats.flatMap((s) => cells(by.get(`${s}:${v}`), ['estimate']))]), 'Skewness and kurtosis are the adjusted G1 and G2 (excess) coefficients; SD uses n − 1.'));
      break;
    }
    case 'reliability': {
      const alpha = family('reliability').find((e) => e.stat === 'alpha');
      const items = [...new Set(family('item').map((e) => e.term as string))];
      tables.push(build('reliability', `Item statistics${alpha ? ` (${alpha.term})` : ''}`, ['Item', 'Corrected item–total r', 'α if item deleted'], items.map((i) => [label(i), ...cells(by.get(`item_total:${i}`), ['estimate']), ...cells(by.get(`alpha_if_deleted:${i}`), ['estimate'])]), `Cronbach's α = ${formatNumber(alpha?.estimate, 'alpha')}${alpha?.ciLow != null ? `, ${ciPct(alpha)} [${formatNumber(alpha.ciLow, 'alpha')}, ${formatNumber(alpha.ciHigh, 'alpha')}] (Feldt)` : ''}; N = ${n}.`));
      break;
    }
    case 'correlation':
      tables.push(build('correlation', 'Correlations', ['Pair', 'r', ciPct(family('correlation')[0]), 'p', 'n'], family('correlation').map((e) => [label((e.term ?? '').replace('~', ' – ')), ...cells(e, ['estimate', 'ci', 'p', 'n'])]), `${result.method}; ${String(result.parameters.missing)} deletion; p adjustment: ${String(result.parameters.pAdjust)}.`));
      break;
    case 'regression': {
      const coefficients = family('coefficient').filter((e) => e.stat === 'b');
      const r2 = by.get('model:r2');
      const f = by.get('model:F');
      tables.push(build('regression', 'Regression coefficients', ['Predictor', 'b', 'SE', 'β', 't', 'p', ciPct(coefficients[0])], coefficients.map((e) => [label(e.term as string), ...cells(e, ['estimate', 'se']), ...cells(by.get(`beta:${e.term}`), ['estimate']), ...cells(e, ['statistic', 'p', 'ci'])]), `R² = ${formatNumber(r2?.estimate, 'r2')}, adjusted R² = ${formatNumber(by.get('model:adj_r2')?.estimate, 'adj_r2')}, F(${f?.df}, ${f?.df2}) = ${formatNumber(f?.estimate)}, p ${formatP(f?.p).startsWith('<') ? formatP(f?.p) : `= ${formatP(f?.p)}`}; N = ${n}.`));
      break;
    }
    case 'anova': {
      const groups = [...new Set(family('group').map((e) => e.term as string))];
      const f = by.get('anova:F');
      const welch = by.get('anova:welch_F');
      tables.push(build('anova-groups', 'Group statistics', ['Group', 'n', 'M', 'SD'], groups.map((g) => [label(g), ...cells(by.get(`mean:${g}`), ['n', 'estimate']), ...cells(by.get(`sd:${g}`), ['estimate'])]), `F(${f?.df}, ${f?.df2}) = ${formatNumber(f?.estimate)}, p ${formatP(f?.p)}${welch ? `; Welch F(${formatNumber(welch.df)}, ${formatNumber(welch.df2)}) = ${formatNumber(welch.estimate)}, p ${formatP(welch.p)}` : ''}; η² = ${formatNumber(by.get('anova:eta2')?.estimate, 'eta2')}, ω² = ${formatNumber(by.get('anova:omega2')?.estimate, 'omega2')}.`));
      const posthoc = family('posthoc');
      if (posthoc.length) tables.push(build('anova-posthoc', `Post-hoc comparisons (${String(result.parameters.postHocUsed)})`, ['Comparison', 'Mean difference', 'SE', 'p', ciPct(posthoc[0])], posthoc.map((e) => [label((e.term ?? '').replace('|', ' − ')), ...cells(e, ['estimate', 'se', 'p', 'ci'])]), 'p-values and intervals adjusted for all pairwise comparisons.'));
      break;
    }
    case 'efa': {
      const factors = (result.payload.factors as string[]) ?? [];
      const items = [...new Set(family('communality').map((e) => e.term as string))];
      tables.push(build('efa-loadings', `Factor loadings (${result.method})`, ['Item', ...factors, 'h²'], items.map((i) => [label(i), ...factors.flatMap((f) => cells(by.get(`loading:${i}|${f}`), ['estimate'])), ...cells(by.get(`communality:${i}`), ['estimate'])]), `KMO = ${formatNumber(by.get('kmo:overall')?.estimate, 'kmo')}; Bartlett χ²(${by.get('bartlett')?.df}) = ${formatNumber(by.get('bartlett')?.estimate)}, p ${formatP(by.get('bartlett')?.p)}; N = ${n}.`));
      tables.push(build('efa-variance', 'Variance explained', ['Factor', 'SS loadings', 'Proportion'], factors.map((f) => [label(f), ...cells(by.get(`ss:${f}`), ['estimate']), ...cells(by.get(`prop_var:${f}`), ['estimate'])]), ''));
      break;
    }
    case 'cfa': {
      const loadings = family('loading').filter((e) => e.stat === 'loading');
      tables.push(build('cfa-loadings', 'Factor loadings (CFA)', ['Factor → indicator', 'Estimate', 'SE', 'z', 'p', 'Standardised'], loadings.map((e) => [label((e.term ?? '').replace('=~', ' → ')), ...cells(e, ['estimate', 'se', 'statistic', 'p']), ...cells(by.get(`std_${e.key}`), ['estimate'])]), `χ²(${by.get('fit:chi2')?.df}) = ${formatNumber(by.get('fit:chi2')?.estimate)}, p ${formatP(by.get('fit:chi2')?.p)}; CFI = ${formatNumber(by.get('fit:cfi')?.estimate, 'cfi')}, TLI = ${formatNumber(by.get('fit:tli')?.estimate, 'tli')}, RMSEA = ${formatNumber(by.get('fit:rmsea')?.estimate, 'rmsea')}, SRMR = ${formatNumber(by.get('fit:srmr')?.estimate, 'srmr')}; N = ${n}.`));
      const constructs = [...new Set(result.estimates.filter((e) => e.stat === 'ave').map((e) => e.term as string))];
      tables.push(build('validity', 'Convergent validity', ['Construct', 'CR', 'AVE'], constructs.map((c) => [label(c), ...cells(by.get(`cr:${c}`), ['estimate']), ...cells(by.get(`ave:${c}`), ['estimate'])]), 'CR ≥ .70 and AVE ≥ .50 are the usual criteria.'));
      break;
    }
    case 'pls': {
      const paths = family('path');
      tables.push(build('pls-paths', 'Structural paths (PLS-SEM)', ['Path', 'β', 'SE', 't', 'p', ciPct(paths[0])], paths.map((e) => [label(e.term as string), ...cells(e, ['estimate', 'se', 'statistic', 'p', 'ci'])]), result.seed === null ? 'No bootstrap: no standard errors or p-values.' : `Bootstrap: ${String((result.parameters.bootstrap as { resamples?: number } | null)?.resamples)} resamples, seed ${result.seed}, percentile intervals.`));
      const constructs = [...new Set(result.estimates.filter((e) => e.stat === 'ave').map((e) => e.term as string))];
      tables.push(build('validity', 'Measurement model', ['Construct', 'α', 'ρc', 'AVE'], constructs.map((c) => [label(c), ...cells(by.get(`alpha:${c}`), ['estimate']), ...cells(by.get(`cr:${c}`), ['estimate']), ...cells(by.get(`ave:${c}`), ['estimate'])]), ''));
      break;
    }
    case 'mediation': {
      const rows = ['path:a', 'path:b', 'effect:direct', 'effect:total', 'effect:indirect'].map((key) => by.get(key)).filter((e): e is Estimate => Boolean(e));
      tables.push(build('mediation', 'Mediation effects', ['Effect', 'Estimate', 'SE', ciPct(by.get('effect:indirect')), 'p'], rows.map((e) => [label(e.label), ...cells(e, ['estimate', 'se', 'ci', 'p'])]), `Indirect effect interval: percentile bootstrap, ${String(result.parameters.resamples)} resamples, seed ${result.seed}. N = ${n}.`));
      break;
    }
    case 'moderation': {
      const coefficients = result.estimates.filter((e) => e.key.startsWith('coef:') || e.key.startsWith('covariate:'));
      tables.push(build('moderation', 'Moderation model', ['Term', 'b', 'SE', 't', 'p', ciPct(coefficients[0])], coefficients.map((e) => [label(e.label), ...cells(e, ['estimate', 'se', 'statistic', 'p', 'ci'])]), `R² = ${formatNumber(by.get('model:r2')?.estimate, 'r2')}; ΔR² (interaction) = ${formatNumber(by.get('model:delta_r2')?.estimate, 'delta_r2')}, F(1, ${by.get('model:delta_r2')?.df2}) = ${formatNumber(by.get('model:delta_r2')?.statistic)}, p ${formatP(by.get('model:delta_r2')?.p)}. Centring: ${String(result.parameters.centering)}.`));
      tables.push(build('conditional', 'Conditional effects', ['Moderator value', 'Effect', 'SE', 't', 'p', ciPct(family('conditional')[0])], family('conditional').map((e) => [label(e.term as string), ...cells(e, ['estimate', 'se', 'statistic', 'p', 'ci'])]), ''));
      break;
    }
  }
  return tables;
}
