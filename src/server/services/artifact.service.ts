/**
 * Generating a file, checking it, and keeping every version of it.
 *
 * The pipeline is fixed and every artifact goes through all of it:
 *
 *   generate → validate the bytes → quality check → version → store
 *
 * Each step exists because of a specific failure. A generator that throws
 * halfway produces bytes that are not a valid file, and storing one means the
 * researcher finds out when they try to open it. A document with citations
 * pointing at nothing should carry that finding rather than being discovered by
 * a supervisor. And a regenerated document must not destroy the one before it,
 * because the researcher may prefer the earlier draft and cannot get it back.
 *
 * **The quality report is stored with the artifact, not recomputed.** It
 * describes the file as it was generated; running the check again in June would
 * judge a March export against a bibliography that has since changed.
 */

import { logger } from '@/lib/logger';
import { checkQuality, type QualityReport } from '@/server/quality/engine';
import type { Reference } from '@/server/quality/sources';
import { validateArtifactBytes } from '@/server/generators/documents';
import { AppError } from '@/server/http/errors';
import * as artifactsRepo from '@/server/repositories/artifacts.repository';
import { storageProvider } from '@/server/storage';
import type { Artifact } from '@/server/db/schema';

export type ArtifactKind = 'docx' | 'pdf' | 'pptx' | 'xlsx' | 'csv' | 'md' | 'bib' | 'ris';

const CONTENT_TYPES: Record<ArtifactKind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  bib: 'application/x-bibtex; charset=utf-8',
  ris: 'application/x-research-info-systems; charset=utf-8',
};

export interface StoreInput {
  userId: string;
  kind: ArtifactKind;
  filename: string;
  bytes: Uint8Array;
  projectId?: string | null;
  jobId?: string | null;
  conversationId?: string | null;
  /** What produced it: the style, the sections, the options chosen. */
  metadata?: Record<string, unknown>;
  /** Checked when supplied. Absent for a spreadsheet, which has no prose. */
  quality?: { text: string; references: Reference[] };
  /** The version this replaces. Absent for a first version. */
  previousArtifactId?: string;
}

/**
 * Runs the pipeline and returns the stored artifact.
 *
 * Fails before storing rather than after: an invalid file that reached the
 * database would appear in the researcher's list and refuse to open, which
 * looks like data loss.
 */
export async function storeArtifact(input: StoreInput): Promise<Artifact> {
  const startedAt = Date.now();

  /* 1. The bytes must actually be the file they claim to be. */
  const validation = await validateArtifactBytes(input.bytes, input.kind);

  if (!validation.valid) {
    logger.error('artifact.invalid', {
      kind: input.kind,
      reason: validation.reason,
      bytes: input.bytes.length,
    });

    throw new AppError(
      'INTERNAL',
      'The generated file was not valid and has not been saved.',
      'الملف المُولَّد غير صالح ولم يُحفظ.',
      { reasonKey: 'artifact.error.invalid' },
    );
  }

  /* 2. The quality check, when there is prose to check. */
  let qualityReport: QualityReport | null = null;

  if (input.quality) {
    try {
      qualityReport = await checkQuality({
        text: input.quality.text,
        references: input.quality.references,
        /*
         * Network verification is skipped here. A document export should not
         * wait on Crossref for sixty references, and the check runs on demand
         * from the artifact view where the researcher chose to wait.
         */
        skipNetwork: true,
      });
    } catch (error) {
      /*
       * A failed check does not block the file. The researcher asked for a
       * document; refusing to give them one because a checker crashed would be
       * the wrong trade.
       */
      logger.error('artifact.qualityCheckFailed', { error: String(error) });
    }
  }

  /* 3. Stored under a key scoped to the user, as uploads are. */
  const storageKey = `artifacts/${input.userId}/${crypto.randomUUID()}.${input.kind}`;

  await storageProvider().put(storageKey, input.bytes, CONTENT_TYPES[input.kind]);

  const row = {
    userId: input.userId,
    projectId: input.projectId ?? null,
    jobId: input.jobId ?? null,
    conversationId: input.conversationId ?? null,
    kind: input.kind,
    filename: input.filename,
    storageKey,
    byteSize: input.bytes.length,
    metadata: input.metadata ?? {},
    qualityReport: (qualityReport as unknown as Record<string, unknown>) ?? null,
    validationStatus: qualityReport?.overallStatus ?? 'unchecked',
  };

  /* 4. A new version when replacing, a new lineage when not. */
  let artifact: Artifact;

  if (input.previousArtifactId) {
    const previous = await artifactsRepo.findOwned(input.previousArtifactId, input.userId);

    if (!previous) {
      throw new AppError(
        'NOT_FOUND',
        'The previous version was not found.',
        'لم يُعثر على الإصدار السابق.',
      );
    }

    artifact = await artifactsRepo.createVersion(previous, row);
  } else {
    artifact = await artifactsRepo.createFirst(row);
  }

  logger.info('artifact.stored', {
    id: artifact.id,
    kind: input.kind,
    version: artifact.version,
    bytes: input.bytes.length,
    validation: artifact.validationStatus,
    ms: Date.now() - startedAt,
  });

  return artifact;
}

/** The bytes, for a download. */
export async function readArtifact(
  id: string,
  userId: string,
): Promise<{ artifact: Artifact; bytes: Uint8Array; contentType: string }> {
  const artifact = await artifactsRepo.findOwned(id, userId);

  if (!artifact) {
    throw new AppError('NOT_FOUND', 'That file was not found.', 'لم يُعثر على هذا الملف.');
  }

  const stored = await storageProvider().get(artifact.storageKey);

  return {
    artifact,
    bytes: stored.bytes,
    contentType: CONTENT_TYPES[artifact.kind as ArtifactKind] ?? 'application/octet-stream',
  };
}

/**
 * Every version of a document, newest first.
 *
 * Takes any version's id rather than the lineage id, because that is what the
 * caller has — a researcher looking at version 2 wants the history without
 * knowing what a lineage is.
 */
export async function versionsOf(artifactId: string, userId: string): Promise<Artifact[]> {
  const artifact = await artifactsRepo.findOwned(artifactId, userId);

  if (!artifact) {
    throw new AppError('NOT_FOUND', 'That file was not found.', 'لم يُعثر على هذا الملف.');
  }

  return artifactsRepo.lineage(artifact.lineageId, userId);
}

export async function listArtifacts(userId: string): Promise<Artifact[]> {
  return artifactsRepo.listLatest(userId);
}

export async function deleteArtifact(id: string, userId: string): Promise<void> {
  const removed = await artifactsRepo.remove(id, userId);

  if (!removed) {
    throw new AppError('NOT_FOUND', 'That file was not found.', 'لم يُعثر على هذا الملف.');
  }
}
