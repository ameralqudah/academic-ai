/**
 * Where everything in a research diagram goes.
 *
 * Pure geometry, shared by the SVG and PowerPoint renderers so the two cannot
 * disagree. Laid out left to right and mirrored for Arabic at the end, because
 * mirroring one finished layout is simpler than writing every rule twice — and
 * a model read right to left runs its arrows right to left, which is what an
 * Arabic reader expects of a figure in an Arabic thesis.
 *
 * The conventions are the ones the literature uses, so a supervisor recognises
 * the figure without a legend: predictors on one side, outcomes on the other,
 * mediators between, a moderator above the relation it moderates with its arrow
 * landing on that relation, latent variables as ellipses and items as
 * rectangles in a measurement model.
 */

import type { DiagramConstruct, DiagramSpec } from './spec';
import { textWidth, wrap } from './text';

export interface Point {
  x: number;
  y: number;
}

export interface Shape {
  id: string;
  kind: 'box' | 'ellipse' | 'item';
  x: number;
  y: number;
  w: number;
  h: number;
  /** The name, already wrapped. */
  title: string[];
  /** Dimensions inside a conceptual box. */
  lines: string[];
  /** R² under the name of an outcome, when an analysis supplied it. */
  caption?: string;
  role?: DiagramConstruct['role'];
}

export interface Edge {
  from: Point;
  to: Point;
  kind: 'path' | 'moderation' | 'item';
  label?: string;
  labelAt?: Point;
}

export interface Layout {
  width: number;
  height: number;
  rtl: boolean;
  title?: { text: string; x: number; y: number };
  shapes: Shape[];
  edges: Edge[];
  notes: { text: string; x: number; y: number }[];
}

export const TYPE = {
  title: 20,
  name: 15,
  line: 12.5,
  item: 12,
  label: 12.5,
  note: 11,
};

const MARGIN = 40;
const COLUMN_GAP = 150;
const ROW_GAP = 44;
const BOX_WIDTH = 250;
const BOX_PAD = 14;
const ITEM = { w: 76, h: 30, gap: 10, reach: 64 };

/* -------------------------------------------------------------------------- */

function boxFor(construct: DiagramConstruct): Shape {
  const title = wrap(construct.name, BOX_WIDTH - BOX_PAD * 2, TYPE.name, 3);
  const lines = construct.dimensions.flatMap((dimension) =>
    wrap(`• ${dimension}`, BOX_WIDTH - BOX_PAD * 2, TYPE.line, 2),
  );

  const h =
    BOX_PAD * 2 + title.length * (TYPE.name + 6) + (lines.length > 0 ? 8 + lines.length * (TYPE.line + 6) : 0);

  return { id: construct.id, kind: 'box', x: 0, y: 0, w: BOX_WIDTH, h, title, lines: lines, role: construct.role };
}

function ellipseFor(construct: DiagramConstruct, caption?: string): Shape {
  const title = wrap(construct.name, 170, TYPE.name, 3);
  const widest = Math.max(...title.map((line) => textWidth(line, TYPE.name)));
  const w = Math.max(150, Math.min(240, widest + 56));
  const h = 46 + title.length * (TYPE.name + 5) + (caption ? TYPE.line + 6 : 0);

  return { id: construct.id, kind: 'ellipse', x: 0, y: 0, w, h, title, lines: [], role: construct.role, ...(caption ? { caption } : {}) };
}

type Side = 'start' | 'end' | 'top' | 'bottom';

/**
 * Which side a construct's items go: outward, so they never sit between
 * constructs. A mediator's go below it, because a direct path from predictor to
 * outcome passes above a mediator and would cut through items placed there.
 */
function itemSide(role: DiagramConstruct['role']): Side {
  if (role === 'independent' || role === 'control') return 'start';
  if (role === 'dependent') return 'end';
  if (role === 'mediator') return 'bottom';
  return 'top';
}

interface Block {
  construct: DiagramConstruct;
  shape: Shape;
  items: Shape[];
  side: Side;
  w: number;
  h: number;
}

