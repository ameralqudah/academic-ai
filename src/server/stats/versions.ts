/**
 * Dataset versions and the transformations between them (P1-C).
 *
 *   upload ──import──▶ v1 ──clean──▶ v2 ──set-schema──▶ v3 …
 *
 * - A version is immutable (database trigger) and identified by the SHA-256 of
 *   its cell content, the SHA-256 of its declared schema, and the SHA-256 of the
 *   stored file's bytes. Loading re-checks the file bytes and the content: a
 *   version whose file changed underneath it refuses to load.
 * - Every version after the first is produced by a recorded, deterministic
 *   transformation with its parameters and report. Nothing is deleted or
 *   imputed without a transformation that says so.
 * - Declaring a column's type, scale bounds or missing codes is itself a
 *   transformation (`set-schema`): the cells stay, the schema changes, and runs
 *   on the old schema stay pinned to the old version.
 */

import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { applyCleaning } from '@/analysis/clean';
import { ENGINE, type ColumnSchema, type EngineDataset } from '@/analysis/engine/types';
import { validateDataset } from '@/analysis/engine/validate';
import { parseCsv } from '@/analysis/parse';
import { profileDataset } from '@/analysis/profile';
import { toCsv } from '@/analysis/serialize';
import type { CleaningAction, Dataset, DatasetProfile } from '@/analysis/types';
import { logger } from '@/lib/logger';
import { db } from '@/server/db';
import { datasets, datasetTransformations, datasetVersions, type DatasetVersion } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import { checksumOf, datasetVersionKey, storageProvider } from '@/server/storage';

import { authorise, hashOf, sameProject, sha256, type Need, type StatsActor } from './access';

type DatasetRow = typeof datasets.$inferSelect;

/* -------------------------------------------------------------------------- */
/*                                   Schema                                   */
/* -------------------------------------------------------------------------- */

const TYPE_FROM_PROFILE: Record<string, ColumnSchema['type']> = {
  numeric: 'numeric',
  integer: 'numeric',
  likert: 'ordinal',
  binary: 'binary',
  categorical: 'nominal',
  date: 'date',
  text: 'text',
  empty: 'text',
};

/** The inferred schema of a freshly read dataset. Inferred once, recorded, and changed only by `set-schema`. */
export function inferredSchema(profile: DatasetProfile): ColumnSchema[] {
  return profile.columns.map((column) => ({ name: column.name, type: TYPE_FROM_PROFILE[column.type] ?? 'text' }));
}

/** Canonical content: column names and cells exactly as read. Formatting of the CSV does not enter it. */
export function contentHashOf(data: Pick<Dataset, 'columns' | 'rows'>): string {
  return hashOf({ columns: data.columns, rows: data.rows });
}

