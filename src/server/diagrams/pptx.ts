/**
 * A research diagram as an editable PowerPoint slide.
 *
 * Built from native shapes and connectors, not from a picture of the diagram:
 * the point of the PowerPoint copy is that a researcher can move a box, fix a
 * name, or restyle it to a journal's template. The same layout as the SVG, so
 * the two copies agree.
 */

import type { Layout } from './layout';
import { ACCENT, FILL, INK, ITEM_FILL, LINE, MODERATOR_FILL } from './svg';

const hex = (color: string) => color.replace('#', '').toUpperCase();

/*
 * Arial rather than the embedded font: a PowerPoint file uses the fonts of the
 * machine that opens it, and Arial is on every one and shapes Arabic properly.
 */
const FONT = 'Arial';

export async function renderPptx(layout: Layout): Promise<Uint8Array> {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.rtlMode = layout.rtl;

  const slide = deck.addSlide();
  slide.background = { color: 'FFFFFF' };

  /* Pixels to inches, fitted to the slide with a margin, centred. */
  const slideW = 13.333;
  const slideH = 7.5;
  const scale = Math.min((slideW - 0.6) / layout.width, (slideH - 0.5) / layout.height);
  const offsetX = (slideW - layout.width * scale) / 2;
  const offsetY = (slideH - layout.height * scale) / 2;
  const X = (px: number) => offsetX + px * scale;
  const Y = (px: number) => offsetY + px * scale;
  const S = (px: number) => px * scale;
  /* Type shrinks with the drawing, but never below what reads on a projector. */
  const pt = (px: number) => Math.max(8, px * scale * 72 * 0.95);

  const align = layout.rtl ? 'right' : 'left';

  for (const edge of layout.edges) {
    const x = Math.min(edge.from.x, edge.to.x);
    const y = Math.min(edge.from.y, edge.to.y);

    slide.addShape(deck.ShapeType.line, {
      x: X(x),
      y: Y(y),
      w: Math.max(S(Math.abs(edge.to.x - edge.from.x)), 0.001),
      h: Math.max(S(Math.abs(edge.to.y - edge.from.y)), 0.001),
      flipH: edge.to.x < edge.from.x,
      flipV: edge.to.y < edge.from.y,
      line: {
        color: hex(LINE),
        width: edge.kind === 'item' ? 1 : 1.5,
        endArrowType: 'triangle',
        ...(edge.kind === 'moderation' ? { dashType: 'dash' as const } : {}),
      },
    });
  }

  for (const shape of layout.shapes) {
    const common = {
      x: X(shape.x),
      y: Y(shape.y),
      w: S(shape.w),
      h: S(shape.h),
      fontFace: FONT,
      color: hex(INK),
      line: {
        color: hex(LINE),
        width: shape.kind === 'item' ? 1 : 1.5,
        ...(shape.role === 'control' ? { dashType: 'dash' as const } : {}),
      },
      fill: { color: hex(shape.kind === 'item' ? ITEM_FILL : shape.role === 'moderator' ? MODERATOR_FILL : FILL) },
      margin: 4,
      rtlMode: layout.rtl,
    };

    if (shape.kind === 'item') {
      slide.addText(shape.title.join(' '), {
        ...common,
        shape: deck.ShapeType.rect,
        fontSize: pt(12),
        align: 'center',
        valign: 'middle',
      });
      continue;
    }

    const runs = [
      {
        text: shape.title.join(' '),
        options: { bold: true, fontSize: pt(15), align: 'center' as const, breakLine: true },
      },
      ...(shape.caption
        ? [{ text: shape.caption, options: { fontSize: pt(12.5), color: hex(ACCENT), align: 'center' as const, breakLine: true } }]
        : []),
      /*
       * A real bullet, not the "•" typed into the SVG's text: PowerPoint puts a
       * paragraph bullet on the reading side, where a typed one landed at the
       * wrong end of an Arabic line.
       */
      ...shape.lines.map((line) => ({
        text: line.replace(/^•\s*/, ''),
        options: {
          fontSize: pt(12.5),
          align: align as 'left' | 'right',
          breakLine: true,
          ...(line.startsWith('•') ? { bullet: { indent: 12 } } : {}),
          rtlMode: layout.rtl,
        },
      })),
    ];

    slide.addText(runs, {
      ...common,
      shape: shape.kind === 'ellipse' ? deck.ShapeType.ellipse : deck.ShapeType.roundRect,
      rectRadius: 0.08,
      valign: shape.kind === 'ellipse' ? 'middle' : 'top',
    });
  }

  for (const edge of layout.edges) {
    if (!edge.label || !edge.labelAt) continue;
    const w = S(edge.label.length * 8 + 14);
    slide.addText(edge.label, {
      x: X(edge.labelAt.x) - w / 2,
      y: Y(edge.labelAt.y) - S(12),
      w,
      h: S(20),
      fontFace: FONT,
      fontSize: pt(edge.kind === 'item' ? 11 : 12.5),
      bold: true,
      color: hex(ACCENT),
      align: 'center',
      valign: 'middle',
      fill: { color: 'FFFFFF' },
      margin: 0,
    });
  }

  if (layout.title) {
    slide.addText(layout.title.text, {
      x: 0.3,
      y: Y(layout.title.y) - S(20),
      w: slideW - 0.6,
      h: S(34),
      fontFace: FONT,
      fontSize: pt(20),
      bold: true,
      color: hex(INK),
      align: 'center',
      rtlMode: layout.rtl,
    });
  }

  for (const note of layout.notes) {
    slide.addText(note.text, {
      x: 0.3,
      y: Y(note.y) - S(12),
      w: slideW - 0.6,
      h: S(18),
      fontFace: FONT,
      fontSize: pt(11),
      color: '5B6B66',
      align: 'center',
      rtlMode: layout.rtl,
    });
  }

  const output = await deck.write({ outputType: 'uint8array' });
  return output as Uint8Array;
}