function blockFor(construct: DiagramConstruct, spec: DiagramSpec): Block {
  const r2 = spec.values?.rSquared[construct.id];
  const caption = r2 !== undefined ? `R² = ${r2.toFixed(3)}` : undefined;

  if (spec.kind === 'conceptual') {
    const shape = boxFor(construct);
    return { construct, shape, items: [], side: 'start', w: shape.w, h: shape.h };
  }

  const shape = ellipseFor(construct, caption);

  if (spec.kind === 'structural') {
    return { construct, shape, items: [], side: 'start', w: shape.w, h: shape.h };
  }

  const side = itemSide(construct.role);
  const items = construct.indicators.map((indicator, index) => {
    const title = wrap(indicator, ITEM.w * 1.9, TYPE.item, 1);
    const w = Math.max(ITEM.w, textWidth(title[0] ?? '', TYPE.item) + 18);
    return { id: `${construct.id}::${index}`, kind: 'item' as const, x: 0, y: 0, w, h: ITEM.h, title, lines: [] };
  });

  const itemW = Math.max(ITEM.w, ...items.map((item) => item.w));

  if (side === 'top' || side === 'bottom') {
    const row = items.reduce((sum, item) => sum + item.w, 0) + ITEM.gap * Math.max(0, items.length - 1);
    return { construct, shape, items, side, w: Math.max(shape.w, row), h: shape.h + ITEM.reach + ITEM.h };
  }

  const stack = items.length * ITEM.h + Math.max(0, items.length - 1) * ITEM.gap;
  return { construct, shape, items, side, w: shape.w + ITEM.reach + itemW, h: Math.max(shape.h, stack) };
}

