/**
 * Edge rules: what each relation means for impact analysis and provenance
 * (TARGET_ARCHITECTURE §G.2, R6; P1-A review F-5, F-6, F-10, F-11).
 *
 * Direction: an edge `src —rel→ dst` means **src depends on dst**. When `dst`
 * changes, `src` is flagged with the severity the rule gives for that kind of
 * change. The architecture's `produces` and `element_of` point the other way,
 * so they are expressed here as `produced_by` (result → run) and `contains`
 * (model → element); the meaning is the same.
 *
 * The chain the rules make traceable, end to end:
 *
 *   research question ← scoped_by ← construct ← relates ← hypothesis (answers → question)
 *   construct ← measures ← item ← binds ← column ← includes ← dataset version
 *   model ⊃ element (represents → construct, indicated_by → item/column, connects → element)
 *   analysis → specifies → model/hypothesis, uses_column → column
 *   run → executes → analysis@v, uses_data → dataset version@v
 *   result → produced_by → run;  table/figure → contains_value → result
 *   section ⊃ block ⊃ claim → reports → result, cites → citation → of_source → source
 *   claim → supported_by → evidence → extracted_from → source
 *
 * The rules are data, kept in code so they are versioned and reviewed with the
 * code that interprets them, and tested as a table.
 */

import { NODE_TYPES, type ChangeKind, type NodeType, type Severity } from './types';

type BySeverity = Record<ChangeKind, Severity | null>;

export interface EdgeRule {
  rel: string;
  from: readonly NodeType[];
  to: readonly NodeType[];
  /** False for relations that record meaning but never make anything stale. */
  dependency: boolean;
  /** dst changed → severity on src. */
  downstream?: BySeverity;
  /**
   * src changed → severity on dst, one hop only. For the few cases where the
   * dependency is conceptual both ways (a hypothesis rewritten → the model path
   * it posits should be reviewed).
   */
  upstream?: BySeverity;
  /**
   * Whether a node flagged through this edge passes staleness on. False for
   * `tests`: a changed hypothesis voids the verdict, not the number.
   */
  propagate?: boolean;
  /**
   * The source is a container of the target (a questionnaire and its items, a
   * model and its elements, a section and its blocks): a change to a part is
   * the same change to the whole, so the container passes on the kind of change
   * it received.
   */
  container?: boolean;
  /** Adding or removing this edge is itself a change of this kind to that node. */
  onLink?: { node: 'src' | 'dst'; kind: ChangeKind };
  /**
   * The edge carries provenance: the number a text reports, the source it
   * cites. Removing it never passes silently — the source node is marked
   * `untraced` and cannot be accepted as current until it is re-linked or
   * rewritten.
   */
  provenance?: boolean;
  /**
   * Part of an analysis run's record (what it executed, on which data, what it
   * produced). Only the engine writes these, with the run, and nobody removes
   * them: an old run stays traceable to exactly what it used.
   */
  engineOnly?: boolean;
  /** Created and removed only by a dedicated service operation (`supersede`). */
  managed?: boolean;
  /**
   * A judgement about an immutable object (which value tests which
   * hypothesis), allowed even where the object's own links are frozen.
   */
  annotation?: boolean;
  /** Short explanation shown in the Impact Report. */
  reason: string;
}

const REVIEW_INVALIDATE: BySeverity = { cosmetic: null, substantive: 'review', structural: 'invalidates' };
const REVIEW: BySeverity = { cosmetic: null, substantive: 'review', structural: 'review' };
const INFO: BySeverity = { cosmetic: null, substantive: 'info', structural: 'info' };
const INFO_INVALIDATE: BySeverity = { cosmetic: null, substantive: 'info', structural: 'invalidates' };

const RESULTS = ['result_value', 'result_table', 'figure'] as const;
const TEXT = ['block', 'claim'] as const;

