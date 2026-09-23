/**
 * The engine's single entry point: specification + dataset → outcome.
 *
 * 1. The specification is parsed (defaults resolved).
 * 2. It is validated against the data; an ERROR or BLOCKING issue refuses the
 *    run before any number is computed.
 * 3. The method runs. Its own failures (non-identified model, singular matrix)
 *    become a structured failure, not a partial result.
 * 4. The result is checked: a method that reports an ERROR (non-convergence)
 *    fails the run; non-finite numbers are never released as estimates.
 *
 * Pure and deterministic: same (dataset, specification, ENGINE.version) → same
 * result, byte for byte (see `canonicalJson`).
 */

import { methodSpecSchema, type MethodSpec, type MethodSpecInput } from './spec';
import { anova, correlation, descriptives, regression, reliability } from './methods/classical';
import { efa } from './methods/efa';
import { cfa, pls } from './methods/latent';
import { mediation, moderation } from './methods/process';
import { validateSpec } from './validate';
import { blocks, ENGINE, type EngineDataset, type Issue, type NormalisedResult } from './types';

export type EngineOutcome =
  | { status: 'succeeded'; spec: MethodSpec; result: NormalisedResult }
  | { status: 'refused'; spec: MethodSpec | null; issues: Issue[] }
  | { status: 'failed'; spec: MethodSpec; issues: Issue[]; error: { code: string; message: string } };

export function parseSpec(input: MethodSpecInput | unknown): { spec: MethodSpec } | { issues: Issue[] } {
  const parsed = methodSpecSchema.safeParse(input);
  if (parsed.success) return { spec: parsed.data };
  return {
    issues: parsed.error.issues.map((problem) => ({
      code: 'invalid-specification',
      severity: 'ERROR' as const,
      columns: [],
      message: `${problem.path.join('.') || '(specification)'}: ${problem.message}`,
      messageAr: `مواصفة غير صالحة: ${problem.path.join('.')}`,
    })),
  };
}

function compute(spec: MethodSpec, data: EngineDataset): NormalisedResult {
  switch (spec.analysisType) {
    case 'descriptives':
      return descriptives(spec, data);
    case 'reliability':
      return reliability(spec, data);
    case 'correlation':
      return correlation(spec, data);
    case 'regression':
      return regression(spec, data);
    case 'anova':
      return anova(spec, data);
    case 'efa':
      return efa(spec, data);
    case 'cfa':
      return cfa(spec, data);
    case 'pls':
      return pls(spec, data);
    case 'mediation':
      return mediation(spec, data);
    case 'moderation':
      return moderation(spec, data);
  }
}

export function execute(input: MethodSpecInput | unknown, data: EngineDataset): EngineOutcome {
  const parsed = parseSpec(input);
  if ('issues' in parsed) return { status: 'refused', spec: null, issues: parsed.issues };
  const spec = parsed.spec;

  const preflight = validateSpec(spec, data);
  if (blocks(preflight)) return { status: 'refused', spec, issues: preflight };

  let result: NormalisedResult;
  try {
    result = compute(spec, data);
  } catch (error) {
    const code = (error as { reasonKey?: string; code?: string }).reasonKey ?? (error as { code?: string }).code ?? 'engine-error';
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      spec,
      error: { code, message },
      issues: [...preflight, { code: 'estimation-failed', severity: 'ERROR', columns: [], message: `The analysis could not be estimated: ${code}.`, messageAr: 'تعذّر تقدير التحليل.', details: { reason: code } }],
    };
  }

  /* Numbers that are not numbers are not released. */
  const undefinedKeys = result.estimates.filter((estimate) => !Number.isFinite(estimate.estimate)).map((estimate) => estimate.key);
  result.estimates = result.estimates.filter((estimate) => Number.isFinite(estimate.estimate)).map((estimate) => {
    const clean = { ...estimate };
    for (const field of ['se', 'statistic', 'df', 'df2', 'p', 'ciLow', 'ciHigh'] as const) {
      const value = clean[field];
      if (value !== null && value !== undefined && !Number.isFinite(value)) clean[field] = null;
    }
    return clean;
  });
  if (undefinedKeys.length > 0) {
    result.issues.push({ code: 'not-computed', severity: 'INFO', columns: [], message: `Not computable from these data, so not reported: ${undefinedKeys.slice(0, 10).join(', ')}${undefinedKeys.length > 10 ? '…' : ''}.`, messageAr: 'قيم غير قابلة للحساب لم تُبلّغ.', details: { count: undefinedKeys.length } });
  }
  result.issues = [...preflight, ...result.issues];
  result.engine = ENGINE;

  if (blocks(result.issues)) {
    const reason = result.issues.find((entry) => entry.severity === 'ERROR' || entry.severity === 'BLOCKING')!;
    return { status: 'failed', spec, issues: result.issues, error: { code: reason.code, message: reason.message } };
  }
  return { status: 'succeeded', spec, result };
}
