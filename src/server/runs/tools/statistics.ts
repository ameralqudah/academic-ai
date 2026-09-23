/**
 * Statistics tools: adapters over the P1-C service (the only statistics
 * authority). No adapter computes, rounds or alters a number; results are
 * read from the stored run exactly as the engine wrote them.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { MethodSpec } from '@/analysis/engine/spec';
import { db } from '@/server/db';
import { datasetVersions, statRuns } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import { analysisCost, createSpec, getProvenance, getRun, INLINE_COST_LIMIT, requireSpec, startRun, validateSpecRecord } from '@/server/stats/runs';

import { defineRunTool } from '../types';

const id = z.string().min(1).max(64);
const record = z.record(z.string(), z.unknown());
const issue = (i: { code: string; severity: string; columns?: string[]; message: string }) => ({ code: i.code, severity: i.severity, columns: i.columns ?? [], message: i.message });
const actor = (ctx: { userId: string }) => ({ userId: ctx.userId });

export const createAnalysisSpec = defineRunTool({
  name: 'createAnalysisSpec',
  version: '1.0.0',
  description: 'Propose an analysis on a dataset version as a structured specification. Only columns of that version may be named.',
  category: 'statistics',
  input: z.object({ datasetVersionId: id, label: z.string().max(200).optional(), spec: record, hypothesisIds: z.array(id).max(20).optional() }).strict(),
  output: z.object({ specId: id, spec: record, runnable: z.boolean(), issues: z.array(record).max(200) }).strict(),
  sideEffect: 'compute',
  risk: 'low',
  requiredRole: 'EDITOR',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run', 'assistant'],
  timeoutMs: 30_000,
  maxAttempts: 2,
  idempotency: 'keyed',
  estimatedModelCalls: 0,
  resources: (input) => [{ kind: 'datasetVersion', id: input.datasetVersionId }],
  approval: async () => null,
  async execute(input, ctx) {
    const spec = await createSpec(actor(ctx), {
      projectId: ctx.projectId,
      datasetVersionId: input.datasetVersionId,
      spec: input.spec,
      label: input.label ?? null,
      hypothesisIds: input.hypothesisIds ?? [],
      origin: 'assistant',
      idempotencyKey: ctx.idempotencyKey,
    });
    const check = await validateSpecRecord(actor(ctx), spec.id, ctx.projectId);
    return {
      output: { specId: spec.id, spec: spec.spec, runnable: check.runnable, issues: [...check.specification, ...check.dataset].slice(0, 200).map(issue) },
      ref: { kind: 'stat_spec', id: spec.id },
    };
  },
});

export const validateAnalysisSpec = defineRunTool({
  name: 'validateAnalysisSpec',
  version: '1.0.0',
  description: 'Check whether a specification can run on its data: returns data-quality and specification issues with severities.',
  category: 'statistics',
  input: z.object({ specId: id }).strict(),
  output: z.object({ runnable: z.boolean(), issues: z.array(record).max(200) }).strict(),
  sideEffect: 'read',
  risk: 'low',
  requiredRole: 'VIEWER',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run', 'assistant'],
  timeoutMs: 30_000,
  maxAttempts: 2,
  idempotency: 'natural',
  estimatedModelCalls: 0,
  resources: (input) => [{ kind: 'spec', id: input.specId }],
  approval: async () => null,
  async execute(input, ctx) {
    const check = await validateSpecRecord(actor(ctx), input.specId, ctx.projectId);
    return { output: { runnable: check.runnable, issues: [...check.specification, ...check.dataset].slice(0, 200).map(issue) } };
  },
});

/** How long a run step waits for a queued statistics job before its attempt times out. */
const POLL_MS = 1_000;

export const runAnalysis = defineRunTool({
  name: 'runAnalysis',
  version: '1.0.0',
  description: 'Run a validated specification with the deterministic statistics engine. Returns the run id and status.',
  category: 'statistics',
  input: z.object({ specId: id }).strict(),
  output: z.object({ runId: id, status: z.string().max(16), queuedAsJob: z.boolean() }).strict(),
  sideEffect: 'compute',
  risk: 'medium',
  requiredRole: 'EDITOR',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run', 'assistant'],
  timeoutMs: 10 * 60_000,
  maxAttempts: 3,
  idempotency: 'keyed',
  estimatedModelCalls: 0,
  resources: (input) => [{ kind: 'spec', id: input.specId }],
  /* Heavy work (it will run as a background job) is shown to the person first. */
  async approval(input, ctx) {
    const spec = await requireSpec(input.specId, actor(ctx), 'VIEWER', ctx.projectId);
    const [version] = await db.select({ rows: datasetVersions.rowCount, contentHash: datasetVersions.contentHash }).from(datasetVersions).where(eq(datasetVersions.id, spec.datasetVersionId)).limit(1);
    const cost = analysisCost(spec.spec as unknown as MethodSpec, version?.rows ?? 0);
    if (cost <= INLINE_COST_LIMIT) return null;
    return {
      reason: 'expensive_analysis',
      summary: {
        en: `Run a ${spec.analysisType} analysis that is expensive enough to run as a background job.`,
        ar: `تشغيل تحليل ${spec.analysisType} مكلف يعمل في الخلفية.`,
      },
      targets: { specHash: spec.specHash, datasetContentHash: version?.contentHash ?? '' },
      preview: { analysisType: spec.analysisType, rows: version?.rows ?? 0, costUnits: Math.round(cost), inlineLimit: INLINE_COST_LIMIT },
    };
  },
  async execute(input, ctx) {
    /* The step's key is the run's idempotency key: a retried step returns the same statistics run. */
    const run = await startRun(actor(ctx), input.specId, { projectId: ctx.projectId, idempotencyKey: ctx.idempotencyKey });
    let status = run.status;
    /* A queued job is awaited here (the step itself runs in a background job), so later steps read a finished result. */
    while ((status === 'queued' || status === 'running') && !ctx.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const [row] = await db.select({ status: statRuns.status }).from(statRuns).where(eq(statRuns.id, run.id)).limit(1);
      status = row?.status ?? status;
    }
    if (status === 'queued' || status === 'running') throw new AppError('CONFLICT', 'The analysis is still running.', 'التحليل لا يزال قيد التشغيل.', { reason: 'still_running' });
    return { output: { runId: run.id, status, queuedAsJob: Boolean(run.jobId) }, ref: { kind: 'stat_run', id: run.id } };
  },
});

