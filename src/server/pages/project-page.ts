import { notFound } from 'next/navigation';

import type { ResearchProject, ResearchSection } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import { getOwnedProject, getProjectWithSections } from '@/server/services/project.service';

/**
 * Page-level wrappers around the project service.
 *
 * The service throws `NOT_FOUND` for both a missing project and one owned by
 * somebody else — the right answer for an API, but in a server component an
 * uncaught throw renders the "something went wrong" screen. A guessed or stale
 * project URL should render the 404 page instead, so these translate that one
 * error into Next's `notFound()` and let every other failure surface as a real
 * error.
 */

export async function requireProjectPage(
  id: string,
  userId: string,
): Promise<ResearchProject> {
  try {
    return await getOwnedProject(id, userId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }
}

export async function requireProjectWithSectionsPage(
  id: string,
  userId: string,
): Promise<{ project: ResearchProject; sections: ResearchSection[] }> {
  try {
    return await getProjectWithSections(id, userId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }
}
