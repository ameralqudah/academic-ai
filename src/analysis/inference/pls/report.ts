/**
 * Turning PLS output into something a researcher can act on.
 *
 * The assessment layer produces numbers and verdicts. This produces the report
 * — and the difference is the difference between a tool that runs an analysis
 * and one that helps someone conduct research.
 *
 * "AVE = 0.43" tells a researcher nothing unless they already know the
 * threshold, know it applies only to reflective constructs, and know what to do
 * about it. The same fact stated as "the construct explains 43% of the variance
 * in its own indicators, below the 50% required; the weakest is Q7 at 0.51, and
 * removing it would raise AVE to 0.54" is a finding they can act on.
 *
 * Three rules govern everything here.
 *
 * **Every sentence is a fixed message with substituted values.** No language
 * model writes any of this. A model asked to interpret results will mention a
 * problem inconsistently — sometimes prominently, sometimes not at all — and a
 * validity failure that goes unmentioned once is a paper submitted with a flaw
 * in it. The condition is computed here; the wording is settled in the message
 * files.
 *
 * **Nothing is removed automatically, and every removal suggestion says so.**
 * An indicator carries part of what a construct means. A system that deletes
 * items until the thresholds pass is manufacturing validity rather than
 * assessing it, and the resulting model measures something nobody defined.
 *
 * **The mode decides the criteria.** Judging a formative construct by
 * reliability condemns it for the property that makes it formative, which is
 * among the most common serious errors in published PLS work.
 */

import type { BootstrapResult } from './bootstrap';
import type {
  ConstructAssessment,
  Criterion,
  DiscriminantValidity,
  IndicatorAssessment,
  StructuralAssessment,
  Verdict,
} from './assessment';
import { PLS_THRESHOLDS } from './assessment';

/* -------------------------------------------------------------------------- */
/*                                   Shape                                    */
/* -------------------------------------------------------------------------- */

export type Severity = 'ok' | 'attention' | 'problem';

/**
 * One statement in the report.
 *
 * The key names a message; the params fill it. Both languages are rendered from
 * the same key, so a finding cannot exist in one language and not the other.
 *
 * Keys are fully qualified — `analysis.pls.report.ave.violated`, not
 * `pls.report.ave.violated`. That is verbose and deliberate: a caller resolving
 * a bare key against the wrong namespace silently gets the key back and writes
 * it into a Word document, where it reads as a crash in the middle of a
 * validity warning. A test caught exactly that, and qualifying the keys removes
 * the possibility rather than documenting it.
 */
export interface Finding {
  key: string;
  severity: Severity;
  params?: Record<string, string | number>;
  /**
   * What the researcher might do, when there is something to do.
   *
   * Separate from the finding because the two are different claims: the finding
   * is what the data show, the action is a suggestion that may be overridden by
   * theory. Keeping them apart is what lets the interface present the second as
   * advice rather than instruction.
   */
  action?: { key: string; params?: Record<string, string | number> };
}

export interface ReportSection {
  titleKey: string;
  findings: Finding[];
  /** Rows for the table this section is usually reported as. */
  table?: ReportTable;
}

export interface ReportTable {
  headerKeys: string[];
  rows: (string | number)[][];
  /** Which rows failed, so the interface can mark them without re-deriving. */
  flaggedRows: number[];
}

