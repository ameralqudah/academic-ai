/**
 * The figures a methods chapter prints beside its tables.
 *
 * A bar chart of each category variable, a histogram of each numeric one —
 * drawn from the profile the engine computed, so a figure and the table above
 * it can never disagree. Drawn as SVG for the same reason the model diagrams
 * are: it is text, it scales, and the browser turns it into a PNG the
 * researcher can drop into Word.
 */

import type { ColumnProfile, DatasetProfile } from '@/analysis/types';
import { ACCENT, embeddedFonts, escapeXml, FILL, FONT_FAMILY, INK, LINE } from '@/server/diagrams/svg';

export interface Chart {
  /** `bar` for counts of categories, `histogram` for the shape of a number. */
  kind: 'bar' | 'histogram';
  title: string;
  variable: string;
  svg: string;
}

const WIDTH = 720;
const HEIGHT = 420;
const PAD = { top: 56, right: 28, bottom: 92, left: 64 };

const round = (value: number) => Math.round(value * 100) / 100;

function isArabic(text: string): boolean {
  return /[؀-ۿ]/u.test(text);
}

/** A label short enough to read under a bar, with the rest as a tooltip. */
function short(value: string, limit = 14): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function frame(title: string, body: string, axisLabel: string): string {
  const rtl = isArabic(title);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="${FONT_FAMILY}">`,
    `<style>${embeddedFonts()}</style>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`,
    `<text x="${WIDTH / 2}" y="32" font-size="17" font-weight="600" text-anchor="middle"${rtl ? ' direction="rtl"' : ''} fill="${INK}">${escapeXml(title)}</text>`,
    body,
    `<text x="${WIDTH / 2}" y="${HEIGHT - 12}" font-size="12" text-anchor="middle"${isArabic(axisLabel) ? ' direction="rtl"' : ''} fill="#5b6b66">${escapeXml(axisLabel)}</text>`,
    '</svg>',
  ].join('');
}

/** The plot area, its axis line, and the ticks up the left-hand side. */
function axes(maximum: number, countLabel: string): { body: string; scale: (value: number) => number } {
  const top = PAD.top;
  const bottom = HEIGHT - PAD.bottom;
  const height = bottom - top;
  const step = Math.max(1, Math.ceil(maximum / 4));
  const ceiling = Math.max(step * 4, maximum);
  const scale = (value: number) => (value / ceiling) * height;

  const ticks: string[] = [];
  for (let value = 0; value <= ceiling; value += step) {
    const y = bottom - scale(value);
    ticks.push(
      `<line x1="${PAD.left}" y1="${round(y)}" x2="${WIDTH - PAD.right}" y2="${round(y)}" stroke="#e4ece9" stroke-width="1"/>`,
      `<text x="${PAD.left - 10}" y="${round(y + 4)}" font-size="11" text-anchor="end" fill="#5b6b66">${value}</text>`,
    );
  }

  return {
    scale,
    body: [
      ...ticks,
      `<line x1="${PAD.left}" y1="${bottom}" x2="${WIDTH - PAD.right}" y2="${bottom}" stroke="${INK}" stroke-width="1.2"/>`,
      `<text x="18" y="${round(top + height / 2)}" font-size="12" text-anchor="middle" fill="#5b6b66" transform="rotate(-90 18 ${round(top + height / 2)})">${escapeXml(countLabel)}</text>`,
    ].join(''),
  };
}

function bars(values: { label: string; count: number }[], countLabel: string): string {
  const bottom = HEIGHT - PAD.bottom;
  const plot = WIDTH - PAD.left - PAD.right;
  const slot = plot / Math.max(1, values.length);
  const width = Math.min(72, slot * 0.68);
  const { body, scale } = axes(Math.max(...values.map((value) => value.count), 1), countLabel);

  const drawn = values.map((value, index) => {
    const centre = PAD.left + slot * (index + 0.5);
    const height = scale(value.count);
    const x = centre - width / 2;
    const label = short(value.label);
    return [
      `<rect x="${round(x)}" y="${round(bottom - height)}" width="${round(width)}" height="${round(height)}" fill="${FILL}" stroke="${LINE}" stroke-width="1.2" rx="3"/>`,
      `<text x="${round(centre)}" y="${round(bottom - height - 7)}" font-size="11" font-weight="600" text-anchor="middle" fill="${ACCENT}">${value.count}</text>`,
      `<text x="${round(centre)}" y="${bottom + 18}" font-size="11" text-anchor="middle"${isArabic(label) ? ' direction="rtl"' : ''} fill="${INK}"><title>${escapeXml(value.label)}</title>${escapeXml(label)}</text>`,
    ].join('');
  });

  return body + drawn.join('');
}

/** Sturges' rule, which is what a package uses when nobody says otherwise. */
function histogramBins(values: number[]): { label: string; count: number }[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return [{ label: String(round(min)), count: values.length }];
  }

  const count = Math.min(12, Math.max(4, Math.ceil(Math.log2(values.length) + 1)));
  const width = (max - min) / count;
  const bins = Array.from({ length: count }, (_, index) => ({
    from: min + index * width,
    to: min + (index + 1) * width,
    count: 0,
  }));

  for (const value of values) {
    const index = Math.min(count - 1, Math.floor((value - min) / width));
    const bin = bins[index];
    if (bin) bin.count += 1;
  }

  return bins.map((bin) => ({ label: `${round(bin.from)}–${round(bin.to)}`, count: bin.count }));
}

const WORDS = {
  ar: { count: 'التكرار', value: 'القيمة', distribution: 'توزيع', of: 'تكرارات' },
  en: { count: 'Frequency', value: 'Value', distribution: 'Distribution of', of: 'Counts of' },
};

/**
 * One figure per variable worth drawing, in the order the columns appear.
 *
 * Identifiers and free text are skipped for the same reason they are left out
 * of the tables: a bar per participant is not a finding. The count is capped,
 * because twenty figures nobody asked for is not a result either.
 */
export function chartsFor(
  profile: DatasetProfile,
  options: { language: 'ar' | 'en'; values?: Map<string, number[]>; limit?: number } = { language: 'en' },
): Chart[] {
  const words = WORDS[options.language];
  const charts: Chart[] = [];
  const limit = options.limit ?? 10;

  const drawable = (column: ColumnProfile) =>
    column.present > 0 && !(column.distinct === column.present && column.type !== 'numeric' && column.present > 1);

  for (const column of profile.columns) {
    if (charts.length >= limit) break;
    if (!drawable(column)) continue;

    const counted = column.type === 'categorical' || column.type === 'binary' || column.type === 'likert';

    if (counted && column.categories?.length) {
      const numeric = column.categories.every((category) => Number.isFinite(Number(category.value)));
      const values = [...column.categories]
        .sort((a, b) => (numeric ? Number(a.value) - Number(b.value) : b.count - a.count))
        .slice(0, 12)
        .map((category) => ({ label: String(category.value), count: category.count }));

      const title = `${words.of} ${column.name}`;
      charts.push({
        kind: 'bar',
        variable: column.name,
        title,
        svg: frame(title, bars(values, words.count), column.name),
      });
      continue;
    }

    const numbers = options.values?.get(column.name)?.filter((value) => Number.isFinite(value)) ?? [];
    if (column.numeric && numbers.length > 0) {
      const title = `${words.distribution} ${column.name}`;
      charts.push({
        kind: 'histogram',
        variable: column.name,
        title,
        svg: frame(title, bars(histogramBins(numbers), words.count), `${column.name} (${words.value})`),
      });
    }
  }

  return charts;
}
