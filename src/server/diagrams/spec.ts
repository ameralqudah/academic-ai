/**
 * What a research diagram contains, before anything is drawn.
 *
 * A model reads the conversation and fills this in; code draws it. The split is
 * deliberate. Asked to draw, a model produced boxes of dashes and pipes in a
 * code block and suggested the researcher redraw it in PowerPoint. Asked for
 * structure, a model is reliable — which constructs, which role, which paths —
 * and layout is arithmetic that should come out the same every time.
 *
 * Numbers are not part of what a model may supply. Loadings, path coefficients
 * and R² come only from an analysis that ran (see `DiagramValues`); a model
 * filling them in would be inventing results, which this product refuses in
 * prose and must refuse in pictures for the same reason.
 */

export type DiagramKind = 'conceptual' | 'measurement' | 'structural';

export type ConstructRole = 'independent' | 'mediator' | 'moderator' | 'dependent' | 'control';

export interface DiagramConstruct {
  id: string;
  name: string;
  role: ConstructRole;
  /** Sub-dimensions, listed inside the box of a conceptual model. */
  dimensions: string[];
  /** Observed items, drawn as rectangles in a measurement model. */
  indicators: string[];
  /** Reflective arrows point to the items; formative ones point to the construct. */
  mode: 'reflective' | 'formative';
}

export interface DiagramPath {
  from: string;
  to: string;
  /** "H1", "H2" — a label, never a number pretending to be a result. */
  hypothesis?: string;
}

export interface DiagramModeration {
  moderator: string;
  from: string;
  to: string;
  hypothesis?: string;
}

/** Figures from an analysis that ran. Absent unless one did. */
export interface DiagramValues {
  paths: { from: string; to: string; beta: number }[];
  rSquared: Record<string, number>;
  loadings: { construct: string; indicator: string; loading: number }[];
  /** Where the numbers came from, printed under the diagram. */
  source: string;
}

export interface DiagramSpec {
  kind: DiagramKind;
  title: string;
  language: 'ar' | 'en';
  constructs: DiagramConstruct[];
  paths: DiagramPath[];
  moderations: DiagramModeration[];
  values?: DiagramValues;
  /** Said under the diagram: placeholders used, numbers withheld, and why. */
  notes: string[];
}

const ROLES: ConstructRole[] = ['independent', 'mediator', 'moderator', 'dependent', 'control'];
const KINDS: DiagramKind[] = ['conceptual', 'measurement', 'structural'];

function text(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function list(value: unknown, maxItems: number, maxLength = 80): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => text(entry, maxLength)).filter(Boolean).slice(0, maxItems);
}

/**
 * A spec from whatever the model returned, or the reason there is none.
 *
 * Forgiving about shape — ids are made from names when missing, unknown roles
 * are inferred from the paths — and strict about substance: two constructs and
 * one relation, or there is nothing to draw and the researcher is asked.
 * Anything numeric the model put in is dropped here, whatever it was called.
 */