export interface PlsReport {
  /** The one-line answer: is this measurement model publishable. */
  verdict: {
    severity: Severity;
    key: string;
    params: Record<string, string | number>;
  };
  sections: ReportSection[];
  /** Every action suggested anywhere, gathered for a summary. */
  actions: Finding['action'][];
  generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/*                                  Building                                  */
/* -------------------------------------------------------------------------- */

export function buildReport(input: {
  measurement: ConstructAssessment[];
  discriminant: DiscriminantValidity;
  structural: StructuralAssessment;
  bootstrap?: BootstrapResult | null;
  n: number;
  rowsDropped: number;
  converged: boolean;
}): PlsReport {
  const sections: ReportSection[] = [
    sampleSection(input.n, input.rowsDropped, input.converged),
    ...input.measurement.map((construct) => constructSection(construct)),
    discriminantSection(input.discriminant),
    structuralSection(input.structural, input.bootstrap ?? null),
  ];

  if (input.bootstrap) sections.push(bootstrapSection(input.bootstrap));

  const actions = sections
    .flatMap((section) => section.findings)
    .map((finding) => finding.action)
    .filter((action): action is NonNullable<Finding['action']> => Boolean(action));

  return {
    verdict: overallVerdict(sections),
    sections,
    actions,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Sections                                  */
/* -------------------------------------------------------------------------- */

function sampleSection(n: number, rowsDropped: number, converged: boolean): ReportSection {
  const findings: Finding[] = [
    { key: 'analysis.pls.report.sample.size', severity: 'ok', params: { n } },
  ];

  if (rowsDropped > 0) {
    /*
     * Missing data is reported as a proportion rather than a count, because
     * twelve dropped cases means something different at n = 40 than at n = 400.
     */
    const percent = Math.round((rowsDropped / (n + rowsDropped)) * 100);

    findings.push({
      key: 'analysis.pls.report.sample.dropped',
      severity: percent > 10 ? 'attention' : 'ok',
      params: { dropped: rowsDropped, percent },
      ...(percent > 10
        ? { action: { key: 'analysis.pls.report.action.checkMissing', params: { percent } } }
        : {}),
    });
  }

  if (!converged) {
    findings.push({
      key: 'analysis.pls.report.sample.notConverged',
      severity: 'problem',
      action: { key: 'analysis.pls.report.action.simplifyModel' },
    });
  }

  return { titleKey: 'analysis.pls.report.section.sample', findings };
}

/**
 * One construct's measurement quality.
 *
 * The whole section branches on mode, because the criteria are not the same
 * question asked of different data — they are different questions.
 */
function constructSection(construct: ConstructAssessment): ReportSection {
  const findings: Finding[] = [];

  if (construct.mode === 'reflective') {
    findings.push(...reflectiveFindings(construct));
  } else {
    findings.push(...formativeFindings(construct));
  }

  return {
    titleKey: 'analysis.pls.report.section.construct',
    findings: findings.map((finding) => ({
      ...finding,
      params: { construct: construct.construct, ...(finding.params ?? {}) },
    })),
    table: indicatorTable(construct),
  };
}

function reflectiveFindings(construct: ConstructAssessment): Finding[] {
  const findings: Finding[] = [];
  const ave = construct.ave;
  const reliability = construct.compositeReliability;

  /* Indicator loadings, worst first — the ones a reviewer will look at. */
  const weak = construct.indicators
    .filter((indicator) => indicator.verdict !== 'met')
    .sort((a, b) => a.loading - b.loading);

  for (const indicator of weak) {
    if (indicator.recommendation === 'remove') {
      findings.push({
        key: 'analysis.pls.report.indicator.belowCritical',
        severity: 'problem',
        params: { indicator: indicator.indicator, loading: round(indicator.loading) },
        action: {
          key: 'analysis.pls.report.action.removeIndicator',
          params: { indicator: indicator.indicator },
        },
      });
    } else if (indicator.recommendation === 'consider-removing') {
      /*
       * The number that makes this a decision rather than a complaint: what AVE
       * becomes without the indicator. Without it a researcher is told an item
       * is weak and left to guess whether removing it would help.
       */
      findings.push({
        key: 'analysis.pls.report.indicator.removalWouldFixAve',
        severity: 'attention',
        params: {
          indicator: indicator.indicator,
          loading: round(indicator.loading),
          currentAve: round(ave?.value ?? 0),
          aveIfRemoved: round(indicator.aveIfRemoved ?? 0),
        },
        action: {
          key: 'analysis.pls.report.action.considerRemoving',
          params: { indicator: indicator.indicator },
        },
      });
    } else {
      findings.push({
        key: 'analysis.pls.report.indicator.weakButKept',
        severity: 'attention',
        params: { indicator: indicator.indicator, loading: round(indicator.loading) },
      });
    }
  }

  if (ave) {
    findings.push({
      key: ave.verdict === 'met' ? 'analysis.pls.report.ave.met' : 'analysis.pls.report.ave.violated',
      severity: ave.verdict === 'met' ? 'ok' : 'problem',
      params: { value: round(ave.value), percent: Math.round(ave.value * 100) },
      ...(ave.verdict !== 'met'
        ? { action: { key: 'analysis.pls.report.action.fixAve' } }
        : {}),
    });
  }

  if (reliability) {
    if (reliability.value > PLS_THRESHOLDS.reliabilityCeiling) {
      /*
       * Flagged rather than praised. Above 0.95 usually means the indicators are
       * near-duplicates — the same question three ways — which inflates
       * reliability without measuring more of the construct.
       */
      findings.push({
        key: 'analysis.pls.report.reliability.tooHigh',
        severity: 'attention',
        params: { value: round(reliability.value) },
        action: { key: 'analysis.pls.report.action.checkRedundancy' },
      });
    } else {
      findings.push({
        key: reliability.verdict === 'met'
          ? 'analysis.pls.report.reliability.met'
          : 'analysis.pls.report.reliability.violated',
        severity: reliability.verdict === 'met' ? 'ok' : 'problem',
        params: {
          value: round(reliability.value),
          alpha: round(construct.cronbachAlpha?.value ?? Number.NaN),
        },
        ...(reliability.verdict !== 'met'
          ? { action: { key: 'analysis.pls.report.action.fixReliability' } }
          : {}),
      });
    }
  }

  /* A single-indicator construct makes these criteria undefined, not merely poor. */
  if (construct.indicators.length === 1) {
    findings.push({ key: 'analysis.pls.report.construct.singleIndicator', severity: 'attention' });
  }

  return findings;
}

function formativeFindings(construct: ConstructAssessment): Finding[] {
  const findings: Finding[] = [
    /*
     * Stated explicitly at the top of every formative construct, because a
     * reader who does not see it will assume the missing reliability figures
     * are an omission rather than a decision.
     */
    { key: 'analysis.pls.report.formative.criteria', severity: 'ok' },
  ];

  const vif = construct.maxVif;

  if (vif) {
    findings.push({
      key:
        vif.verdict === 'violated'
          ? 'analysis.pls.report.formative.collinear'
          : vif.verdict === 'borderline'
            ? 'analysis.pls.report.formative.someCollinearity'
            : 'analysis.pls.report.formative.acceptable',
      severity: vif.verdict === 'violated' ? 'problem' : vif.verdict === 'borderline' ? 'attention' : 'ok',
      params: { value: round(vif.value) },
      ...(vif.verdict === 'violated'
        ? { action: { key: 'analysis.pls.report.action.reviewFormativeItems' } }
        : {}),
    });
  }

  return findings;
}

function indicatorTable(construct: ConstructAssessment): ReportTable {
  const flagged: number[] = [];

  const rows = construct.indicators.map((indicator, index) => {
    if (indicator.verdict !== 'met') flagged.push(index);

    return [
      indicator.indicator,
      round(indicator.loading),
      round(indicator.weight),
      /*
       * Included even when it is not the criterion. For a formative construct
       * the weight matters and the loading is context; showing both lets a
       * reader see an indicator that contributes significantly while
       * correlating weakly, which is normal and looks alarming if only one
       * column is given.
       */
      indicator.aveIfRemoved === undefined ? '—' : round(indicator.aveIfRemoved),
    ];
  });

  return {
    headerKeys: [
      'analysis.pls.report.table.indicator',
      'analysis.pls.report.table.loading',
      'analysis.pls.report.table.weight',
      'analysis.pls.report.table.aveIfRemoved',
    ],
    rows,
    flaggedRows: flagged,
  };
}

/**
 * Discriminant validity — whether the constructs are actually different things.
 *
 * HTMT leads because it is what journals now require; Fornell–Larcker and
 * cross-loadings follow because reviewers still expect them and because
 * disagreement between the three is itself informative.
 */
function discriminantSection(discriminant: DiscriminantValidity): ReportSection {
  const findings: Finding[] = [];
  let anyProblem = false;

  const rows: (string | number)[][] = [];
  const flagged: number[] = [];

  let index = 0;
  for (const [pair, criterion] of discriminant.htmt) {
    rows.push([pair, round(criterion.value), verdictLabel(criterion.verdict)]);

    if (criterion.verdict !== 'met') {
      flagged.push(index);
      anyProblem = anyProblem || criterion.verdict === 'violated';

      findings.push({
        key:
          criterion.verdict === 'violated'
            ? 'analysis.pls.report.htmt.violated'
            : 'analysis.pls.report.htmt.borderline',
        severity: criterion.verdict === 'violated' ? 'problem' : 'attention',
        params: { pair, value: round(criterion.value) },
        ...(criterion.verdict === 'violated'
          ? { action: { key: 'analysis.pls.report.action.mergeOrRespecify', params: { pair } } }
          : {}),
      });
    }
    index += 1;
  }

  const flFailures = discriminant.fornellLarcker.filter((entry) => entry.verdict !== 'met');

  for (const failure of flFailures) {
    findings.push({
      key: 'analysis.pls.report.fornellLarcker.violated',
      severity: 'problem',
      params: {
        construct: failure.construct,
        sqrtAve: round(failure.sqrtAve),
        correlation: round(failure.highestCorrelation),
        with: failure.with,
      },
    });
  }

  for (const issue of discriminant.crossLoadingIssues) {
    findings.push({
      key: 'analysis.pls.report.crossLoading',
      severity: 'attention',
      params: {
        indicator: issue.indicator,
        own: issue.ownConstruct,
        other: issue.higherWith,
      },
      action: {
        key: 'analysis.pls.report.action.reviewIndicatorPlacement',
        params: { indicator: issue.indicator, other: issue.higherWith },
      },
    });
  }

  if (findings.length === 0) {
    findings.push({ key: 'analysis.pls.report.discriminant.allPass', severity: 'ok' });
  }

  return {
    titleKey: 'analysis.pls.report.section.discriminant',
    findings,
    table: {
      headerKeys: ['analysis.pls.report.table.pair', 'analysis.pls.report.table.htmt', 'analysis.pls.report.table.verdict'],
      rows,
      flaggedRows: flagged,
    },
  };
}

function structuralSection(
  structural: StructuralAssessment,
  bootstrap: BootstrapResult | null,
): ReportSection {
  const findings: Finding[] = [];

  for (const endogenous of structural.endogenous) {
    findings.push({
      key: 'analysis.pls.report.rSquared',
      severity: 'ok',
      params: {
        construct: endogenous.construct,
        value: round(endogenous.rSquared),
        percent: Math.round(endogenous.rSquared * 100),
        band: endogenous.band,
      },
    });

    if (endogenous.vifVerdict !== 'met') {
      /*
       * Collinearity between predictors inflates path coefficients and their
       * standard errors, so a significant path in a collinear model may be an
       * artefact. Worth saying where the paths are reported, not in a footnote.
       */
      findings.push({
        key:
          endogenous.vifVerdict === 'violated'
            ? 'analysis.pls.report.structuralVif.severe'
            : 'analysis.pls.report.structuralVif.elevated',
        severity: endogenous.vifVerdict === 'violated' ? 'problem' : 'attention',
        params: { construct: endogenous.construct, value: round(endogenous.maxVif) },
      });
    }
  }

  const rows: (string | number)[][] = [];
  const flagged: number[] = [];

  structural.paths.forEach((path, index) => {
    const key = `${path.from}→${path.to}`;
    const interval = bootstrap?.paths.find((entry) => entry.key === key);

    rows.push([
      key,
      round(path.coefficient),
      round(path.fSquared),
      path.effectBand,
      interval ? round(interval.tStatistic) : '—',
      interval ? formatP(interval.pValue) : '—',
      interval ? `[${round(interval.lower)}, ${round(interval.upper)}]` : '—',
    ]);

    if (interval && !interval.significant) flagged.push(index);

    if (interval) {
      findings.push({
        key: interval.significant
          ? 'analysis.pls.report.path.significant'
          : 'analysis.pls.report.path.notSignificant',
        severity: 'ok',
        params: {
          path: key,
          coefficient: round(path.coefficient),
          lower: round(interval.lower),
          upper: round(interval.upper),
          t: round(interval.tStatistic),
        },
      });
    }

    /*
     * A path can be statistically significant and practically negligible. f²
     * below 0.02 means removing the predictor barely changes R², and saying so
     * beside a significant p-value is what stops a trivial effect being
     * reported as a finding.
     */
    if (interval?.significant && path.effectBand === 'none') {
      findings.push({
        key: 'analysis.pls.report.path.significantButTrivial',
        severity: 'attention',
        params: { path: key, fSquared: round(path.fSquared) },
      });
    }
  });

  return {
    titleKey: 'analysis.pls.report.section.structural',
    findings,
    table: {
      headerKeys: [
        'analysis.pls.report.table.path',
        'analysis.pls.report.table.coefficient',
        'analysis.pls.report.table.fSquared',
        'analysis.pls.report.table.effect',
        'analysis.pls.report.table.t',
        'analysis.pls.report.table.p',
        'analysis.pls.report.table.ci',
      ],
      rows,
      flaggedRows: flagged,
    },
  };
}

function bootstrapSection(bootstrap: BootstrapResult): ReportSection {
  const findings: Finding[] = [
    {
      key: 'analysis.pls.report.bootstrap.summary',
      severity: 'ok',
      params: {
        resamples: bootstrap.resamples,
        level: Math.round(bootstrap.confidenceLevel * 100),
        seconds: Math.round(bootstrap.durationMs / 100) / 10,
      },
    },
  ];

  if (bootstrap.failed > 0) {
    /*
     * Resamples that failed to converge are a property of the model rather than
     * an incident. A model that fails on one draw in twenty is fragile, and the
     * reader should weigh the intervals accordingly.
     */
    const percent = Math.round((bootstrap.failed / (bootstrap.resamples + bootstrap.failed)) * 100);

    findings.push({
      key: 'analysis.pls.report.bootstrap.failures',
      severity: percent > 5 ? 'attention' : 'ok',
      params: { failed: bootstrap.failed, percent },
    });
  }

  /* Reproducibility: the seed is what lets a thesis produce the same numbers twice. */
  findings.push({
    key: 'analysis.pls.report.bootstrap.seed',
    severity: 'ok',
    params: { seed: bootstrap.seed },
  });

  return { titleKey: 'analysis.pls.report.section.bootstrap', findings };
}

/* -------------------------------------------------------------------------- */
/*                                  Verdict                                   */
/* -------------------------------------------------------------------------- */

/**
 * The one line at the top.
 *
 * Counts problems rather than averaging severities, because a model with one
 * serious validity failure is not "mostly fine" — that failure is what a
 * reviewer will write about.
 */
function overallVerdict(sections: ReportSection[]): PlsReport['verdict'] {
  const findings = sections.flatMap((section) => section.findings);
  const problems = findings.filter((finding) => finding.severity === 'problem').length;
  const attention = findings.filter((finding) => finding.severity === 'attention').length;

  if (problems > 0) {
    return {
      severity: 'problem',
      key: 'analysis.pls.report.verdict.problems',
      params: { problems, attention },
    };
  }

  if (attention > 0) {
    return {
      severity: 'attention',
      key: 'analysis.pls.report.verdict.attention',
      params: { attention },
    };
  }

  return { severity: 'ok', key: 'analysis.pls.report.verdict.sound', params: {} };
}

/* -------------------------------------------------------------------------- */
/*                                  Support                                   */
/* -------------------------------------------------------------------------- */

function round(value: number, digits = 3): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : Number.NaN;
}

/** APA convention: "< .001" rather than a string of zeros. */
function formatP(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '< .001' : p.toFixed(3);
}

function verdictLabel(verdict: Verdict): string {
  return verdict;
}

export type { Criterion, IndicatorAssessment };
