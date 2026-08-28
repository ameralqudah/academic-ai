/**
 * Running and recording a statistical test.
 *
 * This is the seam between the deterministic engines in `src/analysis` and the
 * rest of the application. Its job is narrow on purpose: pull the columns a
 * request names out of a stored dataset, hand them to the right engine, and
 * save what comes back.
 *
 * **No statistics are computed here.** Not one. Every number comes from a
 * function in `src/analysis` that was verified against SciPy or statsmodels and
 * is covered by the analysis suite. If a calculation ever appears in this file
 * it is in the wrong place, because a number computed in a service is a number
 * that cannot be tested without a database.
 *
 * **No AI provider is called either.** Running a t-test costs the user nothing
 * from their quota, because it costs nothing to run — it is arithmetic. That is
 * a fact about the architecture, not a promotional decision, and it is why the
 * task meter records analyses at zero units.
 *
 * **Which test to run is decided, never guessed.** The caller either names a
 * test explicitly or asks for a recommendation, and the recommendation comes
 * from `recommendTest` — deterministic code with 479 assertions behind it —
 * rather than from a language model. A model that picks Pearson where Spearman
 * was needed produces a number that is wrong in a way nobody downstream can
 * detect.
 */

import {
  chiSquareIndependence,
  chiSquareGoodnessOfFit,
  correlate,
  correlationMatrix,
  crossTabulate,
  cronbachAlpha,
  profileDataset,
  independentTTest,
  linearRegression,
  oneSampleTTest,
  oneWayAnova,
  pairedTTest,
  recommendTest,
  shouldCheckReliability,
  toNumber,
  type CellValue,
  type CorrelationMethod,
  type Dataset as ParsedDataset,
  type InferentialResult,
  type Recommendation,
  type RoleAssignment,
} from '@/analysis';
import { logger } from '@/lib/logger';
import type { AnalysisRun } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as runsRepo from '@/server/repositories/analysis-runs.repository';
import { loadForAnalysis } from '@/server/services/dataset.service';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

export type AnalysisTestKey =
  | 't.oneSample'
  | 't.independent'
  | 't.paired'
  | 'anova.oneWay'
  | 'correlation.pearson'
  | 'correlation.spearman'
  | 'correlation.matrix'
  | 'chiSquare.independence'
  | 'chiSquare.goodnessOfFit'
  | 'regression.ols'
  | 'reliability.cronbachAlpha';

export interface AnalysisRequest {
  datasetId: string;
  userId: string;
  test: AnalysisTestKey;
  /** Columns by role. Which roles are required depends on the test. */
  columns: {
    dependent?: string;
    grouping?: string;
    independents?: string[];
    items?: string[];
    paired?: [string, string];
  };
  options?: {
    /** For the one-sample t-test: the value to compare against. */
    mu?: number;
    confidenceLevel?: number;
    /** For chi-square goodness of fit. */
    expectedProportions?: number[];
  };
  /** Attach the result to a project as it is saved. */
  projectId?: string | null;
  conversationId?: string | null;
}

export interface AnalysisOutcome {
  run: AnalysisRun;
  result: InferentialResult | Record<string, unknown>;
  /** Set when the analysis ran on a window rather than the whole file. */
  truncatedTo?: number;
}

/* -------------------------------------------------------------------------- */
/*                              Recommendations                               */
/* -------------------------------------------------------------------------- */

/**
 * What could be run on these columns, and why.
 *
 * Returns the reliability screen alongside, because for questionnaire data the
 * first question is not "which test" but "do these items hold together at all",
 * and running the analysis before checking that is how a thesis ends up
 * reporting results from an instrument that does not.
 */
export async function recommend(input: {
  datasetId: string;
  userId: string;
  roles: RoleAssignment[];
}): Promise<{
  recommendation: Recommendation;
  reliability: { recommended: boolean; reasons: { code: string }[] } | null;
}> {
  const loaded = await loadForAnalysis(input.datasetId, input.userId);
  const recommendation = recommendTest(loaded.profile, input.roles);

  const itemColumns = input.roles
    .filter((role) => role.role === 'independent' || role.role === 'dependent')
    .map((role) => role.column);

  const reliability =
    itemColumns.length >= 2 ? shouldCheckReliability(loaded.profile, itemColumns) : null;

  return { recommendation, reliability };
}

