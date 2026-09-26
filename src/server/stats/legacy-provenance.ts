/**
 * Where a legacy (pre-P1-C engine) result came from (WS2 B2, N10).
 *
 * Legacy analyses — `analysis_runs`, PLS-SEM, CB-SEM and the PLS bootstrap —
 * are computed by the older statistics code, not by the P1-C engine
 * (`ENGINE`, `stat_runs`). They record their own engine identity so a stored
 * result can never be mistaken for a P1-C one, and the exact data they read:
 * the dataset version and its content hash, and the row window when only the
 * first rows of a file were analysed.
 *
 * None of this makes a result "verified" (only P1-C runs are). It lets the
 * numeric-integrity guard tier the result like any legacy run
 * (`legacyResultTier`): pinned, unpinned, or windowed — and a windowed one
 * never contributes allowed numbers (WS2 D3).
 */

import type { Dataset as DatasetRow } from '@/server/db/schema';
import { logger } from '@/lib/logger';
import type { LegacyResultLike } from '@/server/integrity/numbers';
import { ensureInitialVersion } from '@/server/stats/versions';

/** The legacy statistics code, distinct from the P1-C engine (`ENGINE`). */
export const LEGACY_ENGINE = { id: 'academic-ai-legacy-analysis', version: '1' } as const;

/** The value stored in `analysis_runs.engine_version` for legacy runs. */
export const LEGACY_ENGINE_STAMP = `${LEGACY_ENGINE.id}@${LEGACY_ENGINE.version}`;

export interface LegacyProvenance {
  datasetId: string;
  /** The dataset version read (version 1 of the stored file); null if it could not be recorded. */
  datasetVersionId: string | null;
  datasetContentHash: string | null;
  engine: { id: string; version: string };
  engineVersion: string;
  /** Set when only the first rows of the file were analysed. */
  truncatedTo?: number;
  rowsAnalysed: number;
}

/**
 * The provenance of an analysis over a loaded dataset. Like `runAnalysis`,
 * a failure to record the version is logged and leaves the result unpinned,
 * never blocks it.
 */
export async function legacyProvenance(loaded: { row: DatasetRow; data: { rows: readonly unknown[] }; truncatedTo?: number }): Promise<LegacyProvenance> {
  const version = await ensureInitialVersion(loaded.row).catch((error: unknown) => {
    logger.warn('analysis.provenance.versionUnavailable', { datasetId: loaded.row.id, error: String(error).slice(0, 200) });
    return null;
  });
  return {
    datasetId: loaded.row.id,
    datasetVersionId: version?.id ?? null,
    datasetContentHash: version?.contentHash ?? null,
    engine: { ...LEGACY_ENGINE },
    engineVersion: LEGACY_ENGINE_STAMP,
    ...(loaded.truncatedTo ? { truncatedTo: loaded.truncatedTo } : {}),
    rowsAnalysed: loaded.data.rows.length,
  };
}

/** A stored provenance record, read back from JSON; null when absent or malformed (older results). */
export function readProvenance(value: unknown): LegacyProvenance | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<LegacyProvenance>;
  if (typeof record.engineVersion !== 'string' || typeof record.datasetId !== 'string') return null;
  return record as LegacyProvenance;
}

/** A result with its provenance, in the shape `legacyResultTier` and `allowedFromLegacyResults` read. */
export function asLegacyResult(result: unknown, provenance: LegacyProvenance, id?: string): LegacyResultLike {
  return {
    ...(id ? { id } : {}),
    result,
    spec: provenance.truncatedTo ? { truncatedTo: provenance.truncatedTo } : {},
    datasetVersionId: provenance.datasetVersionId,
    datasetContentHash: provenance.datasetContentHash,
    engineVersion: provenance.engineVersion,
  };
}
