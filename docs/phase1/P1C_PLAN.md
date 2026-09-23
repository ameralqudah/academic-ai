# P1-C plan: deterministic statistics engine + Research Graph integration

**Date:** 2026-09-23 · **Base:** `main` at `a8b867c` (P0, P1.0, P1-A, P1-A.1, P1-B merged).

**Scope note.** `PHASE1_PLAN.md` named P1-C "tool registry + policy engine". The P1-C brief (2026-09-23) redefines it as the deterministic statistics engine and its graph integration. The analysis part of the tool boundary (`stats.*` tools) is included here; the general tool registry and policy engine are not.

**Goal.** A research number reaches a manuscript only through this chain, and every link is recorded:

```
dataset → dataset version (immutable, hashed) → recorded transformations → validation
→ analysis specification (typed, hashed) → deterministic engine (named, versioned)
→ analysis run (immutable) → results (typed, immutable) → tables / figures
→ Research Graph → manuscript
```

The LLM may propose specifications and explain verified results. It is never the source of a number.

---

## 1. Audit

The audit was done in four parts:

- statistical algorithms;
- the data layer;
- where numbers come from;
- graph provenance, R and jobs.

File references are to `main` at `a8b867c`.

### 1.1 Existing capabilities and algorithms (`src/analysis`)

| Capability | State | Algorithm | Tested against |
|---|---|---|---|
| Descriptives | Partial | SD/variance n−1; skew **G1** (adjusted), kurtosis **G2** (adjusted, excess), quantile type 7. `DescriptiveRow` has no median or variance. | Only trivial values; nothing distinguishes G1 from g1 |
| Cronbach α, corrected item-total, α-if-deleted, standardised α, Feldt CI | Exists | listwise | Hard-coded values |
| CR / AVE | Exists (PLS, CFA) | CFA standardises with **observed** variances (`cfa.ts:968, 1075`); lavaan std.all uses the implied Σ | Not compared with lavaan std.all, although the fixture contains it |
| PLS "Cronbach α" | Partial | Computed from **loading products**, not from indicator correlations (`assessment.ts:135-150`) | Properties only |
| HTMT, Fornell-Larcker, cross-loadings | Exists | HTMT uses absolute correlations | semTools (1e-10) |
| VIF | Exists | OLS; PLS formative and inner | statsmodels, R `lm` |
| Pearson / Spearman | Exists | t on n−2, Fisher-z CI, pairwise; Holm/BH/Bonferroni | SciPy |
| OLS regression | Partial | QR; SE, t, p, CI, β, R², adj R², F. Durbin-Watson on row order, **judged against a 1.5–2.5 band** (misleading for surveys). Heteroscedasticity is a **heuristic** correlation. **No Cook's distance, leverage or Breusch-Pagan.** | statsmodels |
| One-way ANOVA | Exists | classical and Welch F, Levene; Tukey-Kramer; η², ω². **Post-hoc gate fixed at 0.05.** **No Games-Howell.** | SciPy, statsmodels |
| t-tests, χ², Fisher 2×2, nonparametric, logistic | Exist | — | SciPy / statsmodels |
| **EFA** (KMO, Bartlett, extraction, rotation) | **Missing** | — | — |
| CFA | CFA only | ML (Wishart), marker, expected-information SE | lavaan 0.6-17 fixtures (estimates 1e-4, fit 1e-5) |
| Full CB-SEM with structural paths | **Missing** | — | — |
| PLS-SEM + bootstrap | Exists | Lohmöller; seeded Mulberry32 (seed recorded, default 20260101) | Properties; same seed gives same result |
| PLS blindfolding Q² | **Non-standard** | SSE/SSO over in-sample scores, not over the omitted data points | Behavioural only |
| **Mediation** | **Missing** | — | — |
| **Moderation** | **Missing** | — | — |

**Randomness.** The only `Math.random` in `src` is gateway retry jitter. The PLS bootstrap is the only resampling, and it is seeded.

### 1.2 Data layer

