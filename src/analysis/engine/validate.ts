/**
 * Pre-analysis validation.
 *
 * `validateDataset` is the data-quality report for a dataset version.
 * `validateSpec` decides whether a specification can run on that version: an
 * ERROR (the specification is wrong) or BLOCKING (the data cannot support it)
 * stops the run before any number is computed. Nothing here changes the data:
 * fixing it is a recorded transformation that creates a new version.
 */

import { pearson, standardDeviation } from '../stats-core';

import { categorical, column, completeRows, numeric, pick } from './data';
import { columnsOf, type MethodSpec } from './spec';
import type { ColumnSchema, EngineDataset, Issue, Severity } from './types';

const issue = (code: string, severity: Severity, columns: string[], message: string, messageAr: string, details?: Issue['details']): Issue => ({
  code,
  severity,
  columns,
  message,
  messageAr,
  ...(details ? { details } : {}),
});

const QUANTITATIVE = new Set(['numeric', 'ordinal', 'binary']);

/* -------------------------------------------------------------------------- */
/*                               Dataset quality                              */
/* -------------------------------------------------------------------------- */

export function validateDataset(dataset: EngineDataset): Issue[] {
  const issues: Issue[] = [];
  const n = dataset.rows.length;
  if (n === 0) return [issue('empty-dataset', 'BLOCKING', [], 'The dataset has no rows.', 'لا تحتوي مجموعة البيانات على صفوف.')];
  if (n < 30) {
    issues.push(issue('small-sample', 'WARNING', [], `Only ${n} rows: most inferential analyses need more.`, `عدد الصفوف ${n} فقط: معظم التحليلات الاستدلالية تحتاج إلى أكثر.`, { n }));
  }

  const seen = new Map<string, number>();
  let duplicates = 0;
  for (const row of dataset.rows) {
    const key = JSON.stringify(row);
    const count = seen.get(key) ?? 0;
    if (count > 0) duplicates += 1;
    seen.set(key, count + 1);
  }
  if (duplicates > 0) {
    issues.push(issue('duplicate-rows', 'WARNING', [], `${duplicates} rows duplicate an earlier row exactly.`, `${duplicates} صفًا مكرّرًا تمامًا.`, { duplicates }));
  }

  for (const schema of dataset.columns) issues.push(...columnIssues(dataset, schema, n));
  return issues;
}

