/**
 * Computed results as the sections of a report.
 *
 * The export wrote prose and nothing else: a researcher who asked for their
 * analysis as a Word file received sentences about tables that were not in it.
 * These are the same tables the chat draws, in the same order, built from the
 * same stored results — so the file and the screen cannot disagree.
 */

import type { DescriptiveTables } from '@/analysis/descriptives';
import type { DocumentSection } from '@/server/generators/documents';

type Row = Record<string, unknown>;

const WORDS = {
  ar: {
    descriptives: 'الإحصاء الوصفي',
    frequencies: 'التوزيع التكراري',
    variable: 'المتغيّر',
    minimum: 'أدنى قيمة',
    maximum: 'أعلى قيمة',
    mean: 'المتوسط',
    sd: 'الانحراف المعياري',
    value: 'القيمة',
    frequency: 'التكرار',
    percent: 'النسبة %',
    valid: 'النسبة الصحيحة %',
    cumulative: 'التراكمية %',
    reliability: 'ثبات المقياس (كرونباخ ألفا)',
    items: 'الفقرات',
    alpha: 'ألفا',
    test: 'نتيجة الاختبار',
    statistic: 'الإحصائي',
    df: 'درجات الحرية',
    p: 'الدلالة p',
    effect: 'حجم الأثر',
    group: 'المجموعة',
    fit: 'مؤشرات مطابقة النموذج',
    index: 'المؤشر',
    loadings: 'التشبعات المعيارية',
    construct: 'المتغيّر الكامن',
    item: 'الفقرة',
    loading: 'التشبع',
    validity: 'الثبات المركّب والصدق التقاربي',
    n: 'العدد',
  },
  en: {
    descriptives: 'Descriptive Statistics',
    frequencies: 'Frequencies',
    variable: 'Variable',
    minimum: 'Minimum',
    maximum: 'Maximum',
    mean: 'Mean',
    sd: 'Std. Deviation',
    value: 'Value',
    frequency: 'Frequency',
    percent: 'Percent',
    valid: 'Valid Percent',
    cumulative: 'Cumulative Percent',
    reliability: 'Scale reliability (Cronbach’s alpha)',
    items: 'Items',
    alpha: 'Alpha',
    test: 'Test result',
    statistic: 'Statistic',
    df: 'df',
    p: 'p',
    effect: 'Effect size',
    group: 'Group',
    fit: 'Model fit',
    index: 'Index',
    loadings: 'Standardised loadings',
    construct: 'Construct',
    item: 'Item',
    loading: 'Loading',
    validity: 'Composite reliability and AVE',
    n: 'N',
  },
};

function fixed(value: unknown, digits = 3): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function pValue(value: unknown): string {
  return typeof value === 'number' && value < 0.001 ? '< .001' : fixed(value);
}

function descriptives(data: DescriptiveTables, words: typeof WORDS.en): DocumentSection[] {
  const sections: DocumentSection[] = [];

  if (data.descriptives.length > 0) {
    sections.push({
      heading: words.descriptives,
      level: 2,
      table: {
        headers: [words.variable, 'N', words.minimum, words.maximum, words.mean, words.sd],
        rows: data.descriptives.map((row) => [
          row.variable,
          row.n,
          fixed(row.min, 2),
          fixed(row.max, 2),
          fixed(row.mean, 2),
          fixed(row.sd, 3),
        ]),
      },
    });
  }

  for (const table of data.frequencies) {
    sections.push({
      heading: `${words.frequencies} — ${table.variable}`,
      level: 2,
      table: {
        headers: [words.value, words.frequency, words.percent, words.valid, words.cumulative],
        rows: table.rows.map((row) => [
          row.value,
          row.frequency,
          fixed(row.percent, 1),
          fixed(row.validPercent, 1),
          fixed(row.cumulativePercent, 1),
        ]),
      },
    });
  }

  return sections;
}

