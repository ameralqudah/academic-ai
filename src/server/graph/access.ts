/**
 * Gate for the graph API: the feature flag first (off → 404, as if the route
 * did not exist), then the caller's project role.
 */

import { getEnv } from '@/config/env';
import { AppError } from '@/server/http/errors';

import { requireProjectRole, type ProjectRole } from './service';

export function graphEnabled(): boolean {
  return getEnv().FF_GRAPH;
}

export async function graphAccess(projectId: string, userId: string, minimum: ProjectRole): Promise<ProjectRole> {
  if (!graphEnabled()) throw AppError.notFound();
  return requireProjectRole(projectId, userId, minimum);
}