export function parseSpec(
  raw: unknown,
  fallback: { kind: DiagramKind; language: 'ar' | 'en' },
): { spec: DiagramSpec } | { missing: 'constructs' | 'paths' } {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const kind = KINDS.includes(data.kind as DiagramKind) ? (data.kind as DiagramKind) : fallback.kind;
  const language = data.language === 'ar' || data.language === 'en' ? data.language : fallback.language;

  const seen = new Set<string>();
  const constructs: DiagramConstruct[] = [];

  for (const entry of Array.isArray(data.constructs) ? data.constructs.slice(0, 12) : []) {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const name = text(item.name, 70);
    if (!name) continue;

    let id = text(item.id, 40) || name;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);

    constructs.push({
      id,
      name,
      role: ROLES.includes(item.role as ConstructRole) ? (item.role as ConstructRole) : 'independent',
      dimensions: list(item.dimensions, 8),
      indicators: list(item.indicators, 10, 24),
      mode: item.mode === 'formative' ? 'formative' : 'reflective',
    });
  }

  if (constructs.length < 2) return { missing: 'constructs' };

  /* A path may name a construct by id or by name; both are accepted. */
  const resolve = (value: unknown): string | null => {
    const wanted = text(value, 70);
    if (!wanted) return null;
    return (
      constructs.find((construct) => construct.id === wanted)?.id ??
      constructs.find((construct) => construct.name === wanted)?.id ??
      null
    );
  };

  const paths: DiagramPath[] = [];

  for (const entry of Array.isArray(data.paths) ? data.paths.slice(0, 24) : []) {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const from = resolve(item.from);
    const to = resolve(item.to);
    if (!from || !to || from === to) continue;
    if (paths.some((path) => path.from === from && path.to === to)) continue;

    paths.push({ from, to, ...(hypothesisLabel(item.hypothesis) ? { hypothesis: hypothesisLabel(item.hypothesis) } : {}) });
  }

  const moderations: DiagramModeration[] = [];

  for (const entry of Array.isArray(data.moderations) ? data.moderations.slice(0, 6) : []) {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const moderator = resolve(item.moderator);
    const from = resolve(item.from);
    const to = resolve(item.to);
    if (!moderator || !from || !to) continue;
    if (!paths.some((path) => path.from === from && path.to === to)) continue;

    moderations.push({
      moderator,
      from,
      to,
      ...(hypothesisLabel(item.hypothesis) ? { hypothesis: hypothesisLabel(item.hypothesis) } : {}),
    });
  }

  if (paths.length === 0) return { missing: 'paths' };

  /* A moderator is whatever moderates, whatever role it was given. */
  for (const moderation of moderations) {
    const construct = constructs.find((entry) => entry.id === moderation.moderator);
    if (construct) construct.role = 'moderator';
  }

  inferRoles(constructs, paths);

  return {
    spec: {
      kind,
      title: text(data.title, 100),
      language,
      constructs,
      paths,
      moderations,
      notes: [],
    },
  };
}

/**
 * "H1", "H2a" — kept. "0.42", "β = 0.3", "p < .05" — dropped.
 *
 * The one place a model's text could carry a result into the picture, so it is
 * narrowed to what a hypothesis label looks like.
 */
export function hypothesisLabel(value: unknown): string | undefined {
  const label = text(value, 8);
  return /^[HhفF]\s?\d{1,2}[a-z]?$/u.test(label) ? label.replace(/\s/g, '').toUpperCase() : undefined;
}

/**
 * Roles the paths imply, where the model's are missing or contradict them.
 *
 * A construct with arrows in and out is a mediator whatever it was called; one
 * with only arrows in is a dependent. Only independents are corrected — a role
 * the model set to mediator or dependent is kept unless the arrows say it
 * cannot be.
 */
function inferRoles(constructs: DiagramConstruct[], paths: DiagramPath[]): void {
  for (const construct of constructs) {
    if (construct.role === 'moderator' || construct.role === 'control') continue;

    const incoming = paths.some((path) => path.to === construct.id);
    const outgoing = paths.some((path) => path.from === construct.id);

    if (incoming && outgoing) construct.role = 'mediator';
    else if (incoming) construct.role = 'dependent';
    else if (outgoing) construct.role = 'independent';
  }
}

/**
 * Items for a measurement model that was asked for without any.
 *
 * Dimensions stand in for items when there are some — a construct measured by
 * its dimensions is a common second-order layout. Otherwise three placeholders
 * named from the construct, and a note saying so, because a figure whose item
 * labels were invented must not pass for one whose items were measured.
 */
export function ensureIndicators(spec: DiagramSpec): DiagramSpec {
  let placeholders = false;

  const constructs = spec.constructs.map((construct) => {
    if (construct.indicators.length > 0) return construct;
    if (construct.dimensions.length > 0) return { ...construct, indicators: construct.dimensions.slice(0, 8) };

    placeholders = true;
    const stem = abbreviation(construct.name);
    return { ...construct, indicators: [1, 2, 3].map((n) => `${stem}${n}`) };
  });

  const notes = placeholders
    ? [
        ...spec.notes,
        spec.language === 'ar'
          ? 'رموز الفقرات توضيحية؛ استبدلها بفقرات أداة الدراسة.'
          : 'Item labels are placeholders; replace them with your instrument’s items.',
      ]
    : spec.notes;

  return { ...spec, constructs, notes };
}

/** "Digital Transformation" → "DT"; Arabic names → the first letters of each word. */
export function abbreviation(name: string): string {
  const words = name.split(/\s+/).filter((word) => /[\p{L}]/u.test(word));
  const letters = words.map((word) => (word.replace(/^ال/u, '').match(/\p{L}/u)?.[0] ?? '')).join('');
  return (letters || 'X').slice(0, 3).toUpperCase();
}