- **Rows** are stored as a re-serialised CSV in object storage. `datasets.checksum` (SHA-256) is stored but **never verified on read**. Types and profiles are **re-inferred on every load**, and users cannot override them.
- **Versions.**
  - There is no relational version entity. A dataset is `ORIGINAL` plus at most one `CLEANED` child. Cleaning a cleaned dataset is refused.
  - **The cleaning actions and their report are not persisted.** Parameters such as the imputed value or outlier rule are implicit, removed-row lists are capped at 50, and `kind` is a free string from the client.
  - The graph `dataset_version` node is never populated.
- **Silent value changes:**
  - `toNumber('3,5')` returns **35** (`stats-core.ts:131`).
  - Literal categories such as "None" or "NA" become missing without notice.
  - Extra CSV fields and blank XLSX rows are dropped without being counted.
  - `numericColumn`/`groupedColumn` drop cells before the engine sees them, so t-tests, ANOVA, Mann-Whitney and Kruskal-Wallis report `rowsDropped: 0` (`statistics.service.ts:202-253`).
  - Analyses silently use only the first 5,000 rows.
- **Missing → 0.** No data path turns a blank into 0 (`numericColumns` maps it to NaN, with a regression test). The remaining zero paths are the PLS standardisation of a constant composite and isolated constructs.
- **Validation** exists for sample size, duplicates, empty and constant columns, missing values, outliers, mixed types and inconsistent categories. **It is missing** near-zero variance, declared ranges or scales, invalid category codes, profile-level multicollinearity, ragged rows, and per-analysis gating.

### 1.3 Where numbers come from, and the paths to close

| # | Path | Where |
|---|---|---|
| N-1 | `analysis_runs` has no dataset version or hash, no engine version and no seed; runs can be deleted, and attach/detach mutates them | `schema.ts:715-744`, `analysis-runs.repository.ts:114-137` |
| N-2 | PLS and CB-SEM results are never stored as runs (only in chat payloads, task outputs or the mutable `analysis_jobs.result`) | `pls.service.ts:189-316`, `handlers.ts:702-795` |
| N-3 | Descriptives, profiles and charts carry no run id | `data-analysis.service.ts:143-160` |
| N-4 | Manuscript RESULTS text is LLM prose that retypes numbers; the statistics check is **disabled** for RESULTS and CHAPTER_4, and nothing compares numbers with runs | `ai.service.ts:358-430` |
| N-5 | Task `document.write` sends `JSON.stringify(result).slice(0, 2000)` (which can be cut mid-number) and saves the prose | `handlers.ts:843-848` |
| N-6 | Section PATCH accepts any content, with `origin` and `APPROVED` status chosen by the client | `api/projects/[id]/sections/[key]` |
| N-7 | The planner can write `input.table` (exported as data) and `input.model` for PLS/CB-SEM | `handlers.ts:688, 763, 1293-1301` |
| N-8 | Exports and chart SVGs carry no provenance | `export.service.ts`, `generators/analysis-sections.ts`, `plots.ts` |
| N-9 | The graph `recordRun` is never called by an engine | `graph/service.ts:976` |
| N-10 | `projectId` / `conversationId` in the upload, analyze, analysis-runs PATCH and PLS routes is **not verified** against the user | data audit §9 |
| N-11 | Job races: `markRunning`, `complete` and `fail` are unconditional, so a cancel can be overwritten; job data is loaded at run time rather than pinned at submit time | `analysis-jobs.repository.ts:67-121`, `pls.service.ts:449` |

Never sent to an LLM (kept): dataset rows. Only names, counts and column types go.

### 1.4 Research Graph

- `recordRun(projectId, engineActor, {analysisId, datasetVersionIds, run, results[], supersedesRunId})` writes, in one transaction:
  - the run, with `provenance=computed`;
  - pinned `executes` and `uses_data` edges;
  - results with `produced_by`, `tests` and `contains_value` edges.
- It freezes the data lineage. Immutability is enforced in the service and by database triggers.
- Supersede and currency already make claims `not_current` when their data or run is replaced.
- **Gaps:**
  - no engine caller;
  - no idempotency (a job retry would record twice);
  - `result_value` holds only `stat, value, df, p, ci`, with no SE, statistic, key or run reference;
  - `result_table`, `figure` and `dataset` accept any payload;
  - failed runs are not recorded.

