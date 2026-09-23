/**
 * Data tools: adapters over P1-C dataset versions. Rows never leave the
 * server; tools return names, counts, types and issues.
 */

import { z } from 'zod';

import { previewVersionReplacement, replaceVersion } from '@/server/stats/graph';
import { listProjectDatasets, qualityReport, requireVersion, transformSchema, transformVersion } from '@/server/stats/versions';

import { defineRunTool } from '../types';

const id = z.string().min(1).max(64);
const record = z.record(z.string(), z.unknown());
const actor = (ctx: { userId: string }) => ({ userId: ctx.userId });

/** A transformation report as stored on the step: whole when small, otherwise its top-level shape only. */
function boundedReport(report: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') <= 20_000) return report;
  return { truncated: true, keys: Object.keys(report).slice(0, 50), note: 'The full report is stored with the dataset version’s transformation.' };
}

export const listDatasets = defineRunTool({
  name: 'listDatasets',
  version: '1.0.0',
  description: 'The project’s datasets and their versions (ids, row counts, content hashes).',
  category: 'data',
  input: z.object({}).strict(),
  output: z.object({ datasets: z.array(record).max(200) }).strict(),
  sideEffect: 'read',
  risk: 'low',
  requiredRole: 'VIEWER',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run'],
  timeoutMs: 30_000,
  maxAttempts: 2,
  idempotency: 'natural',
  estimatedModelCalls: 0,
  resources: () => [],
  approval: async () => null,
  async execute(_input, ctx) {
    const datasets = await listProjectDatasets(actor(ctx), ctx.projectId);
    return {
      output: {
        datasets: datasets.slice(0, 200).map((dataset) => ({
          id: dataset.id,
          name: dataset.name,
          rows: dataset.rows,
          columns: dataset.columns,
          versions: dataset.versions.slice(-20).map((version) => ({ id: version.id, versionNo: version.versionNo, rows: version.rows, contentHash: version.contentHash })),
        })),
      },
    };
  },
});

export const inspectDataset = defineRunTool({
  name: 'inspectDataset',
  version: '1.0.0',
  description: 'A dataset version’s columns (names, declared types, ranges) and size. No rows are returned.',
  category: 'data',
  input: z.object({ datasetVersionId: id }).strict(),
  output: z.object({ datasetVersionId: id, versionNo: z.number(), rows: z.number(), contentHash: z.string(), columns: z.array(record).max(500) }).strict(),
  sideEffect: 'read',
  risk: 'low',
  requiredRole: 'VIEWER',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run'],
  timeoutMs: 30_000,
  maxAttempts: 2,
  idempotency: 'natural',
  estimatedModelCalls: 0,
  resources: (input) => [{ kind: 'datasetVersion', id: input.datasetVersionId }],
  approval: async () => null,
  async execute(input, ctx) {
    const version = await requireVersion(input.datasetVersionId, actor(ctx), 'VIEWER', ctx.projectId);
    return {
      output: {
        datasetVersionId: version.id,
        versionNo: version.versionNo,
        rows: version.rowCount,
        contentHash: version.contentHash,
        columns: (version.columns as Record<string, unknown>[]).slice(0, 500),
      },
      ref: { kind: 'dataset_version', id: version.id },
    };
  },
});

export const validateDataset = defineRunTool({
  name: 'validateDataset',
  version: '1.0.0',
  description: 'The data-quality report of a dataset version: missing values, invalid cells, outliers, ranges, with severities.',
  category: 'data',
  input: z.object({ datasetVersionId: id }).strict(),
  output: z.object({ datasetVersionId: id, issues: z.array(record).max(300) }).strict(),
  sideEffect: 'read',
  risk: 'low',
  requiredRole: 'VIEWER',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run'],
  timeoutMs: 60_000,
  maxAttempts: 2,
  idempotency: 'natural',
  estimatedModelCalls: 0,
  resources: (input) => [{ kind: 'datasetVersion', id: input.datasetVersionId }],
  approval: async () => null,
  async execute(input, ctx) {
    const report = await qualityReport(actor(ctx), input.datasetVersionId, ctx.projectId);
    return {
      output: {
        datasetVersionId: report.version.id,
        issues: report.issues.slice(0, 300).map((issue) => ({ code: issue.code, severity: issue.severity, columns: issue.columns, message: issue.message, details: issue.details ?? {} })),
      },
      ref: { kind: 'dataset_version', id: report.version.id },
    };
  },
});

/** Cleaning actions that remove rows or replace values: a person sees them before they happen. */
const CHANGES_DATA = new Set(['drop-duplicate-rows', 'drop-rows-missing', 'remove-outliers', 'impute-mean', 'impute-median', 'impute-mode', 'drop-empty-columns', 'drop-constant-columns']);

