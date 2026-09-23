/**
 * Figures, generated only from a run's stored estimates, as self-contained SVG.
 *
 * Like tables, every figure lists the estimate keys it draws, so it can be
 * linked to its values in the Research Graph and marked stale with them.
 * Deterministic: the same estimates always give the same bytes.
 */

import { formatNumber, formatP } from './tables';
import type { Estimate, NormalisedResult } from './types';

export interface StatFigure {
  kind: string;
  title: string;
  svg: string;
  keys: string[];
}

const esc = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Helvetica, Arial, sans-serif" font-size="12"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`;

function box(x: number, y: number, text: string) {
  return `<rect x="${x - 60}" y="${y - 16}" width="120" height="32" fill="#fff" stroke="#222"/><text x="${x}" y="${y + 4}" text-anchor="middle">${esc(text)}</text>`;
}

function arrow(x1: number, y1: number, x2: number, y2: number, label: string, lx: number, ly: number) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#222" marker-end="url(#a)"/><text x="${lx}" y="${ly}" text-anchor="middle">${esc(label)}</text>`;
}

const defs = '<defs><marker id="a" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0L10,5L0,10z" fill="#222"/></marker></defs>';

const coef = (e: Estimate | undefined) => (e ? `${formatNumber(e.estimate)}${e.p != null ? (e.p < 0.001 ? '***' : e.p < 0.01 ? '**' : e.p < 0.05 ? '*' : '') : ''}` : '—');

export function figuresFor(result: NormalisedResult): StatFigure[] {
  const by = new Map(result.estimates.map((estimate) => [estimate.key, estimate]));
  const out: StatFigure[] = [];

  if (result.analysisType === 'mediation') {
    const [a, b, direct, indirect] = ['path:a', 'path:b', 'effect:direct', 'effect:indirect'].map((key) => by.get(key));
    const [x, m, y] = (indirect?.term ?? 'X>M>Y').split('>');
    const body =
      defs +
      box(90, 170, x ?? 'X') +
      box(300, 50, m ?? 'M') +
      box(510, 170, y ?? 'Y') +
      arrow(140, 154, 250, 66, `a = ${coef(a)}`, 170, 100) +
      arrow(350, 66, 460, 154, `b = ${coef(b)}`, 430, 100) +
      arrow(150, 170, 450, 170, `c′ = ${coef(direct)}`, 300, 162) +
      `<text x="300" y="225" text-anchor="middle">Indirect a·b = ${esc(formatNumber(indirect?.estimate))}, ${Math.round((indirect?.ciLevel ?? 0.95) * 100)}% CI [${esc(formatNumber(indirect?.ciLow))}, ${esc(formatNumber(indirect?.ciHigh))}]</text>`;
    out.push({ kind: 'path-diagram', title: 'Mediation model', svg: svg(600, 240, body), keys: [a, b, direct, indirect].filter(Boolean).map((e) => (e as Estimate).key) });
  }

  if (result.analysisType === 'moderation') {
    const conditional = result.estimates.filter((e) => e.family === 'conditional');
    const width = 520;
    const height = 300;
    const slopes = conditional.map((e) => e.estimate);
    const maxSlope = Math.max(1e-9, ...slopes.map(Math.abs));
    const lines = conditional
      .map((e, i) => {
        const dy = (e.estimate / maxSlope) * 100;
        const y0 = 150 + dy;
        const y1 = 150 - dy;
        const dash = ['6,4', '', '2,3'][i % 3];
        return `<line x1="80" y1="${y0.toFixed(2)}" x2="460" y2="${y1.toFixed(2)}" stroke="#222" stroke-dasharray="${dash}"/><text x="468" y="${(y1 + 4).toFixed(2)}">${esc(`${e.term}: ${formatNumber(e.estimate)} (p ${formatP(e.p)})`)}</text>`;
      })
      .join('');
    const body = `<line x1="80" y1="260" x2="460" y2="260" stroke="#888"/><line x1="80" y1="40" x2="80" y2="260" stroke="#888"/><text x="270" y="285" text-anchor="middle">X (low → high)</text><text x="30" y="150" transform="rotate(-90 30 150)" text-anchor="middle">Predicted Y (relative)</text>${lines}`;
    out.push({ kind: 'simple-slopes', title: 'Conditional effects (simple slopes)', svg: svg(width + 200, height, body), keys: conditional.map((e) => e.key) });
  }

  if (result.analysisType === 'efa') {
    const eigen = result.estimates.filter((e) => e.family === 'eigenvalue');
    const max = Math.max(1, ...eigen.map((e) => e.estimate));
    const step = 360 / Math.max(1, eigen.length - 1);
    const points = eigen.map((e, i) => [60 + i * step, 250 - (e.estimate / max) * 200] as const);
    const body =
      `<line x1="60" y1="250" x2="440" y2="250" stroke="#888"/><line x1="60" y1="40" x2="60" y2="250" stroke="#888"/>` +
      `<line x1="60" y1="${(250 - 200 / max).toFixed(2)}" x2="440" y2="${(250 - 200 / max).toFixed(2)}" stroke="#bbb" stroke-dasharray="4,3"/>` +
      `<polyline fill="none" stroke="#222" points="${points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')}"/>` +
      points.map(([x, y], i) => `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.5" fill="#222"/><text x="${x.toFixed(2)}" y="268" text-anchor="middle">${i + 1}</text>`).join('') +
      `<text x="250" y="290" text-anchor="middle">Factor</text><text x="20" y="145" transform="rotate(-90 20 145)" text-anchor="middle">Eigenvalue</text>`;
    out.push({ kind: 'scree', title: 'Scree plot', svg: svg(480, 300, body), keys: eigen.map((e) => e.key) });
  }

  const intervals = result.estimates.filter((e) => (e.family === 'coefficient' || e.family === 'path') && e.ciLow != null && e.ciHigh != null && e.term !== '(intercept)');
  if (intervals.length > 0 && (result.analysisType === 'regression' || result.analysisType === 'pls')) {
    const lo = Math.min(0, ...intervals.map((e) => e.ciLow as number));
    const hi = Math.max(0, ...intervals.map((e) => e.ciHigh as number));
    const scale = (value: number) => 180 + ((value - lo) / (hi - lo || 1)) * 320;
    const rows = intervals
      .map((e, i) => {
        const y = 40 + i * 28;
        return `<text x="170" y="${y + 4}" text-anchor="end">${esc(e.term ?? e.key)}</text><line x1="${scale(e.ciLow as number).toFixed(2)}" y1="${y}" x2="${scale(e.ciHigh as number).toFixed(2)}" y2="${y}" stroke="#222"/><circle cx="${scale(e.estimate).toFixed(2)}" cy="${y}" r="4" fill="#222"/>`;
      })
      .join('');
    const zero = scale(0).toFixed(2);
    const height = 60 + intervals.length * 28;
    out.push({
      kind: 'coefficient-plot',
      title: 'Estimates with confidence intervals',
      svg: svg(540, height, `<line x1="${zero}" y1="20" x2="${zero}" y2="${height - 20}" stroke="#bbb" stroke-dasharray="4,3"/>${rows}`),
      keys: intervals.map((e) => e.key),
    });
  }
  return out;
}
