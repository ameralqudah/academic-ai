import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { runAnalysis, type AnalysisTestKey } from '@/server/services/statistics.service';

const analyzeSchema = z.object({
  test: z.enum([
    't.oneSample',
    't.independent',
    't.paired',
    'anova.oneWay',
    'correlation.pearson',
    'correlation.spearman',
    'correlation.matrix',
    'chiSquare.independence',
    'chiSquare.goodnessOfFit',
    'regression.ols',
    'reliability.cronbachAlpha',
  ]),
  columns: z.object({
    dependent: z.string().optional(),
    grouping: z.string().optional(),
    independents: z.array(z.string()).max(30).optional(),
    items: z.array(z.string()).max(100).optional(),
    paired: z.tuple([z.string(), z.string()]).optional(),
  }),
  options: z
    .object({
      mu: z.number().optional(),
      confidenceLevel: z.number().min(0.5).max(0.999).optional(),
      expectedProportions: z.array(z.number()).max(50).optional(),
    })
    .optional(),
  projectId: z.string().optional(),
  conversationId: z.string().optional(),
});

type Body = z.infer<typeof analyzeSchema>;

/**
 * Runs a statistical test and records the result.
 *
 * No AI provider is called, so nothing is charged against the user's quota.
 * That is not a concession — a t-test is arithmetic, and the engines behind
 * this route are verified against SciPy and statsmodels rather than generated.
 *
 * The rate limit exists because a regression on five thousand rows is real CPU,
 * not because the operation is sensitive.
 */
export const POST = withApi<Body, { id: string }>(
  { schema: analyzeSchema, rateLimit: { max: 60, windowSeconds: 300, key: 'datasets.analyze' } },
  async ({ user, params, body }) => {
    const outcome = await runAnalysis({
      datasetId: params.id,
      userId: user.id,
      test: body.test as AnalysisTestKey,
      columns: body.columns,
      options: body.options,
      projectId: body.projectId ?? null,
      conversationId: body.conversationId ?? null,
    });

    return ok(outcome, { status: 201 });
  },
);