export const createDatasetVersion = defineRunTool({
  name: 'createDatasetVersion',
  version: '1.0.0',
  description: 'Create a new dataset version from an existing one by a recorded transformation (declare column types, or clean). The input version is never changed.',
  category: 'data',
  input: z.object({ datasetVersionId: id, transformation: transformSchema }).strict(),
  output: z.object({ datasetVersionId: id, versionNo: z.number(), rows: z.number(), contentHash: z.string(), report: record }).strict(),
  sideEffect: 'write',
  risk: 'medium',
  requiredRole: 'EDITOR',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run'],
  timeoutMs: 120_000,
  maxAttempts: 2,
  idempotency: 'keyed',
  estimatedModelCalls: 0,
  resources: (input) => [{ kind: 'datasetVersion', id: input.datasetVersionId }],
  async approval(input, ctx) {
    const transformation = input.transformation as { operation: string; actions?: { kind: string; columns: string[] }[] };
    if (transformation.operation !== 'clean') return null;
    const changing = (transformation.actions ?? []).filter((action) => CHANGES_DATA.has(action.kind));
    if (changing.length === 0) return null;
    const version = await requireVersion(input.datasetVersionId, actor(ctx), 'VIEWER', ctx.projectId);
    return {
      reason: 'data_changing_transformation',
      summary: {
        en: `Create version ${version.versionNo + 1} of the dataset by ${changing.map((action) => action.kind).join(', ')} (rows or values change; version ${version.versionNo} is kept).`,
        ar: `إنشاء إصدار جديد من البيانات بعملية ${changing.map((action) => action.kind).join('، ')} (تتغيّر صفوف أو قيم؛ يبقى الإصدار ${version.versionNo}).`,
      },
      targets: { inputContentHash: version.contentHash, inputVersionId: version.id },
      preview: { actions: changing.slice(0, 20) },
    };
  },
  async execute(input, ctx) {
    const { version, report } = await transformVersion(actor(ctx), input.datasetVersionId, input.transformation as never, ctx.projectId, { idempotencyKey: ctx.idempotencyKey });
    return {
      output: { datasetVersionId: version.id, versionNo: version.versionNo, rows: version.rowCount, contentHash: version.contentHash, report: boundedReport(report) },
      ref: { kind: 'dataset_version', id: version.id },
    };
  },
});

export const replaceDatasetVersion = defineRunTool({
  name: 'replaceDatasetVersion',
  version: '1.0.0',
  description: 'Declare that a newer version replaces an older one of the same dataset. Every analysis and claim built on the old version becomes not current. Always needs approval.',
  category: 'data',
  input: z.object({ oldVersionId: id, newVersionId: id }).strict(),
  output: z.object({ replaced: z.boolean(), impactHash: z.string(), affected: z.number() }).strict(),
  sideEffect: 'destructive',
  risk: 'high',
  requiredRole: 'EDITOR',
  tiers: ['free', 'paid', 'admin'],
  contexts: ['run'],
  timeoutMs: 60_000,
  maxAttempts: 1,
  idempotency: 'keyed',
  estimatedModelCalls: 0,
  resources: (input) => [
    { kind: 'datasetVersion', id: input.oldVersionId },
    { kind: 'datasetVersion', id: input.newVersionId },
  ],
  async approval(input, ctx) {
    const report = await previewVersionReplacement(actor(ctx), ctx.projectId, input.oldVersionId, input.newVersionId);
    const [older, newer] = await Promise.all([requireVersion(input.oldVersionId, actor(ctx), 'VIEWER', ctx.projectId), requireVersion(input.newVersionId, actor(ctx), 'VIEWER', ctx.projectId)]);
    return {
      reason: 'replaces_data',
      summary: {
        en: `Replace dataset version ${older.versionNo} with version ${newer.versionNo}. ${report.items.length} dependent item(s) will stop being current until re-run.`,
        ar: `استبدال الإصدار ${older.versionNo} بالإصدار ${newer.versionNo}. ${report.items.length} عنصر(ًا) معتمد(ًا) سيصبح غير محدَّث حتى إعادة التشغيل.`,
      },
      targets: { oldContentHash: older.contentHash, newContentHash: newer.contentHash },
      impactHash: report.hash,
      preview: { items: report.items.slice(0, 30).map((item) => ({ nodeId: item.nodeId, type: item.type, severity: item.severity })) },
    };
  },
  async execute(input, ctx) {
    /* The approval covered this Impact Report; the graph re-checks it at commit (P1-A protocol). */
    try {
      const report = await replaceVersion(actor(ctx), ctx.projectId, input.oldVersionId, input.newVersionId, ctx.approvedImpactHash ?? undefined);
      return { output: { replaced: true, impactHash: report.hash, affected: report.items.length }, ref: { kind: 'dataset_version', id: input.newVersionId } };
    } catch (error) {
      /* A retry after the replacement committed: the graph refuses a second supersede; that is this step's own effect. */
      if ((error as { details?: { reason?: string } }).details?.reason === 'already_superseded') {
        return { output: { replaced: true, impactHash: ctx.approvedImpactHash ?? '', affected: 0 }, ref: { kind: 'dataset_version', id: input.newVersionId } };
      }
      throw error;
    }
  },
});

export const DATA_TOOLS = [listDatasets, inspectDataset, validateDataset, createDatasetVersion, replaceDatasetVersion];