/** Places a block's construct and items once the block itself has a position. */
function placeBlock(block: Block, x: number, y: number): void {
  const { shape, items, side } = block;

  if (side === 'top' || side === 'bottom') {
    shape.x = x + (block.w - shape.w) / 2;
    shape.y = side === 'top' ? y + ITEM.h + ITEM.reach : y;
    const row = items.reduce((sum, item) => sum + item.w, 0) + ITEM.gap * Math.max(0, items.length - 1);
    let cursor = x + (block.w - row) / 2;
    for (const item of items) {
      item.x = cursor;
      item.y = side === 'top' ? y : y + shape.h + ITEM.reach;
      cursor += item.w + ITEM.gap;
    }
    return;
  }

  const itemW = Math.max(0, ...items.map((item) => item.w));
  const stack = items.length * ITEM.h + Math.max(0, items.length - 1) * ITEM.gap;

  shape.y = y + (block.h - shape.h) / 2;
  shape.x = side === 'start' && items.length > 0 ? x + itemW + ITEM.reach : x;

  let cursor = y + (block.h - stack) / 2;
  for (const item of items) {
    item.x = side === 'start' ? x + (itemW - item.w) : shape.x + shape.w + ITEM.reach;
    item.y = cursor;
    cursor += ITEM.h + ITEM.gap;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Geometry                                  */
/* -------------------------------------------------------------------------- */

function centre(shape: Shape): Point {
  return { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 };
}

/** Where a line from a shape's centre towards `toward` leaves its outline. */
export function boundary(shape: Shape, toward: Point): Point {
  const c = centre(shape);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;

  if (shape.kind === 'ellipse') {
    const a = shape.w / 2;
    const b = shape.h / 2;
    const t = 1 / Math.sqrt((dx / a) ** 2 + (dy / b) ** 2);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }

  const tx = dx === 0 ? Infinity : shape.w / 2 / Math.abs(dx);
  const ty = dy === 0 ? Infinity : shape.h / 2 / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function midpoint(a: Point, b: Point, at = 0.5): Point {
  return { x: a.x + (b.x - a.x) * at, y: a.y + (b.y - a.y) * at };
}

/** A label beside a line rather than on it, so the arrow stays readable. */
function beside(a: Point, b: Point, at: number): Point {
  const m = midpoint(a, b, at);
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / length;
  const ny = (b.x - a.x) / length;
  const lift = ny > 0 ? -1 : 1;
  return { x: m.x + nx * 14 * lift, y: m.y + ny * 14 * lift };
}

/* -------------------------------------------------------------------------- */
/*                                   Layout                                   */
/* -------------------------------------------------------------------------- */

export function layoutDiagram(spec: DiagramSpec): Layout {
  const byId = new Map(spec.constructs.map((construct) => [construct.id, construct]));
  const blocks = new Map(spec.constructs.map((construct) => [construct.id, blockFor(construct, spec)]));

  /*
   * Columns. Predictors first, then as many mediator columns as the chain of
   * mediators needs, then outcomes. A mediator's column is one past the
   * furthest of its predecessors, so a serial mediation reads as a chain.
   */
  const main = spec.constructs.filter((construct) => construct.role !== 'moderator');
  const column = new Map<string, number>();

  for (const construct of main) {
    if (construct.role === 'independent' || construct.role === 'control') column.set(construct.id, 0);
  }

  for (let pass = 0; pass < main.length; pass += 1) {
    for (const construct of main) {
      if (construct.role !== 'mediator') continue;
      const before = spec.paths
        .filter((path) => path.to === construct.id && column.has(path.from))
        .map((path) => column.get(path.from) as number);
      column.set(construct.id, Math.max(0, ...before) + 1);
    }
  }

  const lastMiddle = Math.max(0, ...main.filter((c) => c.role === 'mediator').map((c) => column.get(c.id) ?? 1));
  for (const construct of main) {
    if (construct.role === 'dependent') column.set(construct.id, lastMiddle + 1);
    if (!column.has(construct.id)) column.set(construct.id, 0);
  }

  const columnCount = Math.max(...[...column.values()]) + 1;
  const columns: Block[][] = Array.from({ length: columnCount }, () => []);

  /* Controls after the predictors in their column, so they sit below them. */
  const order = (construct: DiagramConstruct) => (construct.role === 'control' ? 1 : 0);
  for (const construct of [...main].sort((a, b) => order(a) - order(b))) {
    columns[column.get(construct.id) as number]?.push(blocks.get(construct.id) as Block);
  }

  const columnWidth = columns.map((list) => Math.max(0, ...list.map((block) => block.w)));
  const columnHeight = columns.map(
    (list) => list.reduce((sum, block) => sum + block.h, 0) + ROW_GAP * Math.max(0, list.length - 1),
  );
  const bodyHeight = Math.max(...columnHeight);

  /* Moderators get a band of their own above the model. */
  const moderators = spec.constructs.filter((construct) => construct.role === 'moderator');
  const moderatorBand = moderators.length
    ? Math.max(...moderators.map((construct) => (blocks.get(construct.id) as Block).h)) + 70
    : 0;

  const titleBand = spec.title ? 56 : 0;
  const top = MARGIN + titleBand + moderatorBand;

  /*
   * A path that skips a column — a direct effect beside a mediation — would run
   * straight through whatever sits in the columns between, and in a structural
   * model it disappeared behind the mediator's ellipse. The columns it skips
   * are lowered so the direct path passes above them.
   */
  const skipped = new Set<number>();
  for (const path of spec.paths) {
    const from = column.get(path.from);
    const to = column.get(path.to);
    if (from === undefined || to === undefined) continue;
    for (let between = Math.min(from, to) + 1; between < Math.max(from, to); between += 1) skipped.add(between);
  }
  let x = MARGIN;
  columns.forEach((list, index) => {
    let y = top + (bodyHeight - (columnHeight[index] as number)) / 2;
    for (const block of list) {
      placeBlock(block, x + ((columnWidth[index] as number) - block.w) / 2, y);
      y += block.h + ROW_GAP;
    }
    x += (columnWidth[index] as number) + COLUMN_GAP;
  });

  const bodyWidth = x - COLUMN_GAP - MARGIN;

  if (skipped.size > 0) {
    const others = columns.filter((_, index) => !skipped.has(index)).flat();
    const line = Math.max(...others.map((block) => block.shape.y + block.shape.h / 2));

    for (const index of skipped) {
      const list = columns[index] ?? [];
      if (list.length === 0) continue;
      const highest = Math.min(...list.map((block) => block.shape.y));
      const shift = line + 36 - highest;
      if (shift <= 0) continue;
      for (const block of list) {
        for (const shape of [block.shape, ...block.items]) shape.y += shift;
      }
    }
  }

  /* -------------------------------- edges ------------------------------- */

  const edges: Edge[] = [];
  const valueFor = (from: string, to: string) =>
    spec.values?.paths.find((path) => path.from === from && path.to === to)?.beta;

  const pathLines = new Map<string, { a: Point; b: Point }>();

  for (const path of spec.paths) {
    const source = blocks.get(path.from)?.shape;
    const target = blocks.get(path.to)?.shape;
    if (!source || !target || !byId.has(path.from) || !byId.has(path.to)) continue;
    if (byId.get(path.from)?.role === 'moderator') continue;

    const a = boundary(source, centre(target));
    const b = boundary(target, centre(source));
    pathLines.set(`${path.from}→${path.to}`, { a, b });

    const beta = valueFor(path.from, path.to);
    const label = [path.hypothesis, beta !== undefined ? `β = ${beta.toFixed(3)}` : undefined]
      .filter(Boolean)
      .join(': ');

    /*
     * A third of the way along rather than halfway: the middle of a relation is
     * where a moderator's arrow lands, and a label there sat under it.
     */
    const moderated = spec.moderations.some((m) => m.from === path.from && m.to === path.to);
    edges.push({
      from: a,
      to: b,
      kind: 'path',
      ...(label ? { label, labelAt: beside(a, b, moderated ? 0.28 : 0.45) } : {}),
    });
  }

  /* Each moderator above the midpoint of what it moderates. */
  const moderatorTop = MARGIN + titleBand;
  const placed: Shape[] = [];

  for (const moderator of moderators) {
    const block = blocks.get(moderator.id) as Block;
    const targets = spec.moderations
      .filter((moderation) => moderation.moderator === moderator.id)
      .map((moderation) => pathLines.get(`${moderation.from}→${moderation.to}`))
      .filter((line): line is { a: Point; b: Point } => Boolean(line));

    const anchorX = targets.length
      ? targets.reduce((sum, line) => sum + midpoint(line.a, line.b).x, 0) / targets.length
      : MARGIN + bodyWidth / 2;

    let bx = Math.min(Math.max(MARGIN, anchorX - block.w / 2), MARGIN + bodyWidth - block.w);
    /* Two moderators over the same relation sit side by side, not on top of each other. */
    for (const other of placed) {
      if (bx < other.x + other.w + 30 && bx + block.w > other.x - 30) bx = other.x + other.w + 30;
    }

    placeBlock(block, bx, moderatorTop);
    placed.push(block.shape);
  }

  for (const moderation of spec.moderations) {
    const shape = blocks.get(moderation.moderator)?.shape;
    const line = pathLines.get(`${moderation.from}→${moderation.to}`);
    if (!shape || !line) continue;

    const landing = midpoint(line.a, line.b);
    const start = boundary(shape, landing);
    edges.push({
      from: start,
      to: landing,
      kind: 'moderation',
      ...(moderation.hypothesis ? { label: moderation.hypothesis, labelAt: beside(start, landing, 0.55) } : {}),
    });
  }

  /* Items: reflective arrows point out to the item, formative ones in. */
  for (const block of blocks.values()) {
    for (const [index, item] of block.items.entries()) {
      const toItem = block.construct.mode !== 'formative';
      const a = boundary(block.shape, centre(item));
      const b = boundary(item, centre(block.shape));
      const indicator = block.construct.indicators[index] ?? '';
      const loading = spec.values?.loadings.find(
        (entry) => entry.construct === block.construct.id && entry.indicator === indicator,
      )?.loading;

      edges.push({
        from: toItem ? a : b,
        to: toItem ? b : a,
        kind: 'item',
        ...(loading !== undefined ? { label: loading.toFixed(3), labelAt: beside(a, b, 0.55) } : {}),
      });
    }
  }

  /* -------------------------------- frame -------------------------------- */

  const shapes = [...blocks.values()].flatMap((block) => [block.shape, ...block.items]);
  const right = Math.max(MARGIN + bodyWidth, ...shapes.map((shape) => shape.x + shape.w));
  const bottom = Math.max(...shapes.map((shape) => shape.y + shape.h));

  const noteTexts = [...spec.notes, ...(spec.values ? [spec.values.source] : [])];
  const width = right + MARGIN;
  const notes = noteTexts.map((text, index) => ({ text, x: width / 2, y: bottom + 34 + index * 18 }));
  const height = bottom + MARGIN + (notes.length ? notes.length * 18 + 10 : 0);

  const layout: Layout = {
    width,
    height,
    rtl: spec.language === 'ar',
    ...(spec.title ? { title: { text: spec.title, x: width / 2, y: MARGIN + 22 } } : {}),
    shapes,
    edges,
    notes,
  };

  return layout.rtl ? mirror(layout) : layout;
}

/** The same layout read right to left. Text is not mirrored — only positions. */
function mirror(layout: Layout): Layout {
  const flip = (point: Point): Point => ({ x: layout.width - point.x, y: point.y });

  return {
    ...layout,
    shapes: layout.shapes.map((shape) => ({ ...shape, x: layout.width - shape.x - shape.w })),
    edges: layout.edges.map((edge) => ({
      ...edge,
      from: flip(edge.from),
      to: flip(edge.to),
      ...(edge.labelAt ? { labelAt: flip(edge.labelAt) } : {}),
    })),
  };
}