export const columnSchemaSchema = z
  .object({
    name: z.string().min(1).max(200),
    type: z.enum(['numeric', 'ordinal', 'nominal', 'binary', 'text', 'date']),
    scaleMin: z.number().finite().nullable().optional(),
    scaleMax: z.number().finite().nullable().optional(),
    missingCodes: z.array(z.union([z.string().max(50), z.number().finite()])).max(20).optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*                                   Access                                   */
/* -------------------------------------------------------------------------- */

export async function requireDataset(datasetId: string, actor: StatsActor, need: Need, projectId?: string | null): Promise<DatasetRow> {
  const [row] = await db.select().from(datasets).where(eq(datasets.id, datasetId)).limit(1);
  if (row && row.deletedAt) throw new AppError('NOT_FOUND', 'The dataset was not found.', 'لم يُعثر على مجموعة البيانات.');
  await authorise(row, actor, need, 'dataset');
  sameProject(row!, projectId, 'dataset');
  return row!;
}

export async function requireVersion(versionId: string, actor: StatsActor, need: Need, projectId?: string | null): Promise<DatasetVersion> {
  const [row] = await db.select().from(datasetVersions).where(eq(datasetVersions.id, versionId)).limit(1);
  await authorise(row, actor, need, 'dataset version');
  sameProject(row!, projectId, 'dataset version');
  return row!;
}

/* -------------------------------------------------------------------------- */
/*                                  Reading                                   */
/* -------------------------------------------------------------------------- */

async function readStored(storageKey: string): Promise<{ bytes: Uint8Array; data: Dataset }> {
  const bytes = (await storageProvider().get(storageKey)).bytes;
  const text = new TextDecoder().decode(bytes);
  return { bytes, data: parseCsv(text, storageKey, ',') };
}

export class VersionIntegrityError extends AppError {
  constructor(what: string) {
    super('CONFLICT', `The stored data for this version no longer matches its record (${what}); it will not be analysed.`, 'البيانات المحفوظة لهذا الإصدار لا تطابق سجلّه؛ لن تُحلَّل.', { reason: 'version_integrity' });
  }
}

/**
 * The exact rows of a version, as the engine sees them. The file's bytes and
 * the parsed content are both checked against the version's hashes first.
 */
export async function loadVersion(version: DatasetVersion): Promise<EngineDataset> {
  const { bytes, data } = await readStored(version.storageKey);
  if (checksumOf(bytes) !== version.fileChecksum) throw new VersionIntegrityError('file checksum');
  if (contentHashOf(data) !== version.contentHash) throw new VersionIntegrityError('content hash');
  return {
    columns: version.columns as unknown as ColumnSchema[],
    rows: data.rows.map((row) => row.map((cell) => (typeof cell === 'boolean' ? String(cell) : cell))),
  };
}

export async function qualityReport(actor: StatsActor, versionId: string, projectId?: string | null) {
  const version = await requireVersion(versionId, actor, 'VIEWER', projectId);
  const data = await loadVersion(version);
  return { version, issues: validateDataset(data) };
}

/* -------------------------------------------------------------------------- */
/*                                  Version 1                                 */
/* -------------------------------------------------------------------------- */

async function insertVersion(values: typeof datasetVersions.$inferInsert, transformation: Omit<typeof datasetTransformations.$inferInsert, 'outputVersionId'>) {
  return db.transaction(async (tx) => {
    const [version] = await tx.insert(datasetVersions).values(values).returning();
    await tx.insert(datasetTransformations).values({ ...transformation, outputVersionId: version!.id });
    return version!;
  });
}

/**
 * Version 1 of a dataset, created from its stored file the first time it is
 * needed (uploads made before P1-C get theirs on first use). Idempotent and
 * safe under concurrency: a second creator loses the unique index and reads
 * the winner's row.
 */
export async function ensureInitialVersion(row: DatasetRow, readReport?: Partial<Pick<Dataset, 'skippedRows' | 'raggedRows' | 'missingMarkers' | 'truncatedTo'>>): Promise<DatasetVersion> {
  const existing = await db
    .select()
    .from(datasetVersions)
    .where(and(eq(datasetVersions.datasetId, row.id), eq(datasetVersions.versionNo, 1)))
    .limit(1);
  if (existing[0]) return existing[0];

  const { bytes, data } = await readStored(row.storageKey);
  const profile = profileDataset(data);
  const columns = inferredSchema(profile);
  const legacyClean = row.kind === 'CLEANED';
  try {
    return await insertVersion(
      {
        datasetId: row.id,
        userId: row.userId,
        projectId: row.projectId,
        versionNo: 1,
        contentHash: contentHashOf(data),
        schemaHash: hashOf(columns),
        fileChecksum: checksumOf(bytes),
        storageKey: row.storageKey,
        rowCount: data.rows.length,
        columnCount: data.columns.length,
        columns: columns as unknown as Record<string, unknown>[],
      },
      {
        datasetId: row.id,
        userId: row.userId,
        projectId: row.projectId,
        inputVersionId: null,
        operation: 'import',
        parameters: {
          source: row.originalName,
          storedAs: 'csv (UTF-8, comma-delimited)',
          missingMarkers: ['', 'na', 'n/a', 'n.a.', 'null', 'nil', 'none', '-', '--', '#n/a', '#null!', '#div/0!', '.', 'لا يوجد', '(and Arabic equivalents)'],
          typeInference: 'profileDataset (recorded here; changed only by set-schema)',
          ...(legacyClean ? { legacyCleanedCopyOf: row.parentDatasetId, note: 'A cleaned copy made before P1-C; its cleaning actions were not recorded.' } : {}),
        },
        report: {
          rows: data.rows.length,
          columns: data.columns.length,
          ...(readReport?.skippedRows ? { blankRowsSkipped: readReport.skippedRows } : {}),
          ...(readReport?.raggedRows ? { rowsWithExtraFields: readReport.raggedRows } : {}),
          ...(readReport?.missingMarkers ? { cellsReadAsMissing: readReport.missingMarkers } : {}),
          ...(readReport?.truncatedTo || row.truncatedTo ? { truncatedTo: readReport?.truncatedTo ?? row.truncatedTo } : {}),
        },
        engineVersion: ENGINE.version,
      },
    );
  } catch (error) {
    const [raced] = await db
      .select()
      .from(datasetVersions)
      .where(and(eq(datasetVersions.datasetId, row.id), eq(datasetVersions.versionNo, 1)))
      .limit(1);
    if (raced) return raced;
    throw error;
  }
}

/**
 * The legacy "cleaned copy" (a new dataset row) recorded as what it is: version
 * 1 of the copy, derived from the parent's version by a `clean` transformation
 * with its actions and report. Before P1-C the actions were thrown away.
 */
export async function recordLegacyClean(child: DatasetRow, parent: DatasetRow, actions: CleaningAction[], report: Record<string, unknown>): Promise<DatasetVersion> {
  const parentVersion = await ensureInitialVersion(parent);
  const { bytes, data } = await readStored(child.storageKey);
  const columns = inferredSchema(profileDataset(data));
  const { cleanedAt: _clock, ...deterministic } = report;
  return insertVersion(
    {
      datasetId: child.id,
      userId: child.userId,
      projectId: child.projectId,
      versionNo: 1,
      parentVersionId: parentVersion.id,
      contentHash: contentHashOf(data),
      schemaHash: hashOf(columns),
      fileChecksum: checksumOf(bytes),
      storageKey: child.storageKey,
      rowCount: data.rows.length,
      columnCount: data.columns.length,
      columns: columns as unknown as Record<string, unknown>[],
    },
    {
      datasetId: child.id,
      userId: child.userId,
      projectId: child.projectId,
      inputVersionId: parentVersion.id,
      operation: 'clean',
      parameters: { actions: actions.map(({ kind, columns: names }) => ({ kind, columns: names })), order: 'fixed engine order (clean.ts)', via: 'legacy cleaned copy' },
      report: deterministic,
      engineVersion: ENGINE.version,
    },
  );
}

/** The project's tabular datasets and their versions (project VIEWER). */
export async function listProjectDatasets(actor: StatsActor, projectId: string) {
  const { requireProjectRole } = await import('@/server/graph/service');
  await requireProjectRole(projectId, actor.userId, 'VIEWER');
  const rows = await db
    .select({ id: datasets.id, name: datasets.originalName, kind: datasets.kind, rows: datasets.rowCount, columns: datasets.columnCount, createdAt: datasets.createdAt })
    .from(datasets)
    .where(and(eq(datasets.projectId, projectId), isNull(datasets.deletedAt), eq(datasets.mimeType, 'text/csv')))
    .orderBy(desc(datasets.createdAt))
    .limit(200);
  const versions = await db
    .select({ id: datasetVersions.id, datasetId: datasetVersions.datasetId, versionNo: datasetVersions.versionNo, rows: datasetVersions.rowCount, contentHash: datasetVersions.contentHash, createdAt: datasetVersions.createdAt })
    .from(datasetVersions)
    .where(eq(datasetVersions.projectId, projectId));
  return rows.map((row) => ({ ...row, versions: versions.filter((v) => v.datasetId === row.id).sort((a, b) => a.versionNo - b.versionNo) }));
}

export async function listVersions(actor: StatsActor, datasetId: string, projectId?: string | null) {
  const row = await requireDataset(datasetId, actor, 'VIEWER', projectId);
  await ensureInitialVersion(row);
  const versions = await db.select().from(datasetVersions).where(eq(datasetVersions.datasetId, datasetId)).orderBy(asc(datasetVersions.versionNo));
  const transformations = await db.select().from(datasetTransformations).where(eq(datasetTransformations.datasetId, datasetId));
  return { dataset: row, versions, transformations };
}

/* -------------------------------------------------------------------------- */
/*                               Transformations                              */
/* -------------------------------------------------------------------------- */

const CLEANING_KINDS = ['trim-whitespace', 'normalise-categories', 'drop-duplicate-rows', 'drop-empty-columns', 'drop-constant-columns', 'drop-rows-missing', 'impute-mean', 'impute-median', 'impute-mode', 'remove-outliers', 'coerce-numeric'] as const;

export const transformSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('set-schema'),
      /** Changes to the declared schema, by column name. Columns not listed keep their declaration. */
      columns: z.array(columnSchemaSchema).min(1).max(500),
    })
    .strict(),
  z
    .object({
      operation: z.literal('clean'),
      actions: z
        .array(z.object({ kind: z.enum(CLEANING_KINDS), columns: z.array(z.string().min(1).max(200)).max(500) }).strict())
        .min(1)
        .max(50),
    })
    .strict(),
]);
export type TransformInput = z.infer<typeof transformSchema>;

