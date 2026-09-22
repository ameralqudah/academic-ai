/**
 * A research diagram as SVG.
 *
 * The font travels inside the file. A figure that relies on the reader's fonts
 * renders Arabic in whatever the machine has — or as boxes — and one converted
 * to PNG in the browser cannot reach the page's fonts at all. Embedding the
 * two weights used costs about 130 KB and makes the file look the same
 * everywhere it is opened.
 *
 * Every piece of text is escaped. The names come from a model reading a
 * conversation, and a construct called `<script>` must be drawn as those
 * characters, not run.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TYPE, type Edge, type Layout, type Shape } from './layout';

export const INK = '#1c2b27';
export const LINE = '#0b4a3b';
export const FILL = '#eef5f2';
export const ITEM_FILL = '#ffffff';
export const MODERATOR_FILL = '#fbf6ea';
export const ACCENT = '#8a6420';

const FONT_FAMILY = "'Plex Arabic', 'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, Arial, sans-serif";

let fontFaces: string | null = null;

/** The @font-face rules, read once. Absent fonts leave the system fallback. */
function embeddedFonts(): string {
  if (fontFaces !== null) return fontFaces;

  const directory = join(process.cwd(), 'node_modules', '@fontsource', 'ibm-plex-sans-arabic', 'files');
  const faces: string[] = [];

  for (const [weight, subsets] of [
    [400, ['arabic', 'latin']],
    [600, ['arabic', 'latin']],
  ] as const) {
    for (const subset of subsets) {
      try {
        const data = readFileSync(join(directory, `ibm-plex-sans-arabic-${subset}-${weight}-normal.woff2`));
        faces.push(
          `@font-face{font-family:'Plex Arabic';font-weight:${weight};src:url(data:font/woff2;base64,${data.toString('base64')}) format('woff2');}`,
        );
      } catch {
        /* A missing font file costs the look, not the figure. */
      }
    }
  }

  fontFaces = faces.join('');
  return fontFaces;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const r = (value: number) => Math.round(value * 10) / 10;

function textLines(
  lines: string[],
  x: number,
  top: number,
  size: number,
  gap: number,
  options: { weight?: number; anchor?: 'start' | 'middle' | 'end'; rtl: boolean; fill?: string },
): string {
  return lines
    .map(
      (line, index) =>
        `<text x="${r(x)}" y="${r(top + size + index * (size + gap))}" font-size="${size}" font-weight="${options.weight ?? 400}" text-anchor="${options.anchor ?? 'middle'}"${options.rtl ? ' direction="rtl"' : ''} fill="${options.fill ?? INK}">${escapeXml(line)}</text>`,
    )
    .join('');
}

function shapeSvg(shape: Shape, rtl: boolean): string {
  const cx = shape.x + shape.w / 2;

  if (shape.kind === 'item') {
    return `<rect x="${r(shape.x)}" y="${r(shape.y)}" width="${r(shape.w)}" height="${r(shape.h)}" rx="3" fill="${ITEM_FILL}" stroke="${LINE}" stroke-width="1.3"/>${textLines(shape.title, cx, shape.y + (shape.h - TYPE.item) / 2 - 3, TYPE.item, 4, { rtl })}`;
  }

  const fill = shape.role === 'moderator' ? MODERATOR_FILL : FILL;
  const dashed = shape.role === 'control' ? ' stroke-dasharray="6 4"' : '';

  if (shape.kind === 'ellipse') {
    const block = shape.title.length * (TYPE.name + 5) + (shape.caption ? TYPE.line + 6 : 0);
    const top = shape.y + (shape.h - block) / 2 - 4;
    return (
      `<ellipse cx="${r(cx)}" cy="${r(shape.y + shape.h / 2)}" rx="${r(shape.w / 2)}" ry="${r(shape.h / 2)}" fill="${fill}" stroke="${LINE}" stroke-width="1.8"${dashed}/>` +
      textLines(shape.title, cx, top, TYPE.name, 5, { weight: 600, rtl }) +
      (shape.caption
        ? textLines([shape.caption], cx, top + shape.title.length * (TYPE.name + 5) + 2, TYPE.line, 4, { rtl: false, fill: ACCENT })
        : '')
    );
  }

  /* A conceptual box: the name centred, the dimensions listed from the reading edge. */
  const pad = 14;
  let svg = `<rect x="${r(shape.x)}" y="${r(shape.y)}" width="${r(shape.w)}" height="${r(shape.h)}" rx="10" fill="${fill}" stroke="${LINE}" stroke-width="1.8"${dashed}/>`;
  svg += textLines(shape.title, cx, shape.y + pad - 3, TYPE.name, 6, { weight: 600, rtl });

  if (shape.lines.length > 0) {
    const ruleY = shape.y + pad + shape.title.length * (TYPE.name + 6) + 2;
    svg += `<line x1="${r(shape.x + pad)}" y1="${r(ruleY)}" x2="${r(shape.x + shape.w - pad)}" y2="${r(ruleY)}" stroke="${LINE}" stroke-opacity="0.25"/>`;
    const lx = rtl ? shape.x + shape.w - pad : shape.x + pad;
    svg += textLines(shape.lines, lx, ruleY + 3, TYPE.line, 6, { anchor: 'start', rtl });
  }

  return svg;
}

function edgeSvg(edge: Edge): string {
  const dashed = edge.kind === 'moderation' ? ' stroke-dasharray="7 5"' : '';
  const width = edge.kind === 'item' ? 1.2 : 1.8;
  let svg = `<line x1="${r(edge.from.x)}" y1="${r(edge.from.y)}" x2="${r(edge.to.x)}" y2="${r(edge.to.y)}" stroke="${LINE}" stroke-width="${width}"${dashed} marker-end="url(#arrow)"/>`;

  if (edge.label && edge.labelAt) {
    const size = edge.kind === 'item' ? TYPE.item - 1 : TYPE.label;
    const w = edge.label.length * size * 0.6 + 12;
    svg += `<rect x="${r(edge.labelAt.x - w / 2)}" y="${r(edge.labelAt.y - size + 1)}" width="${r(w)}" height="${r(size + 8)}" rx="4" fill="#ffffff" fill-opacity="0.92"/>`;
    svg += `<text x="${r(edge.labelAt.x)}" y="${r(edge.labelAt.y + 4)}" font-size="${size}" font-weight="600" text-anchor="middle" fill="${ACCENT}" direction="ltr">${escapeXml(edge.label)}</text>`;
  }

  return svg;
}

export function renderSvg(layout: Layout): string {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r(layout.width)}" height="${r(layout.height)}" viewBox="0 0 ${r(layout.width)} ${r(layout.height)}" font-family="${FONT_FAMILY}">`,
    `<style>${embeddedFonts()}</style>`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${LINE}"/></marker></defs>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
  ];

  if (layout.title) {
    parts.push(
      `<text x="${r(layout.title.x)}" y="${r(layout.title.y)}" font-size="${TYPE.title}" font-weight="600" text-anchor="middle"${layout.rtl ? ' direction="rtl"' : ''} fill="${INK}">${escapeXml(layout.title.text)}</text>`,
    );
  }

  /* Edges under shapes, so an arrowhead meets an outline instead of crossing a fill. */
  for (const edge of layout.edges) parts.push(edgeSvg(edge));
  for (const shape of layout.shapes) parts.push(shapeSvg(shape, layout.rtl));

  for (const note of layout.notes) {
    parts.push(
      `<text x="${r(note.x)}" y="${r(note.y)}" font-size="${TYPE.note}" text-anchor="middle"${layout.rtl ? ' direction="rtl"' : ''} fill="#5b6b66">${escapeXml(note.text)}</text>`,
    );
  }

  parts.push('</svg>');
  return parts.join('');
}
