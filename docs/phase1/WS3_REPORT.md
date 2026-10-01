# WS3 report: graph provenance and `FF_RUNS` readiness

**Date:** 2026-10-01 · **Final `main`:** `fc9f4d7` (merge of [#49](https://github.com/ameralqudah/academic-ai/pull/49)) · **Status:** WS3-A and WS3-B are **complete**. WS3-C is **closed**: all five readiness gates pass, including Gate 4, the app-level `test:runs:db` on Neon (direct and pooled, 214 passed, 0 failed each). WS3-D and WS3-E are **not started** and remain deferred until they are decided (§8). `FF_RUNS` and `FF_GRAPH` remain **off**; closing WS3-C does not enable either flag. The latest migration is still `0017_ws2_section_integrity.sql`: WS3 added none.

This report is the canonical record of WS3. WS1 is in `P1D_REPORT.md` §12–§13, WS2 in `WS2_REPORT.md`, and the Neon verification record in `P1D_NEON_VERIFICATION.md`.

## 1. Scope and naming

"WS3" had two meanings in the project history. The post-P1-D readiness audit first used it for authorization and operations hygiene; `WS2_REPORT.md` later used it for graph provenance. The WS3 audit (2026-09-26) settled it:

- **WS3** is graph provenance plus `FF_RUNS` readiness.
- The hygiene items (A1–A5, G1–G8 and the rest) move to **WS4**, which has not been started.

**Items in WS3:**
- from WS2 (`WS2_REPORT.md` §14): **N5**, **N6** and **N7**'s claim-to-section linking;
- from the WS2 plan, missing from the WS2 report's handover list: full statistic-bound tracing (**M2 full**);
- from the readiness audit: the run-engine findings **R3–R7** and **R11**, and the Neon app-level gate (`P1D_NEON_VERIFICATION.md` §6).

## 2. Phases

| Phase | Scope | Status | PR / merge |
|---|---|---|---|
| **WS3-A** Claim integrity (`FF_GRAPH` prerequisite) | N5, N6 | ✅ Complete | [#45](https://github.com/ameralqudah/academic-ai/pull/45) → `05e63ff` (2026-09-26) |
| **WS3-B** Run-engine readiness (`FF_RUNS` prerequisite) | R3, R4, R5, R6, R7, R11 | ✅ Complete | [#46](https://github.com/ameralqudah/academic-ai/pull/46) → `e5d7896` (2026-09-27) |
| **WS3-C** Readiness gates | Gates 1–5 (§5) | ✅ Closed 2026-10-01 | Test-only follow-ups [#47](https://github.com/ameralqudah/academic-ai/pull/47), [#48](https://github.com/ameralqudah/academic-ai/pull/48), [#49](https://github.com/ameralqudah/academic-ai/pull/49); this documentation |
| **WS3-D** Claims into the manuscript | N7 claim-to-section linking | ⏸ Not started, deferred | — |
| **WS3-E** (optional) | M2 full statistic-bound tracing | ⏸ Not started, deferred | — |

No WS3 phase added a migration or changed a flag, production configuration or the production database by hand.

## 3. WS3-A: claim integrity (N5, N6)

**Decisions:**
- **D-A1:** every hand-made `reports` link to a result value is refused, including links to values a person typed. No manual bypass.
- **D-A2:** a claim's `reports` edges cannot be unlinked (409 `claim_record`). A claim's text and evidence are fixed when it is created.
- **D-A3:** `supersedes` and `impactAcknowledged` were added only to the HTTP strict claim route. The `createClaim` run tool is unchanged.
- **D-A4:** numbers typed inside block text are out of scope.
- **Literature claims (option b):** a claim with no research number can still be created through `createNode`. Any claim containing a research or statistical number (or a `{{value:…}}` token) is refused there (403 `strict_claim_path`) and must use the strict claim path. No separate literature claim type was added.
- **Replacing a claim (option a):** when a replacement names a block, the block's `asserts` link moves from the old claim to the new one in the same transaction. If that block was the only dependent, no impact acknowledgement is needed. If other dependents remain, the existing acknowledgement is still required.

**What changed:** `createNode`, `link`, `unlink` and `createClaim` in `src/server/graph/service.ts`; claim `text` added to `IMMUTABLE_FIELDS` (`graph/types.ts`); `insertClaim` (`stats/manuscript.ts`) and the strict claims route pass the replacement options through.

**Evidence:** the full regression was green before the PR, with the graph suite at 195 and e2e at 69 passed with the flags both off and on. CI passed on the merge commit `05e63ff` (run #91), and the Render deploy of `05e63ff` went live with no errors.

## 4. WS3-B: run-engine readiness (R3–R7, R11)

**Decisions:**
- **D-B1 (run only):** a failed, refused or cancelled statistics analysis fails the research-run step and the run. The Statistics Assistant is unchanged.
- **D-B2 (option A, no migration 0018):** run-created records resolve `createdByRun = { runId, stepId }` through the unique step idempotency-key join. Person- and assistant-created records return `null`.
- **D-B3:** before any planner model call, a preflight checks `FF_RUNS`/`FF_GRAPH`, the EDITOR role, the run's token and cost budgets, the daily cost budget and cancellation.
- **D-B4:** transient database errors during planning are treated as transient infrastructure failures, not `planner_failed`. `infra_unavailable` and `rls_unavailable` stay distinct.

**What changed:**
- **R3** (`store.ts`): a plan and its steps roll back together when the lease-fenced transition fails, so no orphan steps remain.
- **R4** (`tools/statistics.ts`): a failed, refused or cancelled analysis fails the run step.
- **R5** (`executor.ts`, `planner.ts`, `tools/research.ts`, `tools/writing.ts`, `stats/tools.ts`): the step's abort signal reaches every model call a run makes.
- **R6** (`db-scope.ts`, `executor.ts`): one shared list classifies transient database errors.
- **R7** (`policy.ts`): `planPreflight`, per D-B3.
- **R11** (`stats/runs.ts`): `getProvenance` returns `createdByRun`.

**Accepted as documented, not fixed:**
- **R11 origin.** `stat_specs_origin_check` (migration 0013) allows only `user` or `assistant`. A spec created by a run is therefore stored as `origin: 'assistant'`, and provenance reads report it as `'run'` when it resolves to a run step. Storing `'run'` would need a migration, which was declined.
- **A transient error after a destructive step.** If a transient database error occurs after `replaceDatasetVersion` has committed, that step still ends as failed when the run recovers, because it allows one attempt. This matches how a worker crash behaves, and it was out of scope.

**Evidence:** runs unit suite 116 (was 99), runs database suite **214** (was 174), full regression and e2e (flags off and on) green before the PR. CI passed on the merge commit `e5d7896` (run #94), and the Render deploy of `e5d7896` went live with no errors and no new migration.

## 5. WS3-C: readiness gates

| # | Gate | Result | Evidence |
|---|---|---|---|
| 1 | Research-run tests green; R3, R4, R5, R6, R7 and R11 covered | ✅ PASS (2026-09-27) | On a tree identical to `e5d7896`: runs unit 116/0, runs database 214/0, stats database 110/0; the WS3-B section 40/0, with named checks for each item. CI run #94 on `e5d7896` passed. |
| 2 | The production Neon project is the expected one | ✅ PASS (2026-09-27) | Project `academic-ai-eu` is ID `dark-smoke-87061117` (the same project under two names). Production uses its default branch `import` (`br-lucky-meadow-b2h0jdhv`), database `neondb`, PostgreSQL 18.6. No connection string or credential was read. |
| 3 | Production migrations and RLS protections | ✅ PASS (2026-09-27) | Read-only catalog queries: 18 migrations (0000–0017) with the 0015–0017 hashes matching the repository; the live `research_runs_update` policy is migration 0016's owner-bound policy; 11 run-table policies, RLS on all four run tables; `academic_app` cannot bypass RLS or log in; the fail-closed probe passes. |
| 4 | App-level `test:runs:db` on Neon, direct and pooled, with the current code | ✅ PASS (2026-10-01) | `main` `fc9f4d7`, temporary branch `ws3c-gate4`: **direct 214 passed, 0 failed; pooled 214 passed, 0 failed.** Details in §6. |
| 5 | R11 provenance | ✅ PASS (2026-09-27) | The 214-check suite covers exact `{ runId, stepId }` resolution for a run-created statistics run, spec and dataset version; `null` for person- and assistant-created records; refusal of a stranger's read. In production, `stat_specs_origin_check` and the unique `run_steps_idempotency_idx` are as the design assumes. |

**Production checks were read-only.** Gates 2, 3 and 5 ran catalog queries and `SELECT`s only. No production row, role, setting or environment value was changed or read out.

## 6. Gate 4 in detail

**Why it was needed.** An earlier app-level run had passed 174/0 on both connections (2026-09-24, branch `p1d-ws1-m1m2-gate`, reported by the project owner). WS3-B changed the run path (`executor.ts`, `store.ts`, `db-scope.ts`, `policy.ts`), so that run no longer covered the code on `main`.

**History.**
1. **2026-09-27, cloud session: not executed.** The cloud environment's network policy denies `*.neon.tech` (TCP 5432 refused; HTTPS refused by the egress proxy). No result was claimed.
2. **2026-09-29, operator run on `5eb1e47`: 211 passed, 3 failed** (reported by the project owner). All three were R5 cancellation assertions. The read-only diagnosis found no cancellation bug: two were timing bounds too tight for a remote database, and the planner check was looking at an earlier planner call (a real test defect). The test-only fix is [#49](https://github.com/ameralqudah/academic-ai/pull/49), merged as `fc9f4d7`. It changed only `scripts/runs-integration.ts`; the number of checks stayed 214.
3. **2026-10-01, cloud session: still not reachable.** The schema of `ws3c-gate4` was checked read-only through the Neon connector: 18 migrations, latest `0017_ws2_section_integrity` with the same hash as in `fc9f4d7`, 11 run-table policies. Nothing under `drizzle/` changed between the branch's creation and `fc9f4d7`.
4. **2026-10-01, operator run on the project owner's local machine: PASS.**

**The passing run (2026-10-01).**

| Item | Value |
|---|---|
| Code | `main` at `fc9f4d7` |
| Where it ran | The project owner's local machine (PowerShell). Not the cloud session, which could not reach Neon. |
| Database | Temporary Neon branch `ws3c-gate4` (`br-ancient-pond-b20vxyds`) of `academic-ai-eu`, created from `import`. Never the production `import` branch. |
| Direct connection | `npm run test:runs:db`: **214 passed, 0 failed** |
| Pooled connection | `npm run test:runs:db`: **214 passed, 0 failed** |
| Clean-up | `ws3c-gate4` was deleted after both runs passed. A read-only branch listing on 2026-10-01 confirms it no longer exists. `DATABASE_URL` was removed from the local PowerShell session. |
| Production | No production database test was performed. The production database, configuration, Render environment and flags were not changed. |

No connection string, host credential or password is recorded here.

**What it covers.** The application's own run path on Neon PostgreSQL 18, through both the direct and the pooled host: `postgres-js` (`prepare: false`), `withRunScope` (`SET LOCAL ROLE academic_app` and a transaction-local `app.user_id`), and `assertRlsEnforced`. Production uses the pooled host.

## 7. Final WS3-C status

**WS3-C is closed.** Gates 1–5 all pass. The readiness evidence for `FF_RUNS` that WS3 set out to produce is complete.

**What this does not do.**
- It does not enable `FF_RUNS` or `FF_GRAPH`. Both remain off, and enabling them is a separate, explicit decision outside any code or documentation PR. `FF_RUNS` also requires `FF_GRAPH` and a queue-backed `JOB_RUNNER` (production uses `inline`).
- It does not claim a test against the production database. Gate 4 ran only on a temporary branch.
- It does not claim CI or production verification beyond what is cited above.

## 8. Remaining decisions and open items

**Deferred WS3 phases (no decision yet):**
- **WS3-D, claims into the manuscript (N7 claim-to-section linking).** The audit recommended a graph mirror of each `research_section` (no migration), with a Claims table in the Word appendix. It is not a flag prerequisite, but it is recommended before any user-facing graph rollout.
- **WS3-E, full statistic-bound tracing (M2).** Optional; it would change `numbers.ts` and move the guard to `ws2-3`. It is not a flag prerequisite.

WS3 as a whole can be closed once these two are either approved and done, or formally deferred.

**Outside WS3:**
- **WS4, authorization and operations hygiene** (A1–A5, G1–G8 and the rest): not started.
- **Older temporary Neon branches.** `p1d-ws1-gate`, `p1d-ws1-m1m2-gate` and `ws2-b1-0017-gate` still exist in `academic-ai-eu` (read-only listing, 2026-10-01). Cleanup is the owner's decision.
- **Development-only audit findings:** `js-yaml` and the `drizzle-kit`/`esbuild` chain. The production audit passes after [#50](https://github.com/ameralqudah/academic-ai/pull/50).
- **Production storage.** The Render build logs of 2026-10-01 show `storage.probeFailed` for the S3 provider (status 540, "Project paused"). It is unrelated to WS3 and was not changed.