/* -------------------------------------------------------------------------- */
/*                                 Running                                    */
/* -------------------------------------------------------------------------- */

export async function runAnalysis(request: AnalysisRequest): Promise<AnalysisOutcome> {
  const loaded = await loadForAnalysis(request.datasetId, request.userId);
  const started = Date.now();

  const result = compute(loaded.data, request);

  const run = await runsRepo.create({
    userId: request.userId,
    datasetId: request.datasetId,
    projectId: request.projectId ?? null,
    conversationId: request.conversationId ?? null,
    testKey: request.test,
    spec: {
      columns: request.columns,
      options: request.options ?? {},
      rowsAnalysed: loaded.data.rows.length,
      ...(loaded.truncatedTo ? { truncatedTo: loaded.truncatedTo } : {}),
    },
    result: result as unknown as Record<string, unknown>,
  });

  logger.info('analysis.run', {
    test: request.test,
    datasetId: request.datasetId,
    rows: loaded.data.rows.length,
    ms: Date.now() - started,
  });

  return {
    run,
    result,
    ...(loaded.truncatedTo ? { truncatedTo: loaded.truncatedTo } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*                              Column extraction                             */
/* -------------------------------------------------------------------------- */

function columnIndex(dataset: ParsedDataset, name: string): number {
  const index = dataset.columns.indexOf(name);
  if (index < 0) {
    throw new AppError(
      'VALIDATION',
      `The column "${name}" is not in this file.`,
      `العمود "${name}" غير موجود في هذا الملف.`,
    );
  }
  return index;
}

/** Numbers only, with missing values dropped — each engine states its own policy. */
function numericColumn(dataset: ParsedDataset, name: string): number[] {
  const index = columnIndex(dataset, name);
  const values: number[] = [];

  for (const row of dataset.rows) {
    const parsed = toNumber(row[index] as CellValue);
    if (parsed !== null) values.push(parsed);
  }

  if (values.length === 0) {
    throw new AppError(
      'VALIDATION',
      `The column "${name}" contains no numbers.`,
      `العمود "${name}" لا يحتوي على أرقام.`,
    );
  }

  return values;
}

/**
 * Numbers aligned to their rows, keeping NaN where a value was missing.
 *
 * Needed wherever two columns have to stay in step — a paired test, a
 * correlation, a regression. Dropping missing values column by column would
 * silently pair respondent five's answer with respondent seven's.
 */
function alignedColumn(dataset: ParsedDataset, name: string): number[] {
  const index = columnIndex(dataset, name);
  return dataset.rows.map((row) => {
    const parsed = toNumber(row[index] as CellValue);
    return parsed === null ? Number.NaN : parsed;
  });
}

/** Splits a numeric column by the levels of a categorical one. */
function groupedColumn(
  dataset: ParsedDataset,
  valueColumn: string,
  groupColumn: string,
): { labels: string[]; groups: number[][] } {
  const valueIndex = columnIndex(dataset, valueColumn);
  const groupIndex = columnIndex(dataset, groupColumn);

  const buckets = new Map<string, number[]>();

  for (const row of dataset.rows) {
    const raw = row[groupIndex];
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;

    const value = toNumber(row[valueIndex] as CellValue);
    if (value === null) continue;

    const label = String(raw).trim();
    const bucket = buckets.get(label);
    if (bucket) bucket.push(value);
    else buckets.set(label, [value]);
  }

  const labels = [...buckets.keys()].sort();
  return { labels, groups: labels.map((label) => buckets.get(label) as number[]) };
}

function requireColumn(name: string | undefined, role: string): string {
  if (!name) {
    throw new AppError(
      'VALIDATION',
      `This test needs a ${role} variable.`,
      `هذا الاختبار يحتاج متغيّر ${role}.`,
    );
  }
  return name;
}

/* -------------------------------------------------------------------------- */
/*                                 Dispatch                                   */
/* -------------------------------------------------------------------------- */

/**
 * Maps a request onto an engine.
 *
 * A plain switch rather than a registry object, so that adding a test means
 * adding a branch the type checker will hold to the `AnalysisTestKey` union —
 * an unhandled key becomes a compile error rather than a runtime surprise.
 */
function compute(
  dataset: ParsedDataset,
  request: AnalysisRequest,
): InferentialResult | Record<string, unknown> {
  const { columns, options } = request;
  const level = options?.confidenceLevel;

  switch (request.test) {
    case 't.oneSample': {
      const name = requireColumn(columns.dependent, 'dependent');
      if (options?.mu === undefined) {
        throw new AppError(
          'VALIDATION',
          'A one-sample t-test needs a value to compare against.',
          'اختبار t لعينة واحدة يحتاج قيمة للمقارنة معها.',
        );
      }
      return oneSampleTTest(numericColumn(dataset, name), name, { mu: options.mu, confidenceLevel: level });
    }

    case 't.independent': {
      const value = requireColumn(columns.dependent, 'dependent');
      const group = requireColumn(columns.grouping, 'grouping');
      const { labels, groups } = groupedColumn(dataset, value, group);

      if (labels.length !== 2) {
        throw new AppError(
          'VALIDATION',
          `"${group}" has ${labels.length} groups; an independent t-test needs exactly two. Use a one-way ANOVA instead.`,
          `"${group}" فيه ${labels.length} مجموعات؛ اختبار t المستقل يحتاج مجموعتين بالضبط. استخدم تحليل التباين الأحادي بدلًا منه.`,
        );
      }

      return independentTTest(groups[0] as number[], groups[1] as number[], [labels[0] as string, labels[1] as string], {
        confidenceLevel: level,
      });
    }

    case 't.paired': {
      if (!columns.paired || columns.paired.length !== 2) {
        throw new AppError(
          'VALIDATION',
          'A paired t-test needs two measurements.',
          'اختبار t المزدوج يحتاج قياسين.',
        );
      }
      const [first, second] = columns.paired;
      return pairedTTest(alignedColumn(dataset, first), alignedColumn(dataset, second), [first, second], {
        confidenceLevel: level,
      });
    }

    case 'anova.oneWay': {
      const value = requireColumn(columns.dependent, 'dependent');
      const group = requireColumn(columns.grouping, 'grouping');
      const { labels, groups } = groupedColumn(dataset, value, group);
      return oneWayAnova(groups, labels, { confidenceLevel: level });
    }

    case 'correlation.pearson':
    case 'correlation.spearman': {
      const method: CorrelationMethod =
        request.test === 'correlation.spearman' ? 'spearman' : 'pearson';
      const pair = columns.independents ?? [];
      if (pair.length !== 2) {
        throw new AppError(
          'VALIDATION',
          'A correlation needs exactly two variables.',
          'الارتباط يحتاج متغيّرين بالضبط.',
        );
      }
      const [first, second] = pair as [string, string];
      return correlate(alignedColumn(dataset, first), alignedColumn(dataset, second), [first, second], {
        method,
        confidenceLevel: level,
      });
    }

    case 'correlation.matrix': {
      const names = columns.independents ?? [];
      if (names.length < 2) {
        throw new AppError(
          'VALIDATION',
          'A correlation matrix needs at least two variables.',
          'مصفوفة الارتباط تحتاج متغيّرين على الأقل.',
        );
      }
      return correlationMatrix(
        names.map((name) => ({ name, values: alignedColumn(dataset, name) })),
        { confidenceLevel: level },
      ) as unknown as Record<string, unknown>;
    }

    case 'chiSquare.independence': {
      const first = requireColumn(columns.dependent, 'first');
      const second = requireColumn(columns.grouping, 'second');
      const firstIndex = columnIndex(dataset, first);
      const secondIndex = columnIndex(dataset, second);

      const { table, dropped, used } = crossTabulate(
        dataset.rows.map((row) => (row[firstIndex] ?? null) as string | number | null),
        dataset.rows.map((row) => (row[secondIndex] ?? null) as string | number | null),
        [first, second],
      );

      void dropped;
      return chiSquareIndependence(table, [first, second], {}, used + dropped);
    }

    case 'chiSquare.goodnessOfFit': {
      const name = requireColumn(columns.dependent, 'dependent');
      const index = columnIndex(dataset, name);
      const counts = new Map<string, number>();

      for (const row of dataset.rows) {
        const raw = row[index];
        if (raw === null || raw === undefined || String(raw).trim() === '') continue;
        const label = String(raw).trim();
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }

      const labels = [...counts.keys()].sort();
      return chiSquareGoodnessOfFit(
        labels.map((label) => counts.get(label) as number),
        labels,
        options?.expectedProportions,
      );
    }

    case 'regression.ols': {
      const outcome = requireColumn(columns.dependent, 'dependent');
      const predictors = columns.independents ?? [];
      if (predictors.length === 0) {
        throw new AppError(
          'VALIDATION',
          'A regression needs at least one predictor.',
          'الانحدار يحتاج متغيّرًا مستقلًا واحدًا على الأقل.',
        );
      }
      return linearRegression(
        { name: outcome, values: alignedColumn(dataset, outcome) },
        predictors.map((name) => ({ name, values: alignedColumn(dataset, name) })),
        { confidenceLevel: level },
      );
    }

    case 'reliability.cronbachAlpha': {
      const items = columns.items ?? [];
      if (items.length < 2) {
        throw new AppError(
          'VALIDATION',
          'Reliability needs at least two items.',
          'حساب الثبات يحتاج بندين على الأقل.',
        );
      }
      return cronbachAlpha(dataset, profileDataset(dataset), items, {
        confidenceLevel: level,
      }) as unknown as Record<string, unknown>;
    }

    default: {
      const unreachable: never = request.test;
      throw new AppError('VALIDATION', `Unknown test: ${String(unreachable)}`, 'اختبار غير معروف.');
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                              Saved results                                 */
/* -------------------------------------------------------------------------- */

export async function getRun(id: string, userId: string): Promise<AnalysisRun> {
  const run = await runsRepo.findOwned(id, userId);
  if (!run) {
    throw new AppError('NOT_FOUND', 'That analysis was not found.', 'لم يُعثر على التحليل.');
  }
  return run;
}

export async function listRunsForDataset(datasetId: string, userId: string): Promise<AnalysisRun[]> {
  return runsRepo.listByDataset(datasetId, userId);
}

/**
 * Attaches a result to a section of a project.
 *
 * The deliberate act that separates a number the researcher was exploring from
 * one they intend to report — and, later, the switch that lets the results
 * chapter be written from real figures instead of a table shell.
 */
export async function attachRun(input: {
  runId: string;
  userId: string;
  projectId: string;
  sectionKey: string;
}): Promise<AnalysisRun> {
  const run = await runsRepo.attachToSection(
    input.runId,
    input.userId,
    input.projectId,
    input.sectionKey as Parameters<typeof runsRepo.attachToSection>[3],
  );
  if (!run) {
    throw new AppError('NOT_FOUND', 'That analysis was not found.', 'لم يُعثر على التحليل.');
  }
  return run;
}

export async function detachRun(runId: string, userId: string): Promise<AnalysisRun> {
  const run = await runsRepo.detach(runId, userId);
  if (!run) {
    throw new AppError('NOT_FOUND', 'That analysis was not found.', 'لم يُعثر على التحليل.');
  }
  return run;
}

export async function deleteRun(runId: string, userId: string): Promise<void> {
  const removed = await runsRepo.remove(runId, userId);
  if (!removed) {
    throw new AppError('NOT_FOUND', 'That analysis was not found.', 'لم يُعثر على التحليل.');
  }
}