### 1.5 R, dependencies, jobs

- **R 4.3.3, lavaan 0.6.17 and semTools 0.5.6 exist on the development machine only.** Production (Render/Vercel, Node runtime, no Dockerfile) and CI have **no R and no Python**. R is used only by a hand-run reference generator (`scripts/references/generate.R`); the output is committed as JSON.
- **npm dependencies:** no statistics libraries; all numerics are in-house.
- **Jobs:** pg-boss queues `analysis-job-run` / `task-run` / reaper. Analysis job kinds are `pls.bootstrap` and `research.deep`. Leases, singleton keys and retry limits exist.

---

## 2. Decisions

1. **The TypeScript engine stays the runtime engine; no R at runtime in P1-C.**
   - No P1-C method needs R for correctness. Every method is either already validated against lavaan (CFA) or an OLS/linear-algebra method verifiable against base R: EFA via PAF plus varimax/promax, and mediation and moderation via OLS.
   - Shipping an R path that no production image can run would be a false capability.
   - What P1-C adds is the **engine boundary**: every run records engine id, engine version and runtime, and method adapters sit behind one interface, so an R worker (architecture P2-E) plugs in as another engine.
   - **References come from R.** `scripts/references/generate.R` is extended for EFA, regression diagnostics, Games-Howell, moderation, mediation, CFA std.all and descriptives. The output is committed as JSON and checked in CI without R.
   - **Full CB-SEM with structural paths is deferred to the R worker.** It is not approximated in TypeScript.
2. **Relational tables are the source of truth for data versions, specifications, runs and results.** They work with the graph flag off. When `FF_GRAPH` is on and the run belongs to a project, the run is also recorded in the graph through `recordRun` (engine actor, idempotent). Tables, figures and manuscript claims are graph nodes linked to result values.
3. **The new API and UI sit behind `FF_GRAPH`** (the `/api/v1` workspace surface). Correctness and security fixes to the legacy paths are always on. The fixes are:
   - parsing;
   - rows-dropped reporting;
   - project authorisation;
   - job races;
   - version pinning of legacy runs.
4. **Historical results are never mutated.** Database triggers make specifications, runs (after completion), estimates, tables, versions and transformations write-once. A re-run is a new run that may supersede an older one, and the graph marks dependents stale.
5. **Missing data is listwise by default.** The strategy is part of the specification and recorded on the run. Pairwise is allowed for correlation only. No imputation happens inside an analysis. Imputation is a recorded transformation that creates a new dataset version.

---

## 3. Architecture (`src/server/stats/` for server layers, `src/analysis/` for the pure engine)

| Layer | Module | Contents |
|---|---|---|
| Data | `src/server/stats/versions.ts`, tables `dataset_versions`, `dataset_transformations` | The upload creates v1 (import transformation: parse settings, missing tokens and counts, ragged rows, row caps). Transformations create v(n+1). Loading verifies the hash. Column schema snapshot with user type overrides (a recorded `set-types` transformation). |
| Validation | `src/analysis/engine/validate.ts` | Dataset quality report and per-specification checks, as structured issues `{code, severity: INFO\|WARNING\|ERROR\|BLOCKING, columns, message en/ar, details}`. BLOCKING or ERROR stops the run. |
| Specification | `src/analysis/engine/spec.ts` | zod discriminated union per analysis type, with defaults resolved and a canonical hash. |
| Computation | `src/analysis/engine/methods/*` | Pure, deterministic adapters over existing modules plus the new EFA, mediation and moderation. Seeded RNG only. |
| Normalisation | `src/analysis/engine/result.ts` | `NormalisedResult`: typed estimates (key, term, estimate, SE, statistic, df, p, CI, effect size), model metrics, warnings, method payload, canonical result hash. |
| Provenance | `src/server/stats/runs.ts`, tables `stat_specs`, `stat_runs`, `stat_estimates`, `stat_tables`, `stat_figures` | Immutable run record: dataset version and hash, specification and hash, engine and version, runtime, parameters, seed, missing strategy, n input/used/excluded, timings, job, supersedes. |
| Graph | `src/server/stats/graph.ts` | Maps runs to `dataset_version`, `analysis`, `analysis_run`, `result_value`, `result_table` and `figure` nodes through `recordRun`, idempotent on run id. |
| Tables / figures | `src/analysis/engine/tables.ts`, `figures.ts` | APA tables and SVG figures generated only from stored estimates. Cells reference estimate keys. |
| Manuscript | `src/server/stats/manuscript.ts` | Inserts a graph claim with a deterministic sentence and `reports` edges. The narrative uses `{{value:key}}` tokens rendered from estimates. A validator rejects free-typed statistics. |
| LLM tools | `src/server/stats/tools.ts` | `createAnalysisSpec`, `validateAnalysisSpec`, `runAnalysis`, `getAnalysisResult`, `getAnalysisProvenance`, `generateTableFromResult`, `generateFigureFromResult`, through the Model Gateway (`toolCall` / `generateStructured`) with project authorisation. **There is no tool that writes numbers.** |
| Jobs | existing `analysis_jobs` + dispatch | New kind `stats.run`: idempotent on run id; lease, cancel, reaper. Status transitions become conditional (fixes N-11 for all kinds). |

