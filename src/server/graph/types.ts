/**
 * Research Graph node types and their payloads (TARGET_ARCHITECTURE §G.1).
 *
 * Until the typed detail tables exist, a node's fields live in its version
 * payload, validated here. Each type also says which of its fields matter for
 * impact analysis: a change to a *structural* field invalidates what depends on
 * the node, a *substantive* one asks for review, a *cosmetic* one (a typo in a
 * label, a translation) affects nothing downstream. Fields not listed are
 * substantive — when unsure, ask for review rather than stay silent.
 */

import { z } from 'zod';

export const NODE_TYPES = [
  'idea',
  'research_question',
  'objective',
  'gap',
  'construct',
  'variable',
  'conceptual_model',
  'model_element',
  'hypothesis',
  'instrument',
  'instrument_item',
  'scale',
  'dataset',
  'dataset_version',
  'dataset_column',
  'transform_step',
  'analysis',
  'analysis_run',
  'result_value',
  'result_table',
  'figure',
  'interpretation',
  'source',
  'evidence',
  'citation',
  'manuscript',
  'section',
  'block',
  'journal_target',
  'submission',
  'reviewer_comment',
  'response',
  'repro_package',
  'decision',
  'note',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export const CHANGE_KINDS = ['cosmetic', 'substantive', 'structural'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const SEVERITIES = ['info', 'review', 'invalidates'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_RANK: Record<Severity, number> = { info: 1, review: 2, invalidates: 3 };

export function maxSeverity(a: Severity | undefined, b: Severity): Severity {
  return a && SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

const text = z.string().trim().max(20_000);
const shortText = z.string().trim().max(500);

/** Fields every payload may carry. */
const common = {
  notes: text.optional(),
  labelAr: shortText.optional(),
};

const loose = z.object(common).catchall(z.unknown());

const PAYLOADS: Partial<Record<NodeType, z.ZodType<Record<string, unknown>>>> = {
  construct: z
    .object({
      ...common,
      name: shortText.min(1),
      nameAr: shortText.optional(),
      abbreviation: z.string().trim().max(20).optional(),
      definition: text.optional(),
      kind: z.enum(['reflective', 'formative', 'single_item', 'higher_order']).default('reflective'),
    })
    .strict(),
  hypothesis: z
    .object({
      ...common,
      code: z.string().trim().max(20).optional(),
      statement: text.min(1),
      statementAr: text.optional(),
      kind: z.enum(['direct', 'mediation', 'moderation', 'difference', 'association']).default('direct'),
      direction: z.enum(['positive', 'negative', 'non_directional']).default('positive'),
    })
    .strict(),
  instrument_item: z
    .object({
      ...common,
      code: z.string().trim().max(40).optional(),
      wording: text.min(1),
      wordingAr: text.optional(),
      scaleMin: z.number().int().optional(),
      scaleMax: z.number().int().optional(),
      reverseCoded: z.boolean().default(false),
    })
    .strict(),
  dataset_column: z
    .object({
      ...common,
      name: shortText.min(1),
      description: text.optional(),
      dataType: z.enum(['numeric', 'ordinal', 'nominal', 'text', 'date']).default('numeric'),
      recode: z.record(z.string(), z.unknown()).optional(),
      missingCodes: z.array(z.union([z.string(), z.number()])).optional(),
    })
    .strict(),
  dataset_version: z
    .object({
      ...common,
      version: z.number().int().positive().optional(),
      contentHash: z.string().max(128).optional(),
      rows: z.number().int().nonnegative().optional(),
      storageKey: z.string().max(500).optional(),
      description: text.optional(),
    })
    .strict(),
  analysis: z
    .object({
      ...common,
      name: shortText.min(1),
      method: z.string().trim().min(1).max(40),
      spec: z.record(z.string(), z.unknown()).default({}),
      description: text.optional(),
    })
    .strict(),
  analysis_run: z
    .object({
      ...common,
      engine: z.string().max(40).optional(),
      engineVersion: z.string().max(40).optional(),
      status: z.enum(['queued', 'running', 'succeeded', 'failed']).default('succeeded'),
      seed: z.number().int().optional(),
      legacyRunId: z.string().max(64).optional(),
    })
    .strict(),
  result_value: z
    .object({
      ...common,
      stat: z.string().trim().min(1).max(40),
      value: z.number(),
      df: z.array(z.number()).optional(),
      p: z.number().min(0).max(1).optional(),
      ci: z.tuple([z.number(), z.number()]).optional(),
    })
    .strict(),
  source: z
    .object({
      ...common,
      title: text.min(1),
      doi: z.string().trim().max(200).optional(),
      year: z.number().int().optional(),
      authors: z.array(shortText).optional(),
      retracted: z.boolean().default(false),
      csl: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  citation: z
    .object({
      ...common,
      claim: text.optional(),
      locator: shortText.optional(),
      support: z.enum(['unverified', 'supports', 'partial', 'contradicts', 'not_found']).default('unverified'),
    })
    .strict(),
  section: z
    .object({
      ...common,
      key: z.string().trim().min(1).max(60),
      title: shortText.optional(),
      text: z.string().max(400_000).optional(),
    })
    .strict(),
  block: z
    .object({
      ...common,
      text: z.string().max(100_000),
      role: z.string().max(40).optional(),
    })
    .strict(),
};

/** Payload schema for a type; unlisted types accept any object for now. */
export function payloadSchema(type: NodeType): z.ZodType<Record<string, unknown>> {
  return PAYLOADS[type] ?? loose;
}

/**
 * Field classes per type. Anything absent is substantive; `notes` and
 * translations are cosmetic everywhere.
 */
const COSMETIC_EVERYWHERE = ['notes', 'labelAr'];

const FIELD_CLASSES: Partial<Record<NodeType, { cosmetic?: string[]; structural?: string[] }>> = {
  construct: { cosmetic: ['nameAr', 'abbreviation'], structural: ['kind'] },
  hypothesis: { cosmetic: ['code', 'statementAr'], structural: ['kind', 'direction'] },
  instrument_item: {
    cosmetic: ['code', 'wordingAr'],
    structural: ['reverseCoded', 'scaleMin', 'scaleMax'],
  },
  dataset_column: { cosmetic: ['description'], structural: ['dataType', 'recode', 'missingCodes', 'name'] },
  dataset_version: { cosmetic: ['description', 'version'], structural: ['contentHash', 'rows', 'storageKey'] },
  analysis: { cosmetic: ['name', 'description'], structural: ['method', 'spec'] },
  analysis_run: { cosmetic: ['legacyRunId'], structural: ['engine', 'engineVersion', 'status', 'seed'] },
  result_value: { structural: ['stat', 'value', 'df', 'p', 'ci'] },
  source: { cosmetic: ['csl', 'authors', 'year'], structural: ['retracted', 'doi'] },
  citation: { structural: ['support'] },
  section: { cosmetic: ['title'] },
  block: { cosmetic: ['role'] },
};

const KIND_RANK: Record<ChangeKind, number> = { cosmetic: 1, substantive: 2, structural: 3 };

function stable(value: unknown): string {
  return canonicalJson(value);
}

/**
 * How big a change is, from the old and new payloads. `null` when nothing
 * changed. A citation whose support becomes "supports" again is not escalated:
 * only a move to `contradicts` or `not_found` is structural.
 */
export function classifyChange(
  type: NodeType,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ChangeKind | null {
  const classes = FIELD_CLASSES[type] ?? {};
  const cosmetic = new Set([...COSMETIC_EVERYWHERE, ...(classes.cosmetic ?? [])]);
  const structural = new Set(classes.structural ?? []);

  let kind: ChangeKind | null = null;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    if (stable(before[key]) === stable(after[key])) continue;

    let fieldKind: ChangeKind = structural.has(key)
      ? 'structural'
      : cosmetic.has(key)
        ? 'cosmetic'
        : 'substantive';

    if (type === 'citation' && key === 'support') {
      fieldKind = after.support === 'contradicts' || after.support === 'not_found' ? 'structural' : 'substantive';
    }
    if (type === 'source' && key === 'retracted') {
      fieldKind = after.retracted === true ? 'structural' : 'substantive';
    }

    if (!kind || KIND_RANK[fieldKind] > KIND_RANK[kind]) kind = fieldKind;
  }

  return kind;
}

/** JSON with object keys sorted, so equal payloads hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
