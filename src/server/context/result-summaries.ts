/**
 * What a stored result says, in a line or two a model can read.
 *
 * An analysis turn is saved as a structured payload with no text — the
 * interface redraws the table from it — and the context builder, which reads
 * text, skipped it entirely. "Explain these results", asked straight after a
 * t-test, reached a model that had never seen the t-test. This is the bridge:
 * the numbers themselves, not a description of them, because an explanation is
 * only as good as the figures it is given.
 *
 * Pure and defensive. Payloads were written by several versions of several
 * services; a field that is missing produces a shorter line, never a throw.
 */

type Payload = Record<string, unknown>;

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function fixed(value: unknown, digits = 3): string {
  const n = num(value);
  return n === null ? '?' : n.toFixed(digits);
}

/** p as reported: "< .001" below a thousandth, three decimals otherwise. */
function pValue(value: unknown): string {
  const p = num(value);
  if (p === null) return '?';
  return p < 0.001 ? '< .001' : p.toFixed(3);
}

function df(value: unknown): string {
  if (Array.isArray(value)) return value.map((part) => fixed(part, 2).replace(/\.00$/, '')).join(', ');
  return fixed(value, 2).replace(/\.00$/, '');
}

function analysis(payload: Payload): string {
  const statistic = (payload.statistic ?? {}) as Payload;
  const effect = (payload.effect ?? null) as Payload | null;
  const variables = Array.isArray(payload.variables) ? payload.variables.map(str).filter(Boolean) : [];
  const estimates = Array.isArray(payload.estimates) ? (payload.estimates as Payload[]) : [];

  const parts = [
    `${str(payload.test) || 'analysis'}${variables.length ? ` on ${variables.join(', ')}` : ''}`,
    `${str(statistic.name) || 'statistic'} = ${fixed(statistic.value)}`,
    ...(payload.df !== undefined ? [`df = ${df(payload.df)}`] : []),
    `p ${pValue(payload.pValue).startsWith('<') ? '' : '= '}${pValue(payload.pValue)}`,
    ...(effect ? [`${str(effect.name) || 'effect'} = ${fixed(effect.value)}${str(effect.band) ? ` (${str(effect.band)})` : ''}`] : []),
    ...(num(payload.n) !== null ? [`n = ${payload.n}`] : []),
  ];

  const groups = estimates
    .slice(0, 8)
    .map((estimate) => `${str(estimate.label)}: M = ${fixed(estimate.mean, 2)}, SD = ${fixed(estimate.sd, 2)}, n = ${num(estimate.n) ?? '?'}`);

  const secondary = payload.secondary as Payload | undefined;
  const extra = secondary
    ? [`${str(secondary.label)}: ${str((secondary.statistic as Payload)?.name)} = ${fixed((secondary.statistic as Payload)?.value)}, p ${pValue(secondary.pValue)}`]
    : [];

  return [parts.join(', '), ...groups, ...extra].join('; ');
}

function reliability(payload: Payload): string {
  return [
    `Cronbach's alpha = ${fixed(payload.alpha)}`,
    ...(num(payload.standardisedAlpha) !== null ? [`standardised = ${fixed(payload.standardisedAlpha)}`] : []),
    ...(str(payload.band) ? [`(${str(payload.band)})`] : []),
    ...(num(payload.itemCount) !== null ? [`${payload.itemCount} items`] : []),
    ...(num(payload.sampleSize) !== null ? [`n = ${payload.sampleSize}`] : []),
  ].join(', ');
}

function recommendation(payload: Payload): string {
  const best = payload.best as Payload | null;
  const basis = (payload.basis ?? {}) as Payload;
  const dependent = basis.dependent as Payload | null;
  const grouping = basis.grouping as Payload | null;
  const independents = Array.isArray(basis.independents) ? (basis.independents as Payload[]) : [];

  const variables = [
    dependent ? `outcome ${str(dependent.column)} (${str(dependent.scale)})` : '',
    grouping ? `groups ${str(grouping.column)} (${num(grouping.levels) ?? '?'} levels)` : '',
    independents.length ? `predictors ${independents.map((entry) => `${str(entry.column)} (${str(entry.scale)})`).join(', ')}` : '',
  ].filter(Boolean);

  return `${best ? `recommended test: ${str(best.test)}` : 'no test could be recommended'}${variables.length ? ` — ${variables.join('; ')}` : ''}`;
}