function analysis(data: Row, words: typeof WORDS.en): DocumentSection[] {
  const statistic = (data.statistic ?? {}) as Row;
  const effect = (data.effect ?? null) as Row | null;
  const estimates = Array.isArray(data.estimates) ? (data.estimates as Row[]) : [];

  const sections: DocumentSection[] = [
    {
      heading: `${words.test} — ${String(data.test ?? '')}`,
      level: 2,
      table: {
        headers: [words.statistic, words.df, words.p, words.effect, words.n],
        rows: [
          [
            `${String(statistic.name ?? '')} = ${fixed(statistic.value)}`,
            Array.isArray(data.df) ? (data.df as number[]).map((value) => fixed(value, 2)).join(', ') : fixed(data.df, 2),
            pValue(data.pValue),
            effect ? `${String(effect.name ?? '')} = ${fixed(effect.value)}` : '—',
            typeof data.n === 'number' ? data.n : '—',
          ],
        ],
      },
    },
  ];

  if (estimates.length > 0 && estimates.some((estimate) => estimate.label !== undefined)) {
    sections.push({
      level: 2,
      table: {
        headers: [words.group, 'N', words.mean, words.sd],
        rows: estimates.map((estimate) => [
          String(estimate.label ?? ''),
          typeof estimate.n === 'number' ? estimate.n : '—',
          fixed(estimate.mean, 2),
          fixed(estimate.sd, 3),
        ]),
      },
    });
  }

  return sections;
}

function reliability(data: Row, words: typeof WORDS.en): DocumentSection[] {
  const items = Array.isArray(data.items) ? (data.items as Row[]) : [];
  return [
    {
      heading: words.reliability,
      level: 2,
      table: {
        headers: [words.alpha, words.items, words.n],
        rows: [[fixed(data.alpha), items.length || fixed(data.itemCount, 0), typeof data.n === 'number' ? data.n : '—']],
      },
    },
  ];
}

function cbsem(data: Row, words: typeof WORDS.en): DocumentSection[] {
  const fit = (data.fit ?? {}) as Row;
  const loadings = Array.isArray(data.loadings) ? (data.loadings as Row[]) : [];
  const validity = Array.isArray(data.reliability) ? (data.reliability as Row[]) : [];

  return [
    {
      heading: words.fit,
      level: 2,
      table: {
        headers: [words.index, words.value],
        rows: [
          ['χ² (df)', `${fixed(fit.chiSquare, 2)} (${fixed(fit.df, 0)})`],
          ['χ²/df', fixed(fit.normedChiSquare, 2)],
          ['CFI', fixed(fit.cfi)],
          ['TLI', fixed(fit.tli)],
          ['RMSEA', fixed(fit.rmsea)],
          ['SRMR', fixed(fit.srmr)],
        ],
      },
    },
    ...(loadings.length
      ? [
          {
            heading: words.loadings,
            level: 2,
            table: {
              headers: [words.construct, words.item, words.loading, 'p'],
              rows: loadings.map((loading) => [
                String(loading.construct ?? ''),
                String(loading.indicator ?? ''),
                fixed(loading.standardised),
                loading.isReference ? '—' : pValue(loading.pValue),
              ]),
            },
          } satisfies DocumentSection,
        ]
      : []),
    ...(validity.length
      ? [
          {
            heading: words.validity,
            level: 2,
            table: {
              headers: [words.construct, 'CR', 'AVE'],
              rows: validity.map((row) => [
                String(row.construct ?? ''),
                fixed(row.compositeReliability),
                fixed(row.ave),
              ]),
            },
          } satisfies DocumentSection,
        ]
      : []),
  ];
}

/**
 * The sections a set of stored displays becomes, in the order they were
 * produced. Kinds with nothing tabular — a note, a set of figures — are left
 * to the text around them.
 */
export function analysisSections(
  displays: { kind: string; payload: unknown }[],
  language: 'ar' | 'en',
): DocumentSection[] {
  const words = WORDS[language];

  return displays.flatMap((display) => {
    const payload = (display.payload ?? {}) as Row;

    switch (display.kind) {
      case 'descriptives':
        return descriptives(payload as unknown as DescriptiveTables, words);
      case 'analysis':
        return analysis(payload, words);
      case 'reliability':
        return reliability(payload, words);
      case 'cbsem':
        return cbsem(payload, words);
      case 'note': {
        const lines = Array.isArray(payload.lines) ? payload.lines.map(String) : [];
        return lines.length ? [{ level: 2, paragraphs: lines } satisfies DocumentSection] : [];
      }
      default:
        return [];
    }
  });
}
