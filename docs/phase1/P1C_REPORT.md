# P1-C report: deterministic statistics engine + Research Graph integration

**Date:** 2026-09-23 · **Plan and audit:** `docs/phase1/P1C_PLAN.md` · **Branch:** `claude/stoic-wozniak-5l0xmv` · **Status:** implemented and adversarially reviewed; all review findings fixed; full regression green locally (see §15 for the one dev-only `npm audit` change since P1-B). **Merged into `main` via [#32](https://github.com/ameralqudah/academic-ai/pull/32) (merge commit `b1a294f`; PR head `d8882c5`, all CI checks green). P1-D has not been started.**

**Scope note.** `PHASE1_PLAN.md` and `TARGET_ARCHITECTURE.md` named P1-C "Tool Registry + policy engine". The P1-C brief re-scoped it to the deterministic statistics engine and its graph integration. Of the tool work, only the analysis tool boundary (7 `stats` tools) is here. The general tool registry and policy engine moved out of P1-C and have not been built.

**The chain.** A research number now reaches a manuscript only this way, and every link is stored:

```
upload → dataset version (immutable, hashed, file checksum verified on read)
→ recorded transformations (import / set-schema / clean) → validation (INFO…BLOCKING)
→ specification (typed, canonical, hashed, seeded) → engine (named, versioned, pure)
→ run (immutable, pinned to version + content hash + spec hash + engine + seed)
→ estimates / tables / figures (write-once, generated only from estimates)
→ Research Graph (computed nodes, idempotent) → manuscript claim ({{value:key}} tokens)
```

An LLM can propose a specification, validate it, start a run, read results and provenance, and explain a verified result using tokens. It cannot produce a number that is stored or shown as a result.

---

## 1. Implementation summary

| Layer | Where | What it does |
|---|---|---|
| Pure engine | `src/analysis/engine/` (`types`, `data`, `numerics`, `spec`, `validate`, `run`, `tables`, `figures`, `methods/{classical,efa,process,latent}`) | Deterministic functions from (specification, dataset) to a normalised result. No I/O, no clock, no `Math.random` (a smoke gate enforces this). Named `academic-ai-ts-core` 1.0.0. |
| Data versions | `src/server/stats/versions.ts`; tables `dataset_versions`, `dataset_transformations` | The upload creates v1 through an `import` transformation that records the parser's read report. Each transformation writes a new version with its own file, content hash, schema hash and file checksum. Loading verifies the checksum and the content hash. |
| Specifications and runs | `src/server/stats/runs.ts`; tables `stat_specs`, `stat_runs`, `stat_estimates`, `stat_tables`, `stat_figures` | `createSpec` parses and hashes the specification and assigns a deterministic seed. `startRun` is idempotent and runs inline or as a job. `executeRun` claims the run, computes, and writes estimates, tables, figures and the `succeeded` status in one transaction. The graph is recorded afterwards. |
| Graph | `src/server/stats/graph.ts` + additive changes in `src/server/graph/` | Versions, specifications, runs, values, tables and figures become graph nodes through `recordRun` (engine actor, idempotent). Replacing data or a run uses the Impact Report protocol. |
| Manuscript | `src/server/stats/manuscript.ts`, `src/lib/statistics-text.ts` | Numbers are written as `{{value:key}}` tokens and rendered from the stored estimate. A typed statistic is refused. A claim is created atomically with its `reports` edges. |
| LLM tools | `src/server/stats/tools.ts`, `tool-names.ts` | 7 tools through the Model Gateway. No tool writes a number. Model text with a typed digit is withheld. |
| Jobs | `stats.run` kind on the existing `analysis_jobs` / pg-boss queue | Heavy runs are queued, leased and reaped. There is no second queue. |
| API | 15 routes under `/api/v1/projects/[projectId]/…` | Behind `FF_GRAPH`, `withApi`, rate limits and a body cap. |
| UI | `/[locale]/projects/[id]/analysis` (`stats-workbench.tsx`) | A minimal workbench, behind `FF_GRAPH`. |

**Commits** (on top of `main` at `a8b867c`):

- `6b27e0e` — plan;
- `928a66f` — pure engine;
- `f96aed0` — versions, runs, graph and tools;
- `b7f0331` — API, UI and legacy fixes;
- `2c381ef` — legacy number paths and smoke gates;
- `93d46ea` — adversarial-review fixes.

In total, about 80 files changed and about 14.8k lines added.

## 2. Audit findings

These are summarised from `P1C_PLAN.md` §1, which has the full tables.

| # | Finding | Resolution |
|---|---|---|
| Algorithms | CFA standardised with observed variances, not implied; PLS α from loading products; Durbin-Watson judged against a band; heteroscedasticity heuristic; post-hoc gate fixed at 0.05; no EFA, mediation, moderation, Games-Howell, Cook's D, leverage or Breusch-Pagan; Q² non-standard | Fixed or added (§4). Q² is excluded from verified results. |
| Data | `toNumber('3,5')` = 35; no version entity; cleaning parameters not stored; checksum never verified; ragged rows and missing markers not counted; `rowsDropped: 0` on legacy tests | Fixed (§3, §9). |
| N-1 | Legacy `analysis_runs` not pinned to data or engine | Now pinned to dataset version, content hash and engine version. |
| N-2, N-3 | PLS, CB-SEM and descriptives outside any run record | The new engine records all of them. The legacy paths are unchanged and are not called "verified" (§20). |
| N-4 | RESULTS and CHAPTER_4 text retypes numbers unchecked | The guardrail now requires every statistic in those sections to match a number of an attached run (`UNTRACED_STATISTIC`). |
| N-5 | Task results truncated mid-number (`slice(0, 2000)`) | `boundedJson` drops whole entries, never part of a number. |
| N-6, N-7 | Client-written section content; planner can write tables and models | Not changed. These are legacy authoring paths, outside the verified chain (§20). |
| N-8 | Exports and SVGs without provenance | New tables and figures name their estimate keys and run. Legacy exports are unchanged (§20). |
| N-9 | `recordRun` never called | Called by `recordRunInGraph` for every succeeded run in a project with `FF_GRAPH` on. |
| N-10 | `projectId` / `conversationId` not verified on upload, analyze, PLS and attach | `assertProjectLink` (EDITOR) / `assertConversationLink` on every such path. |
| N-11 | Job status changes unconditional, so a late finish could overwrite a cancel | `markRunning` / `complete` / `fail` are conditional and return whether they applied. |

> **WS2 note (2026-09-26).** The table above is kept as written at P1-C. The legacy-path rows were changed by WS2 (`WS2_REPORT.md`). WS2's findings N1–N11 are a separate audit's numbering.
> - **N-2, N-3.** PLS and CB-SEM record their provenance (WS2 B2), and the descriptive tables of task analyses record the provenance of the data read (B4).
> - **N-4.** Generated sections are quarantined before saving (A4), with a stored record (B1).
> - **N-6, N-7.** The section edit endpoint accepts only DRAFT/USER_EDITED and records the origin as USER (A2). Planner-written tables are no longer an export source (B4, WS2-D5).
> - **N-8.** Task XLSX/CSV are built from eligible results only (B4). Word exports carry an Integrity and Provenance Appendix (B5).
>
> None of these paths is labelled verified.

**Adversarial review (before this report).** A four-part review of the finished branch found 3 high, 7 medium and several low findings. It found no errors in the engine methods and no cross-project access path. All were fixed in `93d46ea`:

| Sev. | Finding | Fix |
|---|---|---|
| High | The smoke test imported the database, so it would fail in CI's checks job | Tool names moved to the database-free `tool-names.ts`; smoke passes without `DATABASE_URL`. |
| High | The typed-number filter missed Arabic-Indic digits, comma decimals and "β = 1" | New `src/lib/statistics-text.ts` normalises digits, handles symbols in any script and has a strict mode for model text. Used by claims, explanations and the legacy guardrail. |
| High | `insertClaim` was not atomic (a claim could exist without its evidence) | `graph.createClaim` does it in one transaction, with currency checks. |
| Med | Runs could be left in `running` (duplicate keys, persistence errors, dead jobs) | Keys are checked before the write; a persistence error becomes `failed`; `reapStatRuns` settles runs whose job failed or was cancelled, and stale inline runs. |
| Med | Two concurrent `clean` transformations could write the same object key | Version keys include a UUID. |
| Med | A deleted dataset's versions stayed usable and their files stayed on disk | Refused on use; deleted with the dataset; `deletionImpact` reports `verifiedRuns`. |
| Med | Impact acknowledgement race (the report could change between preview and commit) | The hash is re-checked at commit (`impact_changed`). |
| Med | Missing codes compared as text (`99` did not match `99.0`) | Compared numerically when both sides are numbers. |
| Med | A caller could force heavy work inline | Heavy work always goes to a job; at most 3 active jobs per user. |
| Med | A run could supersede an unrelated run | Only the same analysis type on the same dataset. |
| Low | SQL gaps | An insert guard stops a run being inserted as `succeeded`; `TRUNCATE` is refused on all 7 tables. |
| Low | A graph retry could not map table and figure nodes | Their nodes now carry `key`. |
| Low | Duplicate construct names or shared indicators | ERROR for CFA and PLS. |

**Found while testing the fixes.** After v2 was replaced by a cleaned v3 derived from it, runs on v3 could not be recorded in the graph. The currency walk saw v3 `derived_from` a superseded v2 and marked it stale. The earlier test only checked `status`, so this was missed; it now also checks graph recording and currency. The fix (§3, "changes to completed phases") treats a superseded node as not stale when its replacement is in the dependent's own dependency chain. A sibling version derived from v2 still goes stale (tested).

## 3. Architecture changes

- **New tables** (migration `drizzle/0013_p1c_statistics.sql`, additive):
  - `dataset_versions`, `dataset_transformations`;
  - `stat_specs`, `stat_runs`, `stat_estimates`, `stat_tables`, `stat_figures`;
  - new columns on `analysis_runs`: `dataset_version_id`, `dataset_content_hash`, `engine_version`.
- **Enforced by PostgreSQL** (25 triggers plus CHECK constraints):
  - Specifications, versions, transformations, estimates, tables and figures are write-once. The only exception is a graph id, which can be filled in once.
  - Direct `DELETE` is refused; only foreign-key cascades pass (`pg_trigger_depth() > 1`).
  - `TRUNCATE` is refused.
  - A run is inserted `queued` with no outcome.
  - Status transitions are limited to queued → running → succeeded / failed / refused / cancelled. Identity columns cannot change. `succeeded` requires `result_hash` and `finished_at`.
  - Estimates, tables and figures can be inserted only while their run is `running`.
- **Graph (additive):**
  - payload fields on `dataset_version`, `analysis_run` and `result_value` (key, SE, statistic, n, CI method, reproducibility hashes);
  - strict schemas for `result_table` and `figure`;
  - `recordRun` idempotent on the engine run id;
  - `previewRerun`, `createClaim`.
- **Changes to completed phases.** Each was either needed by P1-C or a bug that P1-C exposed.

  | Phase | Change | Why |
  |---|---|---|
  | P1-A graph | `currency.ts`: a superseded upstream node is not stale when its replacement is in the dependent's dependency chain (optional `replacements` on the loader). | Blocker: without it, no run on replaced data could ever be recorded. Graph suite 170/170; 3 new unit checks in smoke. |
  | P1-A graph | `recordRun` idempotent; `createClaim`; `previewRerun`; payload fields. | Additive, needed by the engine write path. |
  | P0 jobs | Conditional `markRunning` / `complete` / `fail`. | N-11: a late finish could overwrite a cancel. |
  | Legacy statistics | `toNumber` refuses ambiguous decimal commas. CFA standardisation uses implied variances. PLS α comes from observed correlations. PLS rejects isolated constructs. Parser counts ragged rows and missing markers. | Correctness findings. They change legacy outputs; each is covered by a golden or regression test. |

## 4. Methods supported

"Supported" here means implemented in the engine, validated before it runs, stored as typed estimates, and tested. Golden values come from R 4.3.3 (`scripts/references/engine.R` → `evals/fixtures/references/engine.json`, committed; there is no R at test time).

| Method | Outputs | Checked against |
|---|---|---|
| Descriptives | n, missing, mean, median, SD, variance, min, max, skewness (G1), excess kurtosis (G2); NaN (never 0) when n is too small | base R, 1e-10 |
| Reliability | Cronbach α, standardised α, corrected item-total r, α-if-deleted | R formulas, 1e-10 |
| Correlation | Pearson and Spearman, p, Fisher-z CI, pairwise n; Holm / BH / Bonferroni | `cor.test`, 1e-8 to 1e-10 |
| OLS regression | b, SE, t, p, CI, β, R², adjusted R², F, RMSE, VIF, Cook's D, leverage, Breusch-Pagan (Koenker); Durbin-Watson as INFO | `lm`, `cooks.distance`, `hatvalues`, 1e-8 to 1e-10 |
| One-way ANOVA | F, Welch F, η², ω², Levene; Tukey-Kramer and Games-Howell post-hoc (auto-selected by Levene), gated by the specification's α | `aov`, `oneway.test`, `TukeyHSD`, `ptukey`; p within 2e-4 (studentised-range integration) |
| EFA | KMO and per-item MSA, Bartlett; PAF (iterated) or PCA; varimax or promax; communalities, variance explained, Φ; Kaiser or fixed retention | R formulas and `stats::varimax` / `stats::promax`; KMO 1e-10, PAF loadings 1e-5 |
| CFA | ML estimates, fit (χ², CFI, TLI, RMSEA, SRMR), standardised loadings (implied variance), CR, AVE, Fornell-Larcker, HTMT | lavaan 0.6-17 std.all 1e-4, fit 1e-5; semTools HTMT (`htmt2 = FALSE`) 1e-10 |
| PLS-SEM | paths, loadings, weights, R², α (from observed correlations), CR, AVE, HTMT, VIF; optional seeded bootstrap | Existing PLS suite (analysis 1,329) plus engine tests; Q² excluded |
| Mediation (PROCESS model 4) | a, b, c, c′, indirect a·b, total, Sobel, completely standardised effects; percentile bootstrap CI with a required seed | Paths: `lm` 1e-9. The bootstrap CI is **not** compared with R, because the RNGs differ. It is checked for determinism, seed sensitivity and bracketing the estimate. |
| Moderation (PROCESS model 1) | b, SE, p for X, W, X·W; optional centring; ΔR² and F change; conditional effects at −1 SD / mean / +1 SD (or 0/1) | `lm` + `vcov`, 1e-8 to 1e-10 |

The engine suite has 361 checks. Beyond the golden values, it covers edge cases, determinism and validation severities.

## 5. Methods deferred (not claimed)

These are not offered in the engine, and the UI and tools do not list them:

- **Structural models:** full CB-SEM with structural paths (deferred to an R worker, not approximated in TypeScript); robust estimators; modification indices.
- **PLS and mediation extensions:** standard Stone-Geisser Q² (the existing Q² is labelled non-standard and excluded); serial, parallel and moderated mediation.
- **Moderation and factor retention:** Johnson-Neyman; parallel analysis for EFA retention.
- **Other tests:** factorial ANOVA, ANCOVA and MANOVA; Dunn, Friedman and McNemar; exact Wilcoxon; Hosmer-Lemeshow; categorical predictor coding in regression.

The legacy tests (t-tests, χ², Fisher, nonparametric, logistic) keep working as before on the legacy path. They are not engine methods and are not marked "verified".

## 6. R integration status

- **Where R exists.** R 4.3.3 is on the development machine only, with lavaan 0.6.17 and semTools 0.5.6. psych and boot are not installed. Production (Render/Vercel Node runtime) and CI have no R and no Python.
- **R at runtime: none.** No P1-C method needs R for correctness, and a runtime path that no deployed image can run would be a false capability.
- **R for references.** `scripts/references/engine.R` generates the committed golden JSON. CI checks the engine against it without R. Where psych would normally be used (KMO, PAF), the reference implements the published formulas in base R.
- **Engine boundary.** Every run records engine id, engine version and runtime. An R worker (architecture P2-E) can be added as another engine behind the same specification and result contract; that is where full CB-SEM belongs.

## 7. Graph integration

- **Nodes created:**
  - a `dataset_version` node per version, with `derived_from` to its parent;
  - an `analysis` node per specification, with `specifies` → hypotheses;
  - an `analysis_run` node per succeeded run (`provenance = computed`, reproducibility hashes, `executes` / `uses_data`);
  - `result_value` nodes, capped at 600 per run (primary estimates get `tests` edges to the linked hypotheses);
  - `result_table` and `figure` nodes, with `contains_value` edges to the values they show.
- **Idempotent.** A retried job or a second worker gets the already-recorded run back, including table and figure mappings by `key`.
- **Staleness:**
  - Re-running a cited run needs the Impact Report acknowledged before anything is computed, and the hash is re-checked at commit. The old run becomes `superseded`; its claims become not current; the old numbers stay unchanged.
  - Replacing a dataset version (`/versions/[id]/replace`) supersedes it. Every run on it, and every claim built on those runs, becomes not current. Data derived from the replaced version is current only if it is the replacement.
  - A run on out-of-date inputs is not recorded as current evidence. Citing a replaced run is refused.
- **With `FF_GRAPH` off.** The relational tables are the source of truth and work as they do with the flag on, but nothing is written to the graph.

## 8. LLM / tool integration

- **Tools** (all through the Model Gateway `toolCall`, with project authorisation and `ai_tool_calls` records):
  - `createAnalysisSpec`, `validateAnalysisSpec`, `runAnalysis`;
  - `getAnalysisResult`, `getAnalysisProvenance`;
  - `generateTableFromResult`, `generateFigureFromResult`.
- **Refused tool names.** Anything else, including `updateResultNumbers`, is refused with `FORBIDDEN`. A runtime check asserts the tool list equals `STATS_TOOL_NAMES`. A test checks that no tool name suggests writing (write, update, overwrite, fake, set, edit, insert, delete).
- **Assistant** (`/analyses/assistant`). The model may propose and run analyses through the tools. Its final text is shown only if it contains no digit outside a token (strict mode, Arabic-Indic digits included). Otherwise the text is withheld with `{reason, count}`, and the typed spans are not echoed.
- **Explain** (`/runs/[id]/explain`). The prompt forbids digits. The model writes `{{value:key}}`. The server renders each token from the stored estimate, and unknown keys are refused. After one retry, text that still types numbers is refused (`CONFLICT`).
- **Legacy writing.** The RESULTS and CHAPTER_4 guardrail now flags any statistic that does not match a number of an attached verified run (`UNTRACED_STATISTIC`). It normalises digits and accepts comma decimals and "OR".
- **No bypass.** No P1-C path calls a provider directly (smoke gate from P1-B).

## 9. Provenance

- **What a run records:**
  - dataset version id, content hash and schema hash, and file checksum (through the version);
  - specification and specification hash;
  - engine id, engine version and runtime (Node version);
  - seed;
  - missing-data strategy and n input / used / excluded (with counts of missing, coded and invalid cells);
  - parameters actually used (for example the post-hoc test chosen);
  - timings, job id, superseded run, idempotency key, impact hash acknowledged;
  - result hash.
- **`GET …/runs/[id]/provenance`** returns the chain from the run through the specification and version lineage (each transformation with its parameters and report) back to the upload's `import`.
- **Tables and figures.** Every cell and every plotted value names its estimate key. Figures are served as inert SVG with a restrictive CSP.
- **Manuscript claims** `report` the exact `result_value` nodes, so "where did this number come from?" is a graph trace: claim → value → run → version → upload.

## 10. Reproducibility

- `(dataset content, specification, engine version, seed) → result hash` is deterministic. It is tested outside the service by recomputing with `execute()` and comparing the hash.
- **Canonical JSON:** keys sorted, NaN serialised as text. SHA-256 is used for content, schema, specification and result.
- **Seeds.** Randomised methods (mediation bootstrap, PLS bootstrap) must have a seed; the schema refuses mediation without one. A missing seed is filled deterministically from the specification when it is created, and recorded. Mulberry32 is the only RNG, and a smoke gate forbids `Math.random` in the engine.
- `getRun` returns `verified` (succeeded, not superseded) and `reproducible` (engine version equals the current engine).

## 11. UI changes

- **Page.** `/[locale]/projects/[id]/analysis` returns 404 when `FF_GRAPH` is off.
- **Workflow:** choose a dataset; see the quality report; pick an analysis and its variables; run it.
- **Result view:**
  - a "Verified by the engine" badge;
  - APA tables and SVG figures;
  - all values, each with a "cite" action that inserts a claim rendered from the stored value;
  - "Where did these numbers come from?" (provenance).
- **Other.** The project page links to the workbench when the flag is on. The new `stats` messages exist in English and Arabic.

## 12. Security changes

- **Authorisation.**
  - Every service function checks the project role itself: VIEWER to read, EDITOR to write.
  - A resource in another project returns 404.
  - A specification cannot link another project's hypotheses or constructs.
  - Legacy upload, analyze, attach, PLS, CB-SEM and bootstrap now verify `projectId` and `conversationId` ownership (N-10).
- **API.** All 15 routes use `withApi`, `FF_GRAPH` and rate limits (read 600/min, write 120/min, run 30/min, AI 20/min), with a 256 KB body cap (`maxBodyBytes`).
- **Numbers cannot be injected.** Database triggers refuse estimates written outside the engine's transaction and any change to a finished result; the service refuses typed numbers in claims and model text.
- **Data.** CSV only for versions. Rows are never sent to a model; only names, counts and types are. Figures are inert SVG with a CSP.

## 13. Performance / job changes

- **Cost model.** A run is estimated from rows × columns × resamples × a method weight. Above `INLINE_COST_LIMIT` (8e6) it always goes to the existing queue as a `stats.run` job, whatever the caller asks. At most 3 active jobs per user, across PLS bootstraps and statistics runs.
- **Jobs.**
  - Runs are claimed with a lease. A worker holding the lease may retake a run whose earlier worker died; nothing was written, because results and status commit together.
  - The existing reaper also calls `reapStatRuns`.
  - Cancellation works for queued runs and for running jobs.
- **Loading.** Whole versions are loaded; the legacy 5,000-row window does not apply to the engine. At most 600 value nodes per run go to the graph; all estimates stay in the relational table.

## 14. Tests added

- **`scripts/stats-engine.ts`** (`npm run test:stats`, CI checks job, no database): **361**. Covers:
  - golden values per method (§4);
  - edge cases (tiny n, constant or collinear predictors, under-identified CFA, isolated PLS construct);
  - validation severities and bilingual messages;
  - numeric missing codes; duplicate constructs and indicators;
  - typed-number detection (Arabic-Indic and Persian digits, comma decimals, "β = 1", χ², percentages, strict mode);
  - tables and figures only from estimates;
  - determinism;
  - the legacy RESULTS guardrail.
- **`scripts/stats-integration.ts`** (`npm run test:stats:db`, CI database job): **105**. Covers:
  - the full chain from upload to manuscript claim;
  - database immutability (edit, insert, delete, send back to running, insert as succeeded, truncate);
  - idempotency; jobs; cancellation; the reaper;
  - supersede with the Impact Report; data replacement and derived-version currency;
  - authorisation and isolation; the LLM tool boundary with a scripted provider;
  - atomic claims; heavy work never inline; unrelated supersede refused; deleted-dataset versions refused;
  - graph keys on tables;
  - legacy ownership, pinning, row counts, cleaning and job races;
  - reproducibility.
- **`e2e/stats.spec.ts`:**
  - with `FF_GRAPH` off, the page and API return 404;
  - with it on: upload → quality report → regression → verified result → cite → provenance, and a typed number refused over the API.
- **`scripts/smoke.ts` P1-C gates:**
  - no `Math.random` in the engine;
  - a single writer of results (`runs.ts`);
  - tool names equal to the allowed list;
  - statistics routes use `STATS_*` limits;
  - 3 currency-rule checks.

  Smoke also runs without `DATABASE_URL`.
- **Changed existing tests.** No assertion was weakened or removed. Where a legacy behaviour was fixed on purpose, the test changed to match: `"3,5"` is refused instead of becoming 35, legacy rows-dropped counts are now correct, and CFA std.all now matches lavaan.

## 15. Full test results

Local run of the final head (`93d46ea` plus this report), against a fresh PostgreSQL 16 (all migrations 0000–0013, then seed):

| Suite | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | ✅ 0 errors |
| Lint (`eslint .`) | ✅ 0 problems |
| Smoke (with and without `DATABASE_URL`) | ✅ all passed |
| Analysis (`test:analysis`) | ✅ 1,329 |
| Knowledge (`test:knowledge`) | ✅ passed (OpenAlex returns HTTP 403 from this sandbox; the suite handles provider failure) |
| Gateway unit / database | ✅ 87 / 37 |
| Statistics engine / database | ✅ 361 / 105 |
| Integration | ✅ 801 |
| Jobs | ✅ 22 |
| Graph | ✅ 170 |
| Build (`next build`, production env) | ✅ |
| e2e, `FF_GRAPH=false` | ✅ 67 passed, 1 skipped (the pre-existing seeded-admin test); the workbench page and API return 404 |
| e2e, `FF_GRAPH=true` | ✅ 67 passed, 1 skipped (same); the workbench flow runs end to end |

## 16. Build result

`next build` succeeds with the production environment. The 15 new API routes and the workbench page compile as dynamic routes.

## 17. npm audit result

- **Production dependencies** (`npm audit --omit=dev`): **0 vulnerabilities.**
- **Full tree: 5 (4 moderate, 1 high), all dev-only.** They were not present at the P1-B review. P1-C did not change `package-lock.json`, which is identical to `main`, so `main` reports the same 5.
  - `esbuild ≤ 0.24.2` (moderate): a development-server issue, reached through `drizzle-kit` → `@esbuild-kit/*`. The only fix offered is a breaking drizzle-kit downgrade.
  - `js-yaml 4.0.0–4.3.1` (high, CPU use on crafted merge keys): reached through `@eslint/eslintrc`. A non-breaking `npm audit fix` exists.
- **Not fixed in P1-C.** Neither package is in the production bundle, and changing the toolchain is outside this phase. Recommendation: a small separate PR to apply `npm audit fix` for js-yaml and track drizzle-kit's move off `@esbuild-kit`.

## 18. Git commit hash

See the PR head. The last implementation commit is `93d46ea`; this report is committed after it on the same branch.

## 19. PR

[#32](https://github.com/ameralqudah/academic-ai/pull/32), from `claude/stoic-wozniak-5l0xmv` into `main` (not merged).

## 20. Known limitations

1. **No account-deletion path exists.** Deleting a user would cascade through `stat_*` rows, which the immutability triggers allow only as a cascade. If an account-deletion feature is added, it must be designed around retained verified results.
2. **`pg_trigger_depth() > 1` is the cascade test.** A deletion issued from inside another trigger would also pass. No such trigger exists; any future trigger on these tables needs review.
3. **`maxBodyBytes`** checks `Content-Length` first. A chunked body without a length is buffered before the size check, up to the platform limit. It is refused afterwards, but it has been read.
4. **The typed-number check is heuristic in non-strict mode** (a person's sentence). Model text uses strict mode, where any digit is refused. A person can still write a number in words ("zero point three one"). `numberSpellings` in the legacy guardrail is deliberately permissive.
5. **Legacy paths are not "verified".** Section text written before P1-C, legacy chat analyses, PLS and CB-SEM jobs, planner-written tables (N-6, N-7) and legacy exports (N-8) are unchanged. They are not in the verified chain and are never labelled verified.
6. **Q² is non-standard** and excluded from verified results.
7. **Bootstrap CIs** (mediation, PLS) are deterministic per seed but not numerically comparable with R, because the RNGs differ.
8. **Tier-level choices:**
   - the 600 graph value nodes per run;
   - the inline cost limit;
   - 3 active jobs per user;
   - the 15-minute stale-inline threshold.

   These are chosen constants, not measured limits.
9. **Deleting a dataset** removes its files, but the version rows and verified runs stay (with `dataset_id` null). This keeps results that a manuscript may cite. `deletionImpact.verifiedRuns` tells the user how many.
10. **Graph-only for projects.** A run without a project, or with `FF_GRAPH` off, is stored and immutable but has no graph node.
11. **Browser UI is minimal.** It has no transformation editor and no version-replacement screen; those actions are available through the API. No new user-facing surface is enabled without the flag.

> **WS2 note (2026-09-26).** Limitations 4 and 5 above are kept as written at P1-C. WS2 (`WS2_REPORT.md`) changed the legacy paths they describe, and they are still outside the verified chain and never labelled verified:
> - **Limitation 4.** Legacy text now uses the canonical guard (`src/server/integrity/numbers.ts`, version `ws2-2`) on the P1-C detector.
> - **Limitation 5.**
>   - Generated sections are quarantined (A4), and a person's edits are recorded (A2, B1).
>   - Chat replies are flagged (A5).
>   - PLS, CB-SEM and the bootstrap record provenance (B2).
>   - Planner tables are dropped from exports, and task writing and XLSX/CSV are guarded (B4).
>   - Word exports carry an appendix (B5).
>   - Section text written before these checks is never rewritten. Its numbers are checked at export and listed, not changed.

## 21. Recommended next phase (not started)

**P1-D, the run engine v2**, together with the general tool registry and policy engine that were moved out of P1-C. It would:

- register the 7 `stats` tools, plus the graph tools, in one registry with scopes, approval policies and idempotency;
- add the agent loop with parked waits, so a queued `stats.run` job can be awaited by a run;
- move the engine's write path to its own database role (the trust boundary noted in `P1A_HARDENING_REPORT.md` §8);
- add RLS on the P1-B and P1-C tables.

Separately, and small: the dev-dependency audit PR (§17).

Before `FF_GRAPH` is enabled in production, the workbench should get a transformation and replacement UI, and at least one real user study of the verified-claim flow.