function columnIssues(dataset: EngineDataset, schema: ColumnSchema, n: number): Issue[] {
  const out: Issue[] = [];
  const name = schema.name;
  if (QUANTITATIVE.has(schema.type)) {
    const col = numeric(dataset, name);
    const absent = col.missing + col.coded;
    if (absent > 0) {
      const percent = (absent / n) * 100;
      out.push(
        issue(
          'missing-values',
          percent > 20 ? 'WARNING' : 'INFO',
          [name],
          `${absent} of ${n} values missing (${percent.toFixed(1)}%${col.coded ? `, ${col.coded} by missing code` : ''}). They are excluded, never replaced by 0.`,
          `${absent} من ${n} قيمة مفقودة (${percent.toFixed(1)}%). تُستبعد ولا تُستبدل بصفر.`,
          { missing: col.missing, coded: col.coded, percent: Number(percent.toFixed(2)) },
        ),
      );
    }
    if (col.invalid > 0) {
      out.push(
        issue(
          'invalid-numeric',
          'WARNING',
          [name],
          `${col.invalid} values are not numbers (for example text, or an ambiguous decimal comma) and are excluded.`,
          `${col.invalid} قيمة ليست أرقامًا وتُستبعد.`,
          { invalid: col.invalid },
        ),
      );
    }
    const finite = col.values.filter(Number.isFinite);
    if (finite.length >= 2) {
      const distinct = new Map<number, number>();
      for (const value of finite) distinct.set(value, (distinct.get(value) ?? 0) + 1);
      if (distinct.size === 1) {
        out.push(issue('constant', 'WARNING', [name], 'Every value is the same: the column has no variance.', 'جميع القيم متطابقة: لا يوجد تباين.'));
      } else {
        const counts = [...distinct.values()].sort((a, b) => b - a);
        const ratio = (counts[0] as number) / (counts[1] as number);
        const unique = (distinct.size / finite.length) * 100;
        if (ratio > 19 && unique < 10) {
          out.push(
            issue('near-zero-variance', 'WARNING', [name], `Almost every value is the same (most common value ${ratio.toFixed(1)}× the next).`, 'القيم متطابقة تقريبًا (تباين شبه معدوم).', {
              frequencyRatio: Number(ratio.toFixed(2)),
              percentUnique: Number(unique.toFixed(2)),
            }),
          );
        }
      }
      if (schema.scaleMin != null || schema.scaleMax != null) {
        const outside = finite.filter((value) => (schema.scaleMin != null && value < schema.scaleMin) || (schema.scaleMax != null && value > schema.scaleMax)).length;
        if (outside > 0) {
          out.push(
            issue('out-of-range', 'WARNING', [name], `${outside} values fall outside the declared range [${schema.scaleMin ?? '−∞'}, ${schema.scaleMax ?? '∞'}].`, `${outside} قيمة خارج النطاق المعلن.`, {
              outside,
            }),
          );
        }
      }
      if (schema.type === 'binary' && distinct.size > 2) {
        out.push(issue('invalid-category', 'WARNING', [name], `Declared binary but has ${distinct.size} distinct values.`, `معلن كثنائي لكنه يحتوي ${distinct.size} قيم مختلفة.`, { distinct: distinct.size }));
      }
      if (schema.type === 'numeric' && finite.length >= 8) {
        const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
        const sd = standardDeviation(finite);
        const extreme = sd > 0 ? finite.filter((value) => Math.abs((value - mean) / sd) > 3.29).length : 0;
        if (extreme > 0) {
          out.push(issue('outliers', 'INFO', [name], `${extreme} values lie beyond |z| > 3.29. They are kept; removing them is a recorded transformation.`, `${extreme} قيمة متطرفة (|z| > 3.29) مُبقاة.`, { extreme }));
        }
      }
    }
  } else {
    const { missing } = categorical(dataset, name);
    if (missing > 0) {
      out.push(issue('missing-values', (missing / n) * 100 > 20 ? 'WARNING' : 'INFO', [name], `${missing} of ${n} values missing.`, `${missing} من ${n} قيمة مفقودة.`, { missing }));
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                           Specification against data                       */
/* -------------------------------------------------------------------------- */

const MIN_N: Partial<Record<MethodSpec['analysisType'], { block: number; warn: number }>> = {
  correlation: { block: 3, warn: 30 },
  reliability: { block: 3, warn: 30 },
  efa: { block: 50, warn: 100 },
  mediation: { block: 20, warn: 50 },
  moderation: { block: 20, warn: 50 },
  cfa: { block: 100, warn: 200 },
};

export function validateSpec(spec: MethodSpec, dataset: EngineDataset): Issue[] {
  const issues: Issue[] = [];
  const names = columnsOf(spec);

  const unknown = names.filter((name) => !column(dataset, name));
  if (unknown.length > 0) {
    return [issue('unknown-column', 'ERROR', unknown, `Not in this dataset version: ${unknown.join(', ')}.`, `غير موجود في هذا الإصدار: ${unknown.join(', ')}.`)];
  }
  if (new Set(names).size !== names.length && spec.analysisType !== 'pls' && spec.analysisType !== 'cfa') {
    issues.push(issue('duplicate-variable', 'ERROR', names, 'A variable is used twice in one role set (for example the outcome among the predictors).', 'متغير مستخدم مرتين في التحليل.'));
  }

  const typeOf = (name: string) => column(dataset, name)!.schema.type;
  const needQuantitative = (list: string[], allowBinary = true) => {
    for (const name of list) {
      const type = typeOf(name);
      if (!QUANTITATIVE.has(type) || (!allowBinary && type === 'binary')) {
        issues.push(
          issue('incompatible-type', 'ERROR', [name], `${name} is ${type}; this analysis needs a numeric or ordinal variable.`, `${name} من نوع ${type}؛ يحتاج هذا التحليل متغيرًا رقميًا أو ترتيبيًا.`, { type }),
        );
      }
    }
  };

  const quantitative = spec.analysisType === 'anova' ? [spec.outcome] : names;
  needQuantitative(quantitative, spec.analysisType !== 'efa' && spec.analysisType !== 'reliability');

  if (spec.analysisType === 'correlation' && spec.method === 'pearson') {
    const ordinal = spec.variables.filter((name) => typeOf(name) === 'ordinal');
    if (ordinal.length > 0) {
      issues.push(
        issue('pearson-on-ordinal', 'WARNING', ordinal, 'Pearson treats these ordinal variables as interval; Spearman makes no such assumption.', 'بيرسون يعامل هذه المتغيرات الترتيبية كفئوية؛ سبيرمان لا يفترض ذلك.'),
      );
    }
  }
  if (spec.analysisType === 'regression') {
    const binary = spec.predictors.filter((name) => typeOf(name) === 'binary');
    if (binary.length > 0) {
      issues.push(issue('binary-predictor', 'INFO', binary, 'Binary predictors are entered as 0/1-style numeric codes; b is the difference between the two codes.', 'تُدخل المتنبئات الثنائية كرموز رقمية.'));
    }
  }
  if (spec.analysisType === 'anova') {
    const type = typeOf(spec.group);
    if (type === 'numeric' || type === 'text' || type === 'date') {
      issues.push(issue('incompatible-type', 'ERROR', [spec.group], `${spec.group} is ${type}; the grouping variable must be categorical.`, `${spec.group} من نوع ${type}؛ يجب أن يكون متغير التجميع فئويًا.`));
    }
  }

  if (issues.some((entry) => entry.severity === 'ERROR')) return issues;

  /* Sample size and variance on the rows the analysis will actually use. */
  const quantitativeColumns = quantitative.map((name) => numeric(dataset, name));
  const rows = completeRows(quantitativeColumns.map((col) => col.values));
  const threshold = MIN_N[spec.analysisType];
  const usable = spec.analysisType === 'correlation' && spec.missing === 'pairwise' ? Math.min(...quantitativeColumns.map((col) => col.values.filter(Number.isFinite).length)) : rows.length;
  if (threshold && usable < threshold.block) {
    issues.push(issue('insufficient-sample', 'BLOCKING', names, `${usable} complete cases; this analysis needs at least ${threshold.block}.`, `${usable} حالة مكتملة؛ يحتاج هذا التحليل ${threshold.block} على الأقل.`, { n: usable, minimum: threshold.block }));
  } else if (threshold && usable < threshold.warn) {
    issues.push(issue('small-sample', 'WARNING', names, `${usable} complete cases; ${threshold.warn} or more is recommended.`, `${usable} حالة مكتملة؛ يُوصى بـ ${threshold.warn} أو أكثر.`, { n: usable, recommended: threshold.warn }));
  }
  if (spec.analysisType === 'regression' && rows.length < spec.predictors.length + 3) {
    issues.push(issue('insufficient-sample', 'BLOCKING', names, `${rows.length} complete cases cannot support ${spec.predictors.length} predictors.`, 'عدد الحالات لا يكفي لعدد المتنبئات.', { n: rows.length }));
  }

  for (const col of quantitativeColumns) {
    const values = pick(col.values, rows);
    if (values.length >= 2 && standardDeviation(values) === 0) {
      issues.push(issue('constant', 'BLOCKING', [col.name], `${col.name} is constant in the analysed rows; it has no variance to analyse.`, `${col.name} ثابت في الحالات المحللة.`));
    }
  }

  if (spec.analysisType === 'regression' && spec.predictors.length > 1 && rows.length > 3) {
    const predictors = spec.predictors.map((name) => pick(numeric(dataset, name).values, rows));
    for (let i = 0; i < predictors.length; i += 1) {
      for (let j = i + 1; j < predictors.length; j += 1) {
        const r = pearson(predictors[i]!, predictors[j]!);
        if (Math.abs(r) > 0.9) {
          issues.push(
            issue('multicollinearity-risk', 'WARNING', [spec.predictors[i]!, spec.predictors[j]!], `These predictors correlate at r = ${r.toFixed(3)}; see the VIF in the result.`, `ارتباط مرتفع بين المتنبئين (r = ${r.toFixed(3)}).`, { r: Number(r.toFixed(4)) }),
          );
        }
      }
    }
  }

  if (spec.analysisType === 'anova') {
    const groups = categorical(dataset, spec.group).values;
    const counts = new Map<string, number>();
    rows.forEach((row) => {
      const label = groups[row];
      if (label != null) counts.set(label, (counts.get(label) ?? 0) + 1);
    });
    if (counts.size < 2) issues.push(issue('too-few-groups', 'BLOCKING', [spec.group], 'Fewer than two groups have data.', 'أقل من مجموعتين تحتويان على بيانات.'));
    if (counts.size > 20) issues.push(issue('too-many-groups', 'ERROR', [spec.group], `${counts.size} groups: is this really a grouping variable?`, `${counts.size} مجموعة: هل هذا متغير تجميع فعلًا؟`));
    const tiny = [...counts.entries()].filter(([, count]) => count < 2).map(([label]) => label);
    if (tiny.length > 0) issues.push(issue('group-too-small', 'BLOCKING', [spec.group], `Groups with fewer than 2 cases: ${tiny.join(', ')}.`, 'مجموعات تحتوي أقل من حالتين.'));
  }

  if (spec.analysisType === 'efa' && spec.retention === 'fixed' && !spec.nFactors) {
    issues.push(issue('missing-parameter', 'ERROR', [], 'Fixed retention needs nFactors.', 'يلزم تحديد عدد العوامل.'));
  }
  if (spec.analysisType === 'cfa') {
    for (const entry of spec.constructs) {
      if (entry.indicators.length < 3) {
        issues.push(issue('under-identified', 'ERROR', entry.indicators, `${entry.name} has ${entry.indicators.length} indicators; each factor needs at least 3 to be identified on its own.`, `${entry.name} يحتاج ثلاثة مؤشرات على الأقل.`));
      }
    }
  }
  return issues;
}