async function nextVersionNo(datasetId: string): Promise<number> {
  const [latest] = await db.select({ n: datasetVersions.versionNo }).from(datasetVersions).where(eq(datasetVersions.datasetId, datasetId)).orderBy(desc(datasetVersions.versionNo)).limit(1);
  return (latest?.n ?? 0) + 1;
}

/**
 * A new version from an existing one, by a recorded deterministic operation.
 * The input version is never touched.
 */
export async function transformVersion(actor: StatsActor, versionId: string, input: TransformInput, projectId?: string | null): Promise<{ version: DatasetVersion; report: Record<string, unknown> }> {
  const source = await requireVersion(versionId, actor, 'EDITOR', projectId);
  if (!source.datasetId) throw new AppError('CONFLICT', 'The dataset of this version was deleted; it can be read but not transformed.', 'حُذفت مجموعة البيانات؛ لا يمكن تحويل هذا الإصدار.');
  const [dataset] = await db.select().from(datasets).where(eq(datasets.id, source.datasetId)).limit(1);
  if (!dataset || dataset.deletedAt) throw new AppError('NOT_FOUND', 'The dataset was not found.', 'لم يُعثر على مجموعة البيانات.');
  const data = await loadVersion(source);
  const schema = data.columns;
  const names = new Set(schema.map((column) => column.name));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const versionNo = await nextVersionNo(source.datasetId);
    try {
      if (input.operation === 'set-schema') {
        const unknown = input.columns.filter((column) => !names.has(column.name)).map((column) => column.name);
        if (unknown.length) throw new AppError('VALIDATION', `Not in this version: ${unknown.join(', ')}.`, 'أعمدة غير موجودة في هذا الإصدار.');
        const byName = new Map(input.columns.map((column) => [column.name, column]));
        const columns = schema.map((column) => (byName.has(column.name) ? { ...column, ...byName.get(column.name) } : column));
        const report = { changed: input.columns.map((column) => ({ column: column.name, from: schema.find((c) => c.name === column.name), to: columns.find((c) => c.name === column.name) })) };
        const version = await insertVersion(
          { ...pick(source), versionNo, parentVersionId: source.id, schemaHash: hashOf(columns), columns: columns as unknown as Record<string, unknown>[] },
          { datasetId: source.datasetId, userId: actor.userId, projectId: source.projectId, inputVersionId: source.id, operation: 'set-schema', parameters: { columns: input.columns }, report, engineVersion: ENGINE.version },
        );
        return { version, report };
      }

      /* Cleaning: the existing, tested operations, on this version's cells, recorded in full. */
      const legacy: Dataset = { columns: schema.map((column) => column.name), rows: data.rows, source: `version ${source.versionNo}`, skippedRows: 0 };
      const actions: CleaningAction[] = input.actions.map((action) => {
        const unknown = action.columns.filter((column) => !names.has(column));
        if (unknown.length) throw new AppError('VALIDATION', `Not in this version: ${unknown.join(', ')}.`, 'أعمدة غير موجودة في هذا الإصدار.');
        return { ...action, reasonKey: 'user', recommended: false, destructive: action.kind.startsWith('drop') || action.kind === 'remove-outliers' };
      });
      const { cleaned, report } = applyCleaning(legacy, profileDataset(legacy), actions);
      const bytes = new TextEncoder().encode(toCsv(cleaned));
      const reread = parseCsv(new TextDecoder().decode(bytes), 'cleaned', ',');
      const columns = reread.columns.map((name) => schema.find((column) => column.name === name) ?? { name, type: 'text' as const });
      const key = datasetVersionKey({ userId: dataset.userId, datasetId: dataset.id, versionNo });
      await storageProvider().put(key, bytes, 'text/csv');
      const { cleanedAt: _clock, ...deterministicReport } = report;
      const version = await insertVersion(
        {
          datasetId: source.datasetId,
          userId: dataset.userId,
          projectId: source.projectId,
          versionNo,
          parentVersionId: source.id,
          contentHash: contentHashOf(reread),
          schemaHash: hashOf(columns),
          fileChecksum: checksumOf(bytes),
          storageKey: key,
          rowCount: reread.rows.length,
          columnCount: reread.columns.length,
          columns: columns as unknown as Record<string, unknown>[],
        },
        { datasetId: source.datasetId, userId: actor.userId, projectId: source.projectId, inputVersionId: source.id, operation: 'clean', parameters: { actions: input.actions, order: 'fixed engine order (clean.ts)' }, report: deterministicReport as unknown as Record<string, unknown>, engineVersion: ENGINE.version },
      );
      logger.info('stats.version.cleaned', { datasetId: source.datasetId, from: source.versionNo, to: versionNo, rows: reread.rows.length });
      return { version, report: deterministicReport as unknown as Record<string, unknown> };
    } catch (error) {
      /* Two transformations raced for the same version number: take the next one. */
      if (String((error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string }).code) === '23505') continue;
      throw error;
    }
  }
  throw new AppError('CONFLICT', 'Another change to this dataset is in progress; try again.', 'هناك تغيير آخر جارٍ؛ حاول مجددًا.');
}

function pick(source: DatasetVersion) {
  return {
    datasetId: source.datasetId,
    userId: source.userId,
    projectId: source.projectId,
    contentHash: source.contentHash,
    fileChecksum: source.fileChecksum,
    storageKey: source.storageKey,
    rowCount: source.rowCount,
    columnCount: source.columnCount,
  };
}

/** The chain of transformations from import to this version, oldest first. */
export async function lineageOf(versionId: string): Promise<{ version: DatasetVersion; transformation: typeof datasetTransformations.$inferSelect | null }[]> {
  const chain: { version: DatasetVersion; transformation: typeof datasetTransformations.$inferSelect | null }[] = [];
  let current: string | null = versionId;
  for (let depth = 0; current && depth < 100; depth += 1) {
    const [version] = await db.select().from(datasetVersions).where(eq(datasetVersions.id, current)).limit(1);
    if (!version) break;
    const [transformation] = await db.select().from(datasetTransformations).where(eq(datasetTransformations.outputVersionId, version.id)).limit(1);
    chain.unshift({ version, transformation: transformation ?? null });
    current = version.parentVersionId;
  }
  return chain;
}

export { sha256 };