export const EDGE_RULES: readonly EdgeRule[] = [
  // Research design
  { rel: 'addresses', from: ['research_question'], to: ['gap'], dependency: true, downstream: REVIEW, reason: 'The question is motivated by this gap.' },
  { rel: 'operationalizes', from: ['objective'], to: ['research_question'], dependency: true, downstream: REVIEW, reason: 'The objective operationalises this question.' },
  { rel: 'scoped_by', from: ['construct'], to: ['research_question'], dependency: true, downstream: REVIEW, reason: 'The construct was chosen for this research question.' },
  { rel: 'answers', from: ['hypothesis'], to: ['research_question'], dependency: true, downstream: REVIEW, reason: 'The hypothesis is an answer to this research question.' },
  { rel: 'defined_by', from: ['construct'], to: ['source'], dependency: true, downstream: REVIEW, reason: 'The construct definition comes from this source.' },
  { rel: 'relates', from: ['hypothesis'], to: ['construct', 'variable'], dependency: true, downstream: REVIEW, reason: 'The hypothesis is about this construct.' },
  { rel: 'grounded_in', from: ['hypothesis'], to: ['evidence', 'citation', 'source'], dependency: true, downstream: REVIEW, reason: 'The hypothesis is justified by this.' },
  { rel: 'posits', from: ['hypothesis'], to: ['model_element'], dependency: true, downstream: REVIEW, upstream: REVIEW, reason: 'The hypothesis is this path of the model.' },

  // Research model
  { rel: 'contains', from: ['conceptual_model'], to: ['model_element'], dependency: true, downstream: REVIEW_INVALIDATE, container: true, onLink: { node: 'src', kind: 'structural' }, reason: 'The model contains this element.' },
  { rel: 'represents', from: ['model_element'], to: ['construct', 'variable'], dependency: true, downstream: REVIEW_INVALIDATE, onLink: { node: 'src', kind: 'structural' }, reason: 'The model element stands for this construct.' },
  { rel: 'indicated_by', from: ['model_element'], to: ['instrument_item', 'dataset_column'], dependency: true, downstream: REVIEW_INVALIDATE, onLink: { node: 'src', kind: 'structural' }, reason: 'The element is measured by this indicator.' },
  { rel: 'connects', from: ['model_element'], to: ['model_element'], dependency: true, downstream: REVIEW_INVALIDATE, onLink: { node: 'src', kind: 'structural' }, reason: 'The path connects this element (as cause, outcome, moderator or mediator).' },

  // Instrument
  { rel: 'measures', from: ['instrument_item'], to: ['construct'], dependency: true, downstream: REVIEW, upstream: REVIEW, onLink: { node: 'dst', kind: 'structural' }, reason: 'The item measures this construct.' },
  { rel: 'has_item', from: ['instrument'], to: ['instrument_item'], dependency: true, downstream: REVIEW, container: true, onLink: { node: 'src', kind: 'substantive' }, reason: 'The questionnaire includes this item.' },
  { rel: 'adapted_from', from: ['instrument_item', 'instrument'], to: ['scale', 'source'], dependency: true, downstream: REVIEW, reason: 'Adapted from this validated scale.' },

  // Data
  { rel: 'binds', from: ['dataset_column'], to: ['instrument_item', 'variable'], dependency: true, downstream: REVIEW_INVALIDATE, onLink: { node: 'src', kind: 'structural' }, reason: 'The column holds the responses to this item.' },
  { rel: 'includes', from: ['dataset_version'], to: ['dataset_column'], dependency: true, downstream: INFO_INVALIDATE, reason: 'The dataset version includes this column.' },
  { rel: 'collected_with', from: ['dataset_version'], to: ['instrument'], dependency: true, downstream: INFO, reason: 'The data were collected with an earlier wording of the questionnaire.' },
  { rel: 'applies_to', from: ['transform_step'], to: ['dataset_column'], dependency: true, downstream: REVIEW_INVALIDATE, reason: 'The cleaning step operates on this column.' },
  { rel: 'transformed_by', from: ['dataset_version'], to: ['transform_step'], dependency: true, downstream: REVIEW_INVALIDATE, reason: 'The dataset version was produced by this cleaning step.' },
  { rel: 'derived_from', from: ['dataset_version'], to: ['dataset_version'], dependency: true, downstream: REVIEW_INVALIDATE, reason: 'Derived from this dataset version.' },
  { rel: 'version_of', from: ['dataset_version'], to: ['dataset'], dependency: false, reason: 'A version of this dataset.' },

  // Analysis
  { rel: 'specifies', from: ['analysis'], to: ['conceptual_model', 'hypothesis'], dependency: true, downstream: REVIEW_INVALIDATE, onLink: { node: 'src', kind: 'structural' }, reason: 'The analysis is built from this.' },
  { rel: 'uses_column', from: ['analysis'], to: ['dataset_column'], dependency: true, downstream: REVIEW_INVALIDATE, onLink: { node: 'src', kind: 'structural' }, reason: 'The analysis uses this variable.' },
  { rel: 'executes', from: ['analysis_run'], to: ['analysis'], dependency: true, downstream: REVIEW_INVALIDATE, provenance: true, engineOnly: true, reason: 'The run executed this version of the analysis.' },
  { rel: 'uses_data', from: ['analysis_run'], to: ['dataset_version'], dependency: true, downstream: REVIEW_INVALIDATE, provenance: true, engineOnly: true, reason: 'The run used this dataset version.' },
  { rel: 'produced_by', from: RESULTS, to: ['analysis_run'], dependency: true, downstream: REVIEW_INVALIDATE, provenance: true, engineOnly: true, reason: 'Produced by this run.' },
  { rel: 'contains_value', from: ['result_table', 'figure'], to: ['result_value'], dependency: true, downstream: REVIEW_INVALIDATE, provenance: true, reason: 'The table or figure shows this value.' },
  { rel: 'tests', from: ['result_value'], to: ['hypothesis'], dependency: true, downstream: REVIEW_INVALIDATE, propagate: false, annotation: true, reason: 'This value decides the hypothesis.' },
  { rel: 'interprets', from: ['interpretation'], to: [...RESULTS], dependency: true, downstream: REVIEW_INVALIDATE, reason: 'The interpretation is of this result.' },

  // Literature
  { rel: 'extracted_from', from: ['evidence'], to: ['source'], dependency: true, downstream: REVIEW_INVALIDATE, provenance: true, reason: 'The evidence was extracted from this source.' },
  { rel: 'supports', from: ['evidence'], to: ['hypothesis', 'construct', 'citation', 'claim'], dependency: false, reason: 'Supporting evidence.' },
  { rel: 'contradicts', from: ['evidence'], to: ['hypothesis', 'construct', 'citation', 'claim'], dependency: false, reason: 'Contradicting evidence.' },
  { rel: 'of_source', from: ['citation'], to: ['source'], dependency: true, downstream: REVIEW_INVALIDATE, provenance: true, reason: 'The citation refers to this source.' },
  { rel: 'about', from: ['citation'], to: ['construct', 'hypothesis'], dependency: true, downstream: REVIEW, reason: 'The cited claim is about this.' },

  // Manuscript
  { rel: 'has_block', from: ['section'], to: ['block'], dependency: true, downstream: REVIEW, container: true, reason: 'The section contains this text.' },
  { rel: 'asserts', from: ['block'], to: ['claim'], dependency: true, downstream: REVIEW_INVALIDATE, container: true, reason: 'The text makes this claim.' },
  { rel: 'reports', from: TEXT, to: [...RESULTS], dependency: true, downstream: REVIEW_INVALIDATE, provenance: true, reason: 'The text reports this result.' },
  { rel: 'cites', from: TEXT, to: ['citation'], dependency: true, downstream: REVIEW_INVALIDATE, provenance: true, reason: 'The text cites this.' },
  { rel: 'supported_by', from: ['claim'], to: ['evidence'], dependency: true, downstream: REVIEW_INVALIDATE, provenance: true, reason: 'The claim rests on this evidence.' },
  { rel: 'presents', from: TEXT, to: ['interpretation'], dependency: true, downstream: REVIEW_INVALIDATE, reason: 'The text presents this interpretation.' },
  { rel: 'describes', from: TEXT, to: ['construct', 'hypothesis', 'analysis', 'instrument', 'instrument_item', 'conceptual_model', 'dataset_version'], dependency: true, downstream: REVIEW, reason: 'The text describes this.' },
  { rel: 'summarizes', from: TEXT, to: ['section', 'block'], dependency: true, downstream: REVIEW, reason: 'The text summarises this.' },
  { rel: 'refers_to', from: TEXT, to: ['section', 'block', ...RESULTS], dependency: true, downstream: REVIEW, reason: 'The text cross-references this.' },
  { rel: 'part_of', from: ['section'], to: ['manuscript'], dependency: false, reason: 'Structure.' },
  { rel: 'targets', from: ['manuscript'], to: ['journal_target'], dependency: true, downstream: REVIEW, reason: 'Formatted for this journal.' },

  // Publication and reproducibility
  { rel: 'snapshot_of', from: ['submission'], to: ['manuscript', 'section'], dependency: true, downstream: INFO, reason: 'The submitted snapshot predates this change.' },
  { rel: 'responds_to', from: ['response'], to: ['reviewer_comment'], dependency: false, reason: 'Answers this reviewer comment.' },
  { rel: 'changes', from: ['response'], to: ['block', 'section'], dependency: true, downstream: REVIEW, reason: 'The response points at this text.' },
  { rel: 'supersedes', from: NODE_TYPES, to: NODE_TYPES, dependency: false, managed: true, reason: 'Replaces an earlier object of the same type.' },
  { rel: 'packages', from: ['repro_package'], to: ['analysis_run', 'dataset_version', 'manuscript'], dependency: true, downstream: REVIEW_INVALIDATE, reason: 'Included in the reproducibility package.' },
];

const BY_REL = new Map(EDGE_RULES.map((rule) => [rule.rel, rule]));

export function ruleFor(rel: string): EdgeRule | undefined {
  return BY_REL.get(rel);
}

/** Relations whose removal leaves the source untraced. */
export const PROVENANCE_RELS: ReadonlySet<string> = new Set(EDGE_RULES.filter((rule) => rule.provenance).map((rule) => rule.rel));

/**
 * The change a flagged node passes on to what depends on it.
 *
 * Only invalidation is a fact that travels: an invalid run makes its results
 * invalid. `review` asks a person to look at that one object; if they then
 * change it, that change runs its own impact analysis. Meanwhile everything
 * downstream of it reads as provisional (`currency.ts`). A container passes on
 * what its part received.
 */
export function propagatedKind(severity: Severity, incoming: ChangeKind, rule: EdgeRule): ChangeKind | null {
  if (rule.propagate === false) return null;
  if (rule.container) return incoming;
  if (severity === 'invalidates') return 'structural';
  return null;
}
