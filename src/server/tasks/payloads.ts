/**
 * What sits inside each output type.
 *
 * `OutputReference.data` is `unknown` by design — the reference layer moves
 * payloads around and should not know their shapes. This is where the shapes
 * are declared, so a producer and a consumer of `sources.v1` agree on what that
 * means without either importing the other.
 *
 * **One file, deliberately.** A payload defined next to its producer would be
 * imported by every consumer, and the import graph would end up recreating the
 * capability-name coupling the output types exist to remove.
 *
 * **Versioned by the type name.** `sources.v1` is this shape; a breaking change
 * becomes `sources.v2` alongside it, and old task outputs keep parsing. That is
 * the whole versioning story — enough that a change cannot silently corrupt a
 * finished task, and no migration framework.
 */

import type { Reference } from '@/server/quality/sources';
import type { QualityReport } from '@/server/quality/engine';

/** `sources.v1` — retrieved sources, from any search capability. */
export interface SourcesPayload {
  references: Reference[];
  /** The query that found them, for provenance and for a replanner. */
  query: string;
  found: number;
  /**
   * True when the results do not appear to concern the query.
   *
   * Carried in the payload rather than as a warning because a consumer decides
   * differently on it: a literature review refuses, a citation check does not
   * care.
   */
  offTopic: boolean;
  discarded: number;
}

/** `literature.v1` — a synthesised review, with what it was built from. */
export interface LiteraturePayload {
  text: string;
  heading?: string;
  references: Reference[];
  /** What the literature did not answer. Feeds a gap analysis. */
  gaps: string[];
}

/** `research-gap.v1` */
export interface ResearchGapPayload {
  gaps: { statement: string; supportedBy: string[] }[];
}

/** `framework.v1` — constructs and their proposed relations. */
export interface FrameworkPayload {
  constructs: { name: string; definition?: string }[];
  relations: { from: string; to: string; rationale?: string }[];
}

/**
 * `hypotheses.v1`
 *
 * Each hypothesis names the constructs it relates, which is what lets a PLS
 * model be *proposed* from them rather than guessed.
 */
export interface HypothesesPayload {
  hypotheses: {
    id: string;
    statement: string;
    from: string;
    to: string;
    direction?: 'positive' | 'negative';
    /** A moderator or mediator, when the hypothesis names one. */
    moderator?: string;
  }[];
}

/** `dataset.v1` — a dataset's shape, not its rows. */
export interface DatasetPayload {
  datasetId: string;
  rowCount: number;
  columns: { name: string; type: string; scale: string; missing: number }[];
}

/** `analysis.v1` — any statistical result, with its own payload inside. */
export interface AnalysisPayload {
  /** Which analysis: 'reliability', 'compare', 'relate', … */
  kind: string;
  /** The engine's own result, preserved rather than flattened. */
  result: unknown;
  n: number;
}

/**
 * `pls-model.v1` — a model proposed but not yet run.
 *
 * The type exists to make the confirmation step explicit. A model is the
 * researcher's theory; the agent may infer one from hypotheses and must present
 * it, and a separate output type is what forces that into the plan rather than
 * leaving it to a handler's good intentions.
 */
export interface PlsModelPayload {
  constructs: { name: string; indicators: string[]; mode: 'reflective' | 'formative' }[];
  paths: { from: string; to: string }[];
  /** Where each construct's indicators came from, so the researcher can check. */
  derivation: { construct: string; matchedBy: string; from?: string }[];
  /** True once the researcher has said yes. Nothing runs until it is. */
  confirmed: boolean;
}

/** `pls-results.v1` */
export interface PlsResultsPayload {
  verdict: { severity: string; key: string };
  sections: { titleKey: string; findings: number }[];
  n: number;
  /** The model that produced them, so results are never orphaned from theory. */
  model: PlsModelPayload;
}

/** `prose.v1` — written text for a document or a chapter. */
export interface ProsePayload {
  text: string;
  heading?: string;
  /** What it cites, so a document can assemble a reference list. */
  references: Reference[];
  /** Which section of a document this is, when it is one. */
  section?: string;
}

/** `citations.v1` — references with their verification status. */
export interface CitationsPayload {
  checked: number;
  verified: number;
  notFound: number;
  /** Unreachable rather than unregistered — not a finding against the source. */
  unchecked: number;
  status: 'pass' | 'attention' | 'fail' | 'not-applicable';
}

/** `quality-report.v1` — the quality engine's verdict, unflattened. */
export interface QualityPayload {
  report: QualityReport;
  status: QualityReport['overallStatus'];
}

/** `survey.v1` */
export interface SurveyPayload {
  text: string;
  constructs: string[];
}

/** `artifact.v1` — a generated file. */
export interface ArtifactPayload {
  artifactId: string;
  filename: string;
  kind: string;
  version: number;
  validationStatus: string;
  /** Present when the format asked for was not the format produced. */
  requestedFormat?: string;
}

/**
 * The payload type for an output type.
 *
 * A lookup rather than a generic parameter on `OutputReference`: the reference
 * travels through code that does not know or care what is inside it, and
 * threading a type parameter through all of it would infect the executor with
 * every payload shape.
 */
export interface PayloadFor {
  'sources.v1': SourcesPayload;
  'literature.v1': LiteraturePayload;
  'research-gap.v1': ResearchGapPayload;
  'framework.v1': FrameworkPayload;
  'hypotheses.v1': HypothesesPayload;
  'dataset.v1': DatasetPayload;
  'analysis.v1': AnalysisPayload;
  'pls-model.v1': PlsModelPayload;
  'pls-results.v1': PlsResultsPayload;
  'prose.v1': ProsePayload;
  'citations.v1': CitationsPayload;
  'quality-report.v1': QualityPayload;
  'survey.v1': SurveyPayload;
  'artifact.v1': ArtifactPayload;
  'generic.v1': Record<string, unknown>;
}