## 4. Methods in P1-C

**Hardened (existing):**

- Descriptives: add median and variance, and a test that tells G1 from g1.
- PLS α: computed from observed indicator correlations. Isolated PLS constructs are rejected.
- CFA standardised solution: from implied variances, checked against lavaan std.all; CR and AVE follow from it.
- Regression: add Cook's distance, leverage and Breusch-Pagan (Koenker). Durbin-Watson is reported as INFO, not judged.
- ANOVA: add Games-Howell; the post-hoc gate uses the specification's α.
- Blindfolding Q²: labelled non-standard and excluded from verified tables until a standard implementation exists.

**New:**

- **EFA:** KMO (overall and MSA), Bartlett's sphericity; extraction by PAF (iterated) or PCA; eigenvalues, parallel-analysis-free retention (Kaiser or fixed k, recorded); varimax or promax rotation (as R `stats`); loadings, communalities, variance explained, factor correlations (promax).
- **Mediation:** simple mediation (PROCESS model 4): a, b, c, c′, indirect a·b; percentile bootstrap CI with an explicit seed and B; Sobel as a secondary result; completely standardised effects.
- **Moderation:** PROCESS model 1: interaction term, optional mean-centring (recorded), conditional effects at −1 SD, mean and +1 SD (or 0/1 for a binary moderator) with SE, t, p and CI from the covariance matrix.

**Deferred (not claimed):**

- full CB-SEM with structural paths;
- robust estimators and modification indices;
- standard Stone-Geisser Q²;
- Johnson-Neyman;
- serial, parallel or moderated mediation;
- factorial ANOVA, ANCOVA and MANOVA;
- Dunn, Friedman and McNemar;
- exact Wilcoxon;
- Hosmer-Lemeshow;
- categorical predictor coding.

## 5. Tests

- **`scripts/stats-engine.ts`** (new, CI checks job): unit and golden tests per method against R references (1e-6 for closed-form results, method-specific tolerances otherwise). Also covers edge cases (constant, all missing, n < p, singular matrices), determinism (same seed gives the same result hash), normalisation, spec hashing, validation issues and tables/figures from results.
- **`scripts/stats-integration.ts`** (new, CI database job):
  - upload → v1 → transformation → v2 → specification → run → estimates → tables → graph → manuscript claim;
  - staleness on a new data version and on re-runs;
  - immutability, enforced by triggers;
  - idempotent jobs;
  - cancellation;
  - cross-project isolation;
  - manual results never shown as verified;
  - LLM tool boundaries.
- **Existing suites stay unchanged** except where a legacy behaviour is intentionally fixed (documented in the report).
- **Browser:** one `FF_GRAPH=true` test for the minimal analysis page; skipped when the flag is off.

## 6. Out of scope

- P1-D, the general tool registry and policy engine, and the agent loop;
- the R worker service;
- a workspace redesign;
- enabling `FF_GRAPH` in production.
