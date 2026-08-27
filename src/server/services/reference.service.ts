import type { ReferenceRow } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as referencesRepo from '@/server/repositories/references.repository';

import { getOwnedProject } from './project.service';
import { runTool } from './tool.service';

export type CitationStyle = 'APA7' | 'HARVARD' | 'MLA' | 'CHICAGO';

export async function listReferences(
  projectId: string,
  userId: string,
): Promise<ReferenceRow[]> {
  await getOwnedProject(projectId, userId);
  return referencesRepo.listForProject(projectId);
}

/**
 * A reference is always stored UNVERIFIED, whatever produced it. Only
 * `markVerified` — reachable exclusively from an explicit user action — can
 * change that. No AI code path is allowed to write USER_CONFIRMED.
 */
export async function addReference(input: {
  projectId: string;
  userId: string;
  rawText: string;
  style?: CitationStyle;
}): Promise<ReferenceRow> {
  await getOwnedProject(input.projectId, input.userId);

  return referencesRepo.create({
    projectId: input.projectId,
    rawText: input.rawText.trim(),
    style: input.style ?? 'APA7',
    verification: 'UNVERIFIED',
  });
}

export async function formatReference(input: {
  projectId: string;
  userId: string;
  referenceId: string;
  style: CitationStyle;
}): Promise<ReferenceRow> {
  await getOwnedProject(input.projectId, input.userId);

  const list = await referencesRepo.listForProject(input.projectId);
  const reference = list.find((row) => row.id === input.referenceId);
  if (!reference) throw AppError.notFound('reference');

  const result = await runTool({
    userId: input.userId,
    toolKey: 'citationAssistant',
    text: reference.rawText,
    options: { style: input.style },
    projectId: input.projectId,
  });

  const updated = await referencesRepo.update(input.referenceId, input.projectId, {
    formatted: result.output,
    style: input.style,
    // Formatting never confirms a source — it only restyles what the user pasted.
    verification: 'UNVERIFIED',
  });

  if (!updated) throw AppError.notFound('reference');
  return updated;
}

export async function markVerified(
  projectId: string,
  userId: string,
  referenceId: string,
): Promise<ReferenceRow> {
  await getOwnedProject(projectId, userId);
  const updated = await referencesRepo.update(referenceId, projectId, {
    verification: 'USER_CONFIRMED',
  });
  if (!updated) throw AppError.notFound('reference');
  return updated;
}

export async function deleteReference(
  projectId: string,
  userId: string,
  referenceId: string,
): Promise<void> {
  await getOwnedProject(projectId, userId);
  await referencesRepo.remove(referenceId, projectId);
}