export const getAnalysisResult = defineRunTool({
  name: 'getAnalysisResult',
  version: '1.0.0',
  description: 'Read the verified estimates of a run (keys, values, SE, test statistics, p, CI) and its issues.',
  category: 'statistics',
  input: z.object({ runId: id }).strict(),
  output: z.object({ runId: id, status: z.string(), verified: z.boolean(), method: z.string().nullable(), n: z.number().nullable(), estimates: z.array(record).max(120), issues: z.array(record).max(200) }).strict(),
  sideEffect: 'read',
  risk: 'low',
  requiredRole: 'VIEWER',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run', 'assistant'],
  timeoutMs: 30_000,
  maxAttempts: 2,
  idempotency: 'natural',
  estimatedModelCalls: 0,
  resources: (input) => [{ kind: 'statRun', id: input.runId }],
  approval: async () => null,
  async execute(input, ctx) {
    const { run, estimates, verified } = await getRun(actor(ctx), input.runId, ctx.projectId);
    return {
      output: {
        runId: run.id,
        status: run.status,
        verified,
        method: run.method,
        n: run.nUsed,
        estimates: estimates.slice(0, 120).map((e) => ({ key: e.key, label: e.label, estimate: e.estimate, se: e.se, statistic: e.statistic, statisticName: e.statisticName, df: e.df, df2: e.df2, p: e.p, ciLow: e.ciLow, ciHigh: e.ciHigh })),
        issues: (run.issues as { code: string; severity: string; message: string }[]).slice(0, 200).map(({ code, severity, message }) => ({ code, severity, message })),
      },
      ref: { kind: 'stat_run', id: run.id },
    };
  },
});

export const getAnalysisProvenance = defineRunTool({
  name: 'getAnalysisProvenance',
  version: '1.0.0',
  description: 'Where the numbers of a run came from: engine and version, specification, dataset version and its transformations.',
  category: 'statistics',
  input: z.object({ runId: id }).strict(),
  output: record,
  sideEffect: 'read',
  risk: 'low',
  requiredRole: 'VIEWER',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run', 'assistant'],
  timeoutMs: 30_000,
  maxAttempts: 2,
  idempotency: 'natural',
  estimatedModelCalls: 0,
  resources: (input) => [{ kind: 'statRun', id: input.runId }],
  approval: async () => null,
  async execute(input, ctx) {
    return { output: (await getProvenance(actor(ctx), input.runId, ctx.projectId)) as unknown as Record<string, unknown>, ref: { kind: 'stat_run', id: input.runId } };
  },
});

export const generateTableFromResult = defineRunTool({
  name: 'generateTableFromResult',
  version: '1.0.0',
  description: 'The formatted tables generated from a run’s stored estimates.',
  category: 'statistics',
  input: z.object({ runId: id }).strict(),
  output: z.object({ tables: z.array(z.unknown()).max(50) }).strict(),
  sideEffect: 'read',
  risk: 'low',
  requiredRole: 'VIEWER',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run', 'assistant'],
  timeoutMs: 30_000,
  maxAttempts: 2,
  idempotency: 'natural',
  estimatedModelCalls: 0,
  resources: (input) => [{ kind: 'statRun', id: input.runId }],
  approval: async () => null,
  async execute(input, ctx) {
    const { tables } = await getRun(actor(ctx), input.runId, ctx.projectId);
    return { output: { tables: tables.slice(0, 50).map((table) => table.content) }, ref: { kind: 'stat_run', id: input.runId } };
  },
});

export const generateFigureFromResult = defineRunTool({
  name: 'generateFigureFromResult',
  version: '1.0.0',
  description: 'The figures generated from a run’s stored estimates.',
  category: 'statistics',
  input: z.object({ runId: id }).strict(),
  output: z.object({ figures: z.array(record).max(50) }).strict(),
  sideEffect: 'read',
  risk: 'low',
  requiredRole: 'VIEWER',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run', 'assistant'],
  timeoutMs: 30_000,
  maxAttempts: 2,
  idempotency: 'natural',
  estimatedModelCalls: 0,
  resources: (input) => [{ kind: 'statRun', id: input.runId }],
  approval: async () => null,
  async execute(input, ctx) {
    const { figures } = await getRun(actor(ctx), input.runId, ctx.projectId);
    return { output: { figures: figures.slice(0, 50).map((figure) => ({ id: figure.id, kind: figure.kind, title: figure.title, keys: figure.keys })) }, ref: { kind: 'stat_run', id: input.runId } };
  },
});

export const STATISTICS_TOOLS = [createAnalysisSpec, validateAnalysisSpec, runAnalysis, getAnalysisResult, getAnalysisProvenance, generateTableFromResult, generateFigureFromResult];
