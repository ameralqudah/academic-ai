/**
 * Analysis specifications: the machine-readable statement of what to compute.
 *
 * A specification is complete once parsed: every default is filled in here, so
 * the stored specification is exactly what ran. Randomised methods (bootstrap)
 * must carry an explicit integer seed; the server assigns one before storing
 * when the caller did not, and the seed is part of the specification's hash.
 */

import { z } from 'zod';

const column = z.string().min(1).max(200);
const level = z.number().gt(0.5).lt(1).default(0.95);
const seed = z.number().int().min(1).max(2_147_483_647);

export const ANALYSIS_TYPES = [
  'descriptives',
  'reliability',
  'correlation',
  'regression',
  'anova',
  'efa',
  'cfa',
  'pls',
  'mediation',
  'moderation',
] as const;
export type AnalysisType = (typeof ANALYSIS_TYPES)[number];

const construct = z.object({ name: z.string().min(1).max(80), indicators: z.array(column).min(1).max(30) }).strict();

export const methodSpecSchema = z.discriminatedUnion('analysisType', [
  z.object({ analysisType: z.literal('descriptives'), variables: z.array(column).min(1).max(100) }).strict(),
  z
    .object({
      analysisType: z.literal('reliability'),
      /** The construct the items measure, for labelling (graph construct id optional). */
      construct: z.string().min(1).max(80).default('Scale'),
      items: z.array(column).min(2).max(50),
    })
    .strict(),
  z
    .object({
      analysisType: z.literal('correlation'),
      variables: z.array(column).min(2).max(30),
      method: z.enum(['pearson', 'spearman']).default('pearson'),
      missing: z.enum(['pairwise', 'listwise']).default('pairwise'),
      adjust: z.enum(['none', 'holm', 'bonferroni', 'bh']).default('none'),
      confidenceLevel: level,
    })
    .strict(),
  z
    .object({
      analysisType: z.literal('regression'),
      outcome: column,
      predictors: z.array(column).min(1).max(20),
      confidenceLevel: level,
    })
    .strict(),
  z
    .object({
      analysisType: z.literal('anova'),
      outcome: column,
      group: column,
      /** `auto`: Tukey when variances are homogeneous (Levene), Games-Howell otherwise. */
      postHoc: z.enum(['auto', 'tukey', 'games-howell', 'none']).default('auto'),
      alpha: z.number().gt(0).lt(0.5).default(0.05),
    })
    .strict(),
  z
    .object({
      analysisType: z.literal('efa'),
      items: z.array(column).min(3).max(100),
      extraction: z.enum(['paf', 'pca']).default('paf'),
      rotation: z.enum(['varimax', 'promax', 'none']).default('promax'),
      /** `kaiser`: eigenvalues of the correlation matrix above 1. `fixed`: `nFactors`. */
      retention: z.enum(['kaiser', 'fixed']).default('kaiser'),
      nFactors: z.number().int().min(1).max(20).optional(),
      promaxPower: z.number().int().min(2).max(6).default(4),
    })
    .strict(),
  z.object({ analysisType: z.literal('cfa'), constructs: z.array(construct).min(1).max(20) }).strict(),
  z
    .object({
      analysisType: z.literal('pls'),
      constructs: z.array(construct.extend({ mode: z.enum(['reflective', 'formative']).default('reflective') })).min(2).max(20),
      paths: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) }).strict()).min(1).max(100),
      innerWeighting: z.enum(['path', 'factorial', 'centroid']).default('path'),
      bootstrap: z
        .object({ resamples: z.number().int().min(100).max(10_000).default(5000), seed, confidenceLevel: level })
        .strict()
        .nullable()
        .default(null),
    })
    .strict(),
  z
    .object({
      analysisType: z.literal('mediation'),
      x: column,
      m: column,
      y: column,
      covariates: z.array(column).max(10).default([]),
      bootstrap: z.object({ resamples: z.number().int().min(1000).max(10_000).default(5000), seed, confidenceLevel: level }).strict(),
    })
    .strict(),
  z
    .object({
      analysisType: z.literal('moderation'),
      x: column,
      w: column,
      y: column,
      covariates: z.array(column).max(10).default([]),
      /** Mean-centre X and W before forming the product (recorded; changes b₁ and b₂, never b₃). */
      centering: z.enum(['none', 'mean']).default('mean'),
      confidenceLevel: level,
    })
    .strict(),
]);

export type MethodSpec = z.infer<typeof methodSpecSchema>;
export type MethodSpecInput = z.input<typeof methodSpecSchema>;

/** Every column a specification reads, in a stable order. */
export function columnsOf(spec: MethodSpec): string[] {
  switch (spec.analysisType) {
    case 'descriptives':
    case 'correlation':
      return [...spec.variables];
    case 'reliability':
    case 'efa':
      return [...spec.items];
    case 'regression':
      return [spec.outcome, ...spec.predictors];
    case 'anova':
      return [spec.outcome, spec.group];
    case 'cfa':
    case 'pls':
      return spec.constructs.flatMap((entry) => entry.indicators);
    case 'mediation':
      return [spec.x, spec.m, spec.y, ...spec.covariates];
    case 'moderation':
      return [spec.x, spec.w, spec.y, ...spec.covariates];
  }
}

/** Whether a specification needs a seed, and so must carry one. */
export function isRandomised(spec: MethodSpecInput): boolean {
  return spec.analysisType === 'mediation' || (spec.analysisType === 'pls' && Boolean(spec.bootstrap));
}