function profile(payload: Payload): string {
  const columns = Array.isArray(payload.columns) ? (payload.columns as Payload[]) : [];
  const rows = num(payload.rowCount);
  return `${rows !== null ? `${rows} rows, ` : ''}${columns.length} columns: ${columns
    .slice(0, 40)
    .map((column) => `${str(column.name)} [${str(column.type)}${str(column.scale) ? `, ${str(column.scale)}` : ''}]`)
    .join(', ')}`;
}

function pls(payload: Payload): string {
  /* The compact estimates, written alongside the report since this change. */
  const estimates = payload.estimates as Payload | undefined;
  if (estimates) {
    const paths = Array.isArray(estimates.paths) ? (estimates.paths as Payload[]) : [];
    const r2 = Array.isArray(estimates.rSquared) ? (estimates.rSquared as Payload[]) : [];
    return [
      `PLS-SEM${num(estimates.n) !== null ? `, n = ${estimates.n}` : ''}`,
      ...paths.map((path) => `${str(path.from)} → ${str(path.to)}: β = ${fixed(path.coefficient)}`),
      ...r2.map((entry) => `R²(${str(entry.construct)}) = ${fixed(entry.rSquared)}`),
    ].join('; ');
  }

  /* Older turns: the report's own tables, which carry the same figures. */
  const report = (payload.report ?? payload) as Payload;
  const sections = Array.isArray(report.sections) ? (report.sections as Payload[]) : [];
  const lines = sections.flatMap((section) => {
    const table = section.table as Payload | undefined;
    const rows = Array.isArray(table?.rows) ? (table.rows as unknown[][]) : [];
    if (rows.length === 0) return [];
    const title = str(section.titleKey).split('.').pop() ?? '';
    return [`${title}: ${rows.slice(0, 12).map((row) => row.map((cell) => (typeof cell === 'number' ? cell.toFixed(3) : String(cell))).join(' ')).join(' | ')}`];
  });
  return ['PLS-SEM', ...lines].join('; ');
}

function sources(payload: Payload, label: string): string {
  const list = Array.isArray(payload.sources) ? (payload.sources as Payload[]) : [];
  if (list.length === 0) return `${label}: no sources found`;
  return `${label} (${list.length}): ${list
    .slice(0, 10)
    .map((source, index) => {
      const year = num(source.year);
      const doi = str(source.doi);
      return `[${num(source.index) ?? index + 1}] ${str(source.title)}${year ? ` (${year})` : ''}${doi ? ` doi:${doi}` : ''}`;
    })
    .join('; ')}`;
}

/**
 * One stored result as text, or null for kinds that carry nothing a later
 * turn would reason from (a progress event, a clarifying question).
 */
export function summariseResult(kind: string, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Payload;

  switch (kind) {
    case 'analysis':
      return `Analysis result — ${analysis(data)}`;
    case 'reliability':
      return `Reliability result — ${reliability(data)}`;
    case 'recommendation':
      return `Test recommendation — ${recommendation(data)}`;
    case 'profile':
      return `Dataset profile — ${profile(data)}`;
    case 'pls':
    case 'plsReport':
      return `Analysis result — ${pls(data)}`;
    case 'cbsem': {
      const fit = (data.fit ?? {}) as Payload;
      const indices = Object.entries(fit)
        .filter(([, value]) => num(value) !== null)
        .slice(0, 8)
        .map(([key, value]) => `${key} = ${fixed(value)}`);
      return `Analysis result — CB-SEM${indices.length ? `: ${indices.join(', ')}` : ''}`;
    }
    case 'literature':
      return sources(data, 'Literature found');
    case 'research': {
      const gaps = Array.isArray(data.remainingGaps) ? data.remainingGaps.map(str).filter(Boolean) : [];
      return `${sources(data, `Deep research on "${str(data.question)}"`)}${gaps.length ? `; unanswered: ${gaps.slice(0, 4).join('; ')}` : ''}`;
    }
    case 'webSources':
      return sources(data, 'Web sources');
    default:
      return null;
  }
}

/** Every result in a message payload, summarised; empty when there are none. */
export function summarisePayload(payload: unknown): { kind: string; runId?: string; text: string }[] {
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((entry) => {
    const result = (entry ?? {}) as Payload;
    const text = summariseResult(str(result.kind), result.payload);
    return text ? [{ kind: str(result.kind), ...(str(result.runId) ? { runId: str(result.runId) } : {}), text }] : [];
  });
}
