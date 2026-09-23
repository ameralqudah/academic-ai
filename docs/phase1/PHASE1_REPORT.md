# Phase 1 report

**Plan:** `docs/phase1/PHASE1_PLAN.md` · **Architecture:** `docs/architecture/TARGET_ARCHITECTURE.md` (§C, §G, R1–R10)

Each step gets a section when it is merged.

| Step | Status | PR |
|---|---|---|
| P1.0 Security hardening | ✅ CI green | [#29](https://github.com/ameralqudah/academic-ai/pull/29) |
| P1-A Research Graph core | ✅ reviewed (`P1A_REVIEW.md`) and hardened (P1-A.1, `P1A_HARDENING_REPORT.md`) | [#30](https://github.com/ameralqudah/academic-ai/pull/30) |
| P1-B Model Gateway | ✅ merged (`P1B_PLAN.md`, `P1B_REPORT.md`) | [#31](https://github.com/ameralqudah/academic-ai/pull/31) |
| P1-C Deterministic statistics engine + graph integration (re-scoped) | ✅ merged (`P1C_PLAN.md`, `P1C_REPORT.md`); CI green on the merged head | [#32](https://github.com/ameralqudah/academic-ai/pull/32) |
| P1-D Research run engine, tool registry, policy engine, approvals, RLS on run paths | 🔍 in review (`P1D_PLAN.md`, `P1D_REPORT.md`, `P1D_NEON_VERIFICATION.md`); not merged | [#33](https://github.com/ameralqudah/academic-ai/pull/33) |

---

## P1.0 Security hardening

The audit's security findings that were not among the 13 P0 items. Details are in the PR description.

- **SSRF** (`src/server/security/net-guard.ts`): every IPv4 and IPv6 notation is classified (including IPv4 embedded in IPv6). Redirects are followed by hand, at most 5, and every hop is checked. Addresses are also checked when the connection is made, which closes DNS rebinding.
- **Compressed uploads** (`src/server/security/archive-guard.ts`): DOCX and XLSX are really decompressed against hard limits before the parsers see them. PDF streams are capped. An oversized declared body is refused before it is read.
- **Configuration:**
  - `/api/health` returns only up/down to the public; the detailed report is for administrators.
  - CSP has no `unsafe-eval` in production.
  - The seed no longer overwrites plans edited in the admin panel.

---

## P1-A Research Graph core

> **Read with P1-A.1.** The formal review (`docs/phase1/P1A_REVIEW.md`) found 24 issues, and the hardening step fixed the ones that had to be fixed before exposure (`docs/phase1/P1A_HARDENING_REPORT.md`). Where this section and the hardening report differ, the hardening report is current. The main differences:
> - supersede now **invalidates** what used the old object;
> - pins no longer hide a dependent from later changes;
> - runs and computed results are written only by the engine and are immutable;
> - there are 51 relations, not 41.

**Goal:** everything later in Phase 1 writes into one graph per project, and a change to an upstream object reports, before it is saved, what downstream work it affects (R6).

### What was built

| Part | Where |
|---|---|
| Tables `project_members`, `graph_nodes`, `node_versions`, `graph_edges`, `stale_marks` | `src/server/db/schema.ts`, migration `drizzle/0011_p1a_research_graph.sql` |
| Node types (35, §G.1), payload schemas, field classes (cosmetic / substantive / structural), change classifier | `src/server/graph/types.ts` |
| Edge rules: 51 relations (41 in P1-A), each with its allowed types and its severity per kind of change | `src/server/graph/rules.ts` |
| Impact engine: pure and testable; a fixture, the database or a transaction supplies the edges | `src/server/graph/impact.ts` |
| Service: access by project role, create, update (versioned), dry-run impact, link and unlink, supersede, trace, stale list, resolve | `src/server/graph/service.ts` |
| API behind `FF_GRAPH` (off → 404) | `src/app/api/v1/projects/[projectId]/…` |

**API**

| Method and path | Role | Purpose |
|---|---|---|
| `GET/POST …/nodes` | viewer / editor | List (filter by type or status) / create |
| `GET/PATCH …/nodes/:id` | viewer / editor | Read (with open stale marks) / update |
| `GET …/nodes/:id/versions` | viewer | Immutable version history |
| `POST …/nodes/:id/impact` | viewer | **Dry run:** the Impact Report for a proposed payload |
| `GET …/nodes/:id/trace?direction=up\|down` | viewer | Provenance: what a node rests on, or what rests on it |
| `POST …/nodes/:id/supersede` | editor | Replace with a newer node (new dataset version, re-run) |
| `POST …/edges`, `DELETE …/edges/:id` | editor | Link and unlink (validated against the edge rules) |
| `GET …/stale`, `POST …/stale/:id/resolve` | viewer / editor | Open stale marks; accept, regenerate or dismiss |

### How impact works

1. **Direction.** An edge `src —rel→ dst` means *src depends on dst*.
2. **Classification.** An update is classified from the old and new payloads.
   - Structural examples: a construct's measurement kind, an item's reverse coding, a column's recode, an analysis spec, a retraction.
   - Substantive examples: a definition, a wording.
   - Cosmetic examples: a translation, notes.
   - A cosmetic change affects nothing downstream.
3. **Walk.** The walk goes backwards over dependency edges, and each edge rule gives a severity (`info`, `review` or `invalidates`) for the kind of change.
4. **Propagation.** Only `invalidates` propagates: an invalid run makes its results, and the text reporting them, invalid. `review` asks a person to decide about that one object; if they then change it, that change is analysed in turn. This keeps a definition tweak from flagging the whole project. There are two exceptions:
   - **Containers** (a questionnaire and its items, a model and its elements) pass a change through, because a change to a part is a change to the whole.
   - **Supersede** (P1-A.1: now *invalidates*) reaches everything that used the old object: the runs on replaced data, their results, and every block reporting them.
5. **Pinning.** Edges are pinned to the version of their target. (P1-A.1: pins no longer skip anything. Every dependency is followed, and a dependent that is already stale is flagged again and labelled as such. Pins move forward when a change does not affect them and on every resolution. A run's pins record the versions it used and never move.)
6. **Acknowledgement (R6).** A change with any `review` or `invalidates` consequence is refused with `428 IMPACT_ACK_REQUIRED`, and the refusal carries the Impact Report. The client re-sends with `impactAcknowledged: <report hash>`. The hash covers the node, the version, the proposed payload and the consequences, so an acknowledgement is valid only for the exact report that was shown. The hash is stored on the new version for audit.
7. **Transaction.** The update, the new version, the stale marks and the status changes are written in one transaction. The node row is locked, and an edit made against an old version is refused with 409.

### R6 coverage: the stale set for each object type

The fixture project (37 nodes, 48 edges) covers design, instrument, data, analysis, literature and manuscript. `npm run test:graph` asserts the exact `invalidates` / `review` / `info` sets:

| Change | Invalidates | Review | Info |
|---|---|---|---|
| Construct measurement kind | model element, model, analysis, run, result value, results table, reporting block | items, hypothesis, citation about it, block describing it, cross-reference | — |
| Construct definition | — | items, model element, hypothesis, citation, describing block | — |
| Hypothesis direction | analysis, run, results, reporting block | model path it posits, describing block, cross-reference | — |
| Hypothesis wording | — | model path, analysis, the value that tests it, describing block | — |
| Item reverse-coded | column, dataset versions, cleaning step, run, results, reporting block | construct measurement, questionnaire, Methods block, cross-reference | — |
| Item wording | — | construct, questionnaire, column binding, Methods block | dataset version (wording drift) |
| Dataset column recode | dataset versions, cleaning step, run, results, reporting block | cross-reference | — |
| Dataset version content | P1-A.1: refused. Content is immutable; create a new version and supersede | | |
| New dataset version (supersede) | P1-A.1: runs on the old version, their results, reporting claims and blocks | section, abstract, cross-references | submission |
| Analysis spec | run, results, reporting block | cross-reference | — |
| Result value corrected / newer run | P1-A.1: correcting in place is refused; a re-run invalidates the old values, their tables and reporting text | | |
| Citation contradicted | citing block | hypothesis grounded in it | — |
| Source retracted | citation, citing block | hypothesis | — |
| Manuscript section | — | abstract, cross-references, reviewer response | submission snapshot |

### Tests

| Suite | Result |
|---|---|
| `npm run test:graph` (new, PostgreSQL, also in CI) | ✅ 103 assertions. Covers the R6 table above, the write path (acknowledgement refused / wrong / for another proposal / accepted; versions immutable; conflict; no-op; cosmetic; invalid payload), marks with their paths, statuses, resolution and audit, version pinning and re-pinning, supersede, trace up and down, edge validation, unlink with acknowledgement, isolation between projects, roles, the feature flag, cycle termination and cascade. **Mutation check:** weakening one rule (`represents`) makes 8 assertions fail. |
| Smoke (pure) | ✅ adds 18 checks: the change classifier, canonical hashing and the consistency of the rule table |
| Playwright `e2e/graph.spec.ts` | Flag off (CI default): the routes 404 and require a session. Flag on: the full flow over HTTP (create, link, invalid link 422, dry run, 428 then acknowledged 200, 409 conflict, stale list, resolve, trace, versions, foreign project 404). ✅ Both ways locally; the full e2e suite with the flag off: 66 passed, 1 skipped. |
| Regression | typecheck, lint, smoke, statistics 1,328, knowledge, integration 807, jobs 22, production build: all ✅ |

### Migration and rollback

- **`0011_p1a_research_graph` is additive only:** five new tables, one enum, indexes. It also backfills an `OWNER` row in `project_members` for every existing project. The backfill is idempotent and was checked on the local database: 10 projects gave 10 members.
- **Project creation** now inserts the owner membership in the same transaction. Access still falls back to `research_projects.user_id`, so projects created any other way stay reachable by their owner.
- **Rollback:** set `FF_GRAPH=false` (the default), or redeploy the previous code. Nothing else reads the new tables.

### Deviations from the architecture, and what is deferred

- **Edge rules live in code, not an `edge_rules` table.** They are still data (one typed table in `rules.ts`), but they are versioned and reviewed with the code that interprets them, and a smoke test checks their consistency. A table can be added if rules ever need to change without a deploy.
- **Two relations point the other way** so that every edge reads "src depends on dst": `produced_by` (result → run) replaces `produces`, and `contains` (model → element) replaces `element_of`. New relations: `has_item`, `includes`, `collected_with`, `applies_to`, `transformed_by`, `about`, `summarizes`, `refers_to`, `snapshot_of`, `interprets`, `version_of`, `supersedes`.
- **Typed detail tables are deferred.** Payloads are validated by zod schemas per type. The detail tables arrive with the steps that own each domain (H for sources and citations, the data and analysis steps for theirs).
- **PostgreSQL RLS is deferred.** Isolation is enforced in the service: every query is scoped by project, and there are 6 isolation tests. RLS needs the project and user set per transaction (`SET LOCAL`), which interacts with the connection poolers used in production. It will be added together with the run engine (P1-D), where every agent write goes through one transaction boundary.
- **The full Impact Report is not stored as a document.** Its hash is stored on the node version, and its items are stored as the stale marks, with their paths.
- **IDs** stay random UUIDs as text, like the rest of the schema (UUIDv7 would sort by time, but it would be the only exception).

---

## P1-B Model Gateway

Full report: `docs/phase1/P1B_REPORT.md`. Plan and audit: `docs/phase1/P1B_PLAN.md`.

- **One path to a model.** `src/server/ai/gateway/` is the only code that talks to a provider. The Anthropic, OpenAI and Google adapters use raw `fetch`, native tool calling and native structured output. All 22 model-calling paths moved there through an `AIProvider` facade (strangler). The old providers, `resilient-provider` and every stacked failover layer were removed. A smoke gate fails the build on any path around the gateway.
- **Entitlement inside the gateway.**
  - The plan is looked up from the user id on every call, so a worker cannot lose it.
  - A call with no user in scope, or whose plan cannot be resolved, is refused.
  - Failover never goes above the plan or above the class first chosen, and never switches provider when the user chose a model.
  - Every routing decision is logged and stored.
- **Quota.**
  - Every call reserves under a per-user advisory lock (concurrency-safe, idempotent, expires after 15 minutes, released by the reaper).
  - The ledger is still `usage_tracking`.
  - Task-path generations now count (G-4). Internal steps are metered but not counted, and are refused on a used-up plan.
- **Metering.** One `ai_usage_events` row per attempt, including failed and cancelled ones, with cost at the model that served.
- **Tool calls.** Tool calls are validated, checked against the run's permissions and recorded in `ai_tool_calls`. Tools are projected from the existing capability registry; no second registry was created.
- **Resilience.** Timeouts per kind, at most 3 attempts, and classified errors (only transient classes are retried). Streams are cancelled on client disconnect.
- **Migration:** `0012_p1b_model_gateway`, additive (3 tables).
- **Final review:** a free user on a premium-only deployment is refused ("no eligible model for this plan", never served premium). Output tokens are capped per plan by the gateway (free 8,192 · paid 32,768 · admin 64,000), above every current call site's request.
- **Tests:** gateway unit (87) and database (37) suites, both in CI, with mock providers only. Mutation checks cover the entitlement filter, the failover class filter, the retry guard, the reservation lock, the word check and the project check.
- **Deferred:** RLS on the new tables (P1-D); moving the text parsers for titles, evidence and extraction to structured output; embedding call sites (P1-G); the tool registry and policy engine (P1-C/D).

---

## P1-C Deterministic statistics engine + Research Graph integration

Full report: `docs/phase1/P1C_REPORT.md`. Plan and audit: `docs/phase1/P1C_PLAN.md`.

- **Re-scoped.** The P1-C brief replaced "tool registry + policy engine" with the statistics engine and its graph integration. Only the 7 analysis tools are here; the general registry and policy engine have not been built.
- **One chain for research numbers:** immutable, hashed dataset versions → recorded transformations → validation (INFO, WARNING, ERROR, BLOCKING) → hashed, seeded specification → pure, versioned engine (`academic-ai-ts-core` 1.0.0) → immutable run → write-once estimates, tables and figures → Research Graph (computed, idempotent) → manuscript claims rendered from `{{value:key}}` tokens.
- **Enforced by PostgreSQL.** Triggers make results write-once, refuse direct DELETE and TRUNCATE, allow only legal run transitions, and refuse results inserted outside the running transaction.
- **Methods (R-checked goldens, no R at runtime):**
  - descriptives, reliability, correlation;
  - regression with diagnostics;
  - ANOVA with Tukey and Games-Howell;
  - EFA (PAF or PCA, varimax or promax);
  - CFA (std.all as lavaan);
  - PLS;
  - mediation (PROCESS 4, seeded bootstrap) and moderation (PROCESS 1).

  Full CB-SEM is deferred to an R worker.
- **LLM boundary.** The tools can propose, validate, run and read; none writes a number. Model text with a typed digit is withheld. The legacy RESULTS guardrail now checks numbers against attached runs.
- **Changes to completed phases:**
  - P1-A currency: a node whose own dependency chain contains the replacement of a superseded node is not stale. This was a blocker found by the P1-C tests.
  - P0 jobs: status changes are conditional.
  - Legacy statistics correctness and ownership fixes.
- **Migration:** `0013_p1c_statistics`, additive (7 tables and 3 columns).
- **Tests:** engine 361 and database 105 (both in CI), e2e with the flag on and off, and smoke gates.

---

## P1-D Research run engine, tool registry, policy engine, approvals, RLS on run paths (in review)

Full report: `docs/phase1/P1D_REPORT.md`. Plan and audit: `docs/phase1/P1D_PLAN.md`.

- **One controlled path**, behind `FF_GRAPH` + `FF_RUNS` and a queue-backed job runner:
  - intent;
  - planner (a structured plan through the Model Gateway; it executes nothing);
  - the one tool registry (20 tools);
  - policy (10 rules, evaluated immediately before each step);
  - hash-bound, single-use approval;
  - leased pg-boss executor;
  - P1-C services for every number;
  - Research Graph with step provenance;
  - append-only run events.
- **Chat is unchanged in design.** It stays on the task engine, with only the approved fixes:
  - no re-execution of settled steps;
  - monotonic cancel;
  - project and conversation ownership checks;
  - a pinned PLS/CB-SEM model confirmation;
  - a working Retry.

  `/api/agent` is kept.
- **RLS covers only the four run tables and the run paths.** It uses `SET LOCAL ROLE academic_app` per transaction and fails closed if the database cannot enforce it. Graph and statistics tables keep application-level authorisation. The application as a whole is not RLS-protected.
- **Limits** for each plan tier are held in one module and can be overridden up to hard ceilings.
- **Idempotency.** Step idempotency keys reach P1-C and the graph, so a retry or a crash never duplicates a statistical run, a dataset version, a node or a claim.
- **Migrations:** `0014_p1d_runs` and `0015_p1d_rls`, both additive.
- **Tests:**
  - `test:runs` (71);
  - `test:runs:db` (74, including RLS at the database);
  - `test:tasks:db` (39);
  - e2e with the flags on and off;
  - smoke gates.
- **Neon.** The RLS layer (role, policies, fail-closed probe) was verified on a Neon branch (`P1D_NEON_VERIFICATION.md`). Running the application's run path against Neon, and checking the production pooler and role, are still blocking items before `FF_RUNS` is enabled.
