/**
 * Which test answers the question, and how its columns are passed to it.
 *
 * Shared by the analysis agent and the task system's analysis step. They were
 * one private copy inside the agent, which is why only the agent could run a
 * t-test: the task system had a step for it that could only ask.
 */

import { capabilityFor, type IntentKey } from '@/agents/registry';
import { recommendTest, type Recommendation, type RoleAssignment } from '@/analysis/inference/recommend';
import type { DatasetProfile } from '@/analysis/types';

import type { AnalysisRequest, AnalysisTestKey } from './statistics.service';

/**
 * The test for these roles.
 *
 * The recommender answers "which test fits these variables", and the intent
 * answers "what did the user ask for". When they disagree — a comparison
 * request whose variables suit a regression — the intent wins, because the
 * user's question is not the system's to reinterpret.
 */
export function chooseTestFor(
  profile: DatasetProfile,
  roles: RoleAssignment[],
  intent: IntentKey | string,
): { test: AnalysisTestKey | null; recommendation: Recommendation } {
  const recommendation = recommendTest(profile, roles);
  if (!recommendation.best) return { test: null, recommendation };

  const chosen = recommendation.best.test as AnalysisTestKey;
  const tests = capabilityFor(intent as IntentKey)?.tests;

  if (tests && tests.length > 0 && !tests.includes(chosen)) {
    return { test: (tests[0] as AnalysisTestKey | undefined) ?? null, recommendation };
  }

  return { test: chosen, recommendation };
}

/** Maps roles onto the column shape each engine expects. */
export function columnsFor(test: AnalysisTestKey, roles: RoleAssignment[]): AnalysisRequest['columns'] {
  const dependent = roles.find((role) => role.role === 'dependent')?.column;
  const grouping = roles.find((role) => role.role === 'grouping')?.column;
  const independents = roles
    .filter((role) => role.role === 'independent' || role.role === 'covariate')
    .map((role) => role.column);
  const paired = roles.filter((role) => role.role === 'paired').map((role) => role.column);

  switch (test) {
    case 't.paired':
      return { paired: [paired[0] as string, paired[1] as string] };
    case 'correlation.pearson':
    case 'correlation.spearman':
    case 'correlation.matrix':
      return {
        independents: independents.length >= 2 ? independents : ([dependent, ...independents].filter(Boolean) as string[]),
      };
    case 'chiSquare.independence':
      return { dependent, grouping: grouping ?? independents[0] };
    case 'reliability.cronbachAlpha':
      return { items: [dependent, ...independents].filter(Boolean) as string[] };
    default:
      return { dependent, grouping, independents };
  }
}
