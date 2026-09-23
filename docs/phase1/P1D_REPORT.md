# P1-D report: research run engine, tool registry, policy engine, approvals, RLS on run paths

**Date:** 2026-09-23 · **Plan and audit:** `docs/phase1/P1D_PLAN.md` · **Branch:** `claude/stoic-wozniak-5l0xmv` · **Base:** `main` at `003d95b` · **Status:** implemented under the approval conditions below. The full regression is green locally (§9). **Merged into `main` via [#33](https://github.com/ameralqudah/academic-ai/pull/33) (merge commit `5f18aaa`; PR head `a6fa42d`, all CI checks green). `FF_RUNS` remains off (default `false`). P1-E has not been started. The application-level Neon verification is still a pre-production blocker (§11.1).**

**Approval conditions this was built under** (from the approval of the plan):

- Chat stays on the existing task engine. The approved fixes to the task path are done (§2). Chat is not migrated, the task engine is not retired, and `/api/agent` is not removed.
- RLS applies to the P1-D run paths and the four new run tables only. The application as a whole is **not** RLS-protected. Graph and statistics tables keep their application-level authorisation.
- Limits come from the plan's values, are held in one module, and are enforced server-side on every run path.
- The planner never executes tools. P1-C stays the only statistical execution authority. Retries never duplicate scientific results.

**The path.** A research run now goes through these stages:

```
intent → planner (Model Gateway, structured plan; executes nothing)
       → tool registry (20 tools; the only list)
       → policy (10 rules, first DENY wins; re-evaluated immediately before each step)
       → approval (bound to the exact action by hash; single use; expires)
       → executor (pg-boss job, row lease, one step = one tool call, claim token per attempt)
       → P1-C services for every number
       → Research Graph (created_by_step_id on nodes, versions and edges)
       → run_events (append-only audit)
```

All of it is behind `FF_GRAPH` + `FF_RUNS`. It also needs a queue-backed job runner (`JOB_RUNNER` inline or worker).

---

## 1. Commits

| Commit | Layer |
|---|---|
| `9eae443` | Plan and audit (approved) |
| `b51e834` | Chat task-path hardening (the approved fixes, §2) |
| `be968d2` | Migrations `0014_p1d_runs.sql` (tables, constraints, state triggers) and `0015_p1d_rls.sql` (role, grants, helper functions, RLS policies) |
| `acae84a` | Run core: limits, state machines, tool contract, 20 tools, registry, approvals and hashes, policy engine, RLS scope, run store |
| `eb58d64` | Planner, executor, service, `research-run` queue, reaper, and the statistics assistant moved onto the run registry |
| `5a950d6` | API routes, feature flag, runs page, smoke gates, browser tests |
| `b63f7f5` | Rejection settling fix, CI storage env for `test:runs:db`, nested-depth smoke gate, this report, Phase 1 report |
| `03b00b0`, `a6fa42d` | Documentation only: Neon RLS verification record (`P1D_NEON_VERIFICATION.md`) |
| `5f18aaa` | Merge of #33 into `main` |

## 2. Chat / task-path fixes (approved scope only)

Chat still runs on the task engine. The fixes below are limited to the defects the plan listed; nothing else in chat was redesigned.

| Defect | Fix | Where |
|---|---|---|
| A step could run twice (a stale executor settling a step that another executor had re-claimed) | Steps are settled only under the claim that started them (`startedAt` = claim). Settled steps are never rewritten. Stranded steps count an attempt; when attempts run out, the step fails with `task.step.interrupted` instead of looping. | `tasks.repository.ts`, `tasks/executor.ts` |
| Cancelling was not monotonic, and racy | A terminal task status can never change. `setStatus` is conditional and reports whether it applied. The executor polls for cancellation every 2 s and races the handler against cancel and timeout. A cancelled step becomes `SKIPPED` (`task.step.cancelled`). | same, plus `task.service.ts` |
| Missing project / conversation ownership check when starting a task | `startTask` asserts the project and conversation belong to the caller | `task.service.ts` |
| PLS / CB-SEM ran without the model confirmation the UI asked for | The model the user confirms is hashed and pinned. The handler runs only the confirmed model; if the model changed, it asks again. Models over 20 KB are refused. Answers are recognised in English and Arabic. | `tasks/model-confirmation.ts`, `tasks/handlers.ts` |
| Retry did nothing | `retry` reopens only a FAILED task. The UI checks the response and the returned `cancelled` flag. | `api/tasks/[id]/route.ts`, `task-progress.tsx` |
| Direct-mode jobs ran without a lease | `withLease` is used in every job mode | `jobs/dispatch.ts` |

Tests: `npm run test:tasks:db` (39 checks, in CI).

## 3. Database (migrations 0014 and 0015)

**New tables:**

- `research_runs`;
- `run_steps`;
- `run_approvals`;
- `run_events`.

**Additive columns:**

- `created_by_step_id` on `graph_nodes`, `graph_edges` and `graph_node_versions`, with a partial unique index so a step creates at most one node of a type;
- `step_id` on `ai_tool_calls` and `ai_usage_events`;
- `idempotency_key` on `dataset_transformations` (unique with the input version) and on `stat_specs` (unique).

**Integrity enforced by the database** (so the owner connection cannot violate it either):

- **CHECK constraints** on statuses, sizes and hash formats.
- **State-machine triggers.** A run or step moves only along its transition table. A terminal run never changes. A run cannot change project or owner. A step cannot start without authorisation.
- **Approvals.** An approval is decided once and consumed once.
- **Run events** are insert-only. Run rows are deleted only by cascade, and the run tables cannot be truncated.

**Rollback:**

- Both migrations are additive.
- To roll back 0015, drop the policies, disable RLS on the four tables, and drop the `app_*` functions and the `academic_app` role.
- To roll back 0014, drop the four tables and the new columns and indexes.
- No existing data is rewritten.

## 4. RLS (run paths and run tables only)

- **Role.** `academic_app` is `NOLOGIN` and `NOBYPASSRLS`. It is granted to the migrating role, and has only the grants it needs on the four run tables plus read access where the policies need it.
- **Per-user scope.** Every run-path query runs in `withRunScope(userId, fn)`: one transaction with `SET LOCAL ROLE academic_app` and `set_config('app.user_id', …, true)`. The role and the setting end with the transaction, so a pooled connection cannot leak them.
- **Policies.** 11 policies use `SECURITY DEFINER` helpers: `app_current_user_id`, `app_project_rank` (project membership or creator), `app_run_project` and `app_run_owner`.
  - Readers are project members.
  - Creating a run needs EDITOR rank and the run must be in the caller's own name.
  - Updates come from the run owner, or from a project OWNER for decisions.
  - There is no DELETE policy.
- **Fail closed.** Before a run starts, `assertRlsEnforced()` checks, in the transaction, that:
  - the current role is `academic_app`;
  - the role cannot bypass RLS and is not a superuser;
  - RLS is on for all four tables;
  - `row_security` is on.

  If any check fails, the run is refused (`503 UNAVAILABLE`, `reason: rls_unavailable`). **There is no application-only fallback.**
- **Migration.** If the database refuses to create or grant the role, migration 0015 raises a WARNING rather than failing, so the rest of the schema still applies. The runtime then refuses every run, as above.
- **Tests.** The RLS checks in `test:runs:db` connect as the restricted role and show that:
  - a stranger sees and changes nothing;
  - with no user set, nothing is visible;
  - a viewer cannot create, update or approve;
  - nobody creates a run in another user's name;
  - the role cannot delete;
  - a role that could bypass RLS makes runs refuse to start.
- **Not covered by RLS** (application-level authorisation, as before and as approved):
  - graph tables;
  - statistics tables;
  - datasets;
  - sections, conversations and tasks.

  A tool's writes to these go through the existing P1-A/P1-C services, which check project roles in the service. Tools run **outside** the RLS transaction, so a single-connection serverless pool cannot deadlock.

## 5. Tool registry, policy, approvals

**Registry** (`src/server/runs/registry.ts`). There are 20 frozen tool definitions. Each one declares:

- name and version;
- input and output schemas (zod, strict);
- side effect (`read`, `compute`, `external_read`, `write`, `destructive`) and risk;
- the role it requires, the tiers and contexts it is offered in;
- a timeout, max attempts and an idempotency mode;
- how it resolves the resources it touches, and when it needs approval.

The tools by category:

| Category | Tools |
|---|---|
| Data | `listDatasets`, `inspectDataset`, `validateDataset`, `createDatasetVersion`, `replaceDatasetVersion` |
| Statistics (P1-C) | `validateAnalysisSpec`, `createAnalysisSpec`, `runAnalysis`, `getAnalysisResult`, `getAnalysisProvenance`, `generateTableFromResult`, `generateFigureFromResult` |
| Research | `searchLiterature`, `retrieveSource`, `extractEvidence` |
| Writing | `explainResult`, `generateDraft` |
| Graph | `readGraph`, `createGraphNode`, `createClaim` |

The registry also produces the Model Gateway tools, so the statistics assistant and the planner see the same list. The old `STATS_TOOLS` list was removed. Smoke gates enforce:

- `defineTool` is called only in the registry;
- `tool.execute` is called only by the executor and the assistant;
- run tables are touched only by the store;
- tools never import the statistics engine directly;
- no tool can reach the run service, executor, store, planner or dispatcher (nested depth 0).

**Policy** (`src/server/runs/policy.ts`). There are 10 rules, evaluated in order; the first DENY wins:

1. `tool.known`
2. `tool.context`
3. `flag`
4. `auth.project`
5. `auth.resources`: every dataset, version, run or node a step names must be in the run's project.
6. `entitlement`: role and tier.
7. `limits.run`: wall time, retries, and metered tokens and cost from `ai_usage_events` for this run plus the estimate for the next model call. Reaching the limit denies.
8. `limits.user`: daily cost.
9. `run.state`
10. `approval`

The policy is re-evaluated immediately before each step executes. The full per-rule decision is stored on the step and shown in the UI.

**Approvals** (`src/server/runs/approvals.ts`, `store.ts`, `service.ts`):

- **Binding.** An approval is bound to `actionHash = sha256(canonical {project, run, step, user, tool, version, inputHash, reason, targets, impactHash})`.
- **Deciding.** A decision must present the same hash. Only the run owner (EDITOR or higher) or a project OWNER can decide.
- **Consumption.** An approval is consumed once.
- **Changed actions.** If anything in the action changes (for example the Impact Report of a data replacement), the old approval is not used and a new one is requested.
- **Rejection and expiry.** Rejecting skips the step and ends the run with `approval_rejected`. An approval left past its TTL (24 h) is expired by the reaper, and the run ends with `approval_expired`.
- **What needs approval:**
  - `createClaim` always;
  - `replaceDatasetVersion` always, with the Impact Report hash in the action;
  - `createDatasetVersion` when a clean drops rows or imputes;
  - `runAnalysis` when its cost is above the inline limit.

## 6. Limits (one module, `src/server/runs/limits.ts`)

The values are those in the plan's table (free / paid / admin):

- **Steps per run:** 10 / 20 / 30.
- **Tool calls:** 1 per step; 3 / 5 / 8 per assistant round.
- **Wall time per run:** 10 / 30 / 60 min, with a per-step cap.
- **Metered tokens per run:** 60k / 400k / 1M.
- **Cost:** per run $0.20 / $2 / $10; per day $1 / $20 / $100.
- **Active runs per user:** 1 / 3 / 5.
- **Sizes:** step input 16 KB, step output 64 KB, plan 64 KB, intent 4,000 characters.
- **Retries:** per step and per run.
- **Approval TTL:** 24 h.

`RUN_LIMITS` (JSON keyed by tier) can override the defaults. Overrides are clamped to hard ceilings, so a misconfiguration can make runs stricter, never unbounded.

The planner, policy, executor, store and assistant all read the limits from this module. The database enforces the intent size a second time. When a run hits a limit, it stops before the next step with a `limit_*` stop reason and an event.

**API limits.** Per-IP and per-user rate limits (`runs/http.ts`) and a 16 KB body cap apply to every run route.

## 7. Idempotency (no duplicate scientific results)

- **Step key.** Each step has an idempotency key: `sha256(project, run, seq, tool, version, inputHash)`. The key is passed into the P1-C services:
  - `createSpec`, `startRun` and `transformVersion` return the existing spec, run or version for the same key;
  - graph writes find the node the step already created (`created_by_step_id`);
  - claims are found by step.
- **Execution.** Every attempt claims the step with a token, so a stale worker cannot settle it. A worker that dies mid-step is recovered by the reaper, and the retry finds the effect that already exists (tested: the effect exists exactly once).
- **Starting a run.** `POST …/runs` accepts an `Idempotency-Key` header and returns the same run for a retried request.

## 8. API and UI

**Routes** (`FF_GRAPH` + `FF_RUNS`; otherwise 404, checked before authentication):

- `GET` and `POST /api/v1/projects/:projectId/runs`;
- `GET /…/runs/:runId?after=` (run, steps, approvals, events after a cursor) and `DELETE /…/runs/:runId` (cancel);
- `POST /…/runs/:runId/approvals/:approvalId` with `{decision, actionHash}`;
- `GET /…/tools` (the tools this caller may use here).

**UI.** `/[locale]/projects/[id]/runs`, linked from the project page when enabled, in English and Arabic. It lets the user:

- start a run with an optional dataset version;
- see the run list, steps with their policy decisions, and events;
- review an approval card (tool, risk, effect, affected items, action hash, expiry) and approve or reject it;
- cancel a run.

The page polls while the run is live.

## 9. Test results (local, this branch)

Run on local PostgreSQL 16, on a freshly created and migrated database, mirroring CI:

| Suite | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | ✅ |
| Lint (`eslint .`) | ✅ |
| Smoke (`test:smoke`), including the P1-D gates | ✅ all passed |
| Model Gateway unit (`test:gateway`) | ✅ 87 passed |
| Statistics engine (`test:stats`) | ✅ 361 passed |
| Research-run core, no database (`test:runs`) | ✅ 71 passed |
| Statistics / lavaan parity (`test:analysis`) | ✅ 1,329 assertions |
| Knowledge providers (`test:knowledge`) | ✅ (tolerates OpenAlex returning 403 from this sandbox) |
| Integration (`test:integration`) | ✅ 801 assertions |
| Durable jobs (`test:jobs`) | ✅ 22 assertions |
| Task-path hardening (`test:tasks:db`) | ✅ 39 passed |
| **Research runs with RLS (`test:runs:db`)** | ✅ 74 passed |
| Research Graph (`test:graph`) | ✅ 170 passed |
| Model Gateway with database (`test:gateway:db`) | ✅ 37 passed |
| Statistics provenance (`test:stats:db`) | ✅ 105 passed |
| Production build | ✅ |
| Browser tests, flags **off** (`FF_GRAPH=false FF_RUNS=false`) | ✅ 69 passed |
| Browser tests, flags **on** (`FF_GRAPH=true FF_RUNS=true`) | ✅ 69 passed |
| `npm audit --omit=dev` (production) | ✅ 0 vulnerabilities |
| `npm audit` (all) | 5 development-only advisories (4 moderate, 1 high: esbuild via drizzle-kit, js-yaml via eslint). All were already on `main`. Left for a separate PR, as instructed. |

**What `test:runs:db` covers** (74 checks):

- **RLS at the database:** the restricted role, no bypass, isolation for strangers, viewers and no-user, forged owners, no delete.
- **Triggers:** monotonic cancel, no un-cancel, append-only events, no truncate, no start without authorisation.
- **The full path with a scripted model through the real gateway:** plan → policy → approval → P1-C run → claim in the graph with step provenance.
- **Approvals:** forged hashes, viewers, other editors, deciding twice, single use, changed Impact Report, rejection, a rejection left half-settled, expiry.
- **Idempotency:** the same step key gives the same spec, statistics run, dataset version, node and claim; crash recovery produces the effect exactly once.
- **Policy denials:** an unregistered tool, a forged resource, an injected parameter.
- **Limits:** plan size, active runs, token budget.
- **Flags and queue:** flags off, and no queue.

**Browser tests** (`e2e/runs.spec.ts`):

- With the flags off, the routes and the page return 404.
- With the flags on:
  - sessions are required;
  - the tool list comes from the registry;
  - strict input is enforced;
  - an idempotent POST returns the same run;
  - a malformed approval hash is refused;
  - a stranger gets 403/404;
  - an unplanned run ends `FAILED` with a reason;
  - cancelling a settled run is a no-op;
  - the page starts and follows a run.

**Fixed while running the regression:**

- CI's `test:runs:db` step lacked `STORAGE_LOCAL_DIR`, which failed CI run 32 on `eb58d64`. It is now set, as for `test:stats:db`.
- A rejected approval whose settling stopped part-way could leave its run in `WAITING_APPROVAL` forever. The decision now always re-dispatches the run, and the executor settles a REJECTED approval on resume. There is a regression check for this.
- The runs page could show the previous run's detail right after starting a new one. It now shows only the selected run's detail.

## 10. Deferred (not in P1-D, per the plan and the approval)

- **Chat.**
  - Chat is not migrated onto runs.
  - The task planner/executor is not retired.
  - Legacy `POST /api/agent`, `src/agents/orchestrator.ts` and `agent_tasks` are not removed.
- **Registries.** Capability registry A and intent registry C have not been merged into the run registry.
- **Tools not built:**
  - PLS and CB-SEM;
  - deep research;
  - section writes;
  - exports and deletes;
  - any tool with an external side effect.
- **Run features:**
  - sub-runs or delegation;
  - parallel steps (ready steps run one at a time);
  - SSE with resume (the UI polls).
- **Replanning.** A run is planned once. `maxReplans` and the `limit_replans` stop reason are reserved but not used, so the effective number of replans is 0.
- **RLS scope.** RLS for the whole application, and on graph, statistics and legacy tables.
- **P1-E** and everything after it.

## 11. Known limitations

1. **Neon: the database layer is verified; the pre-production items still block.** Migrations 0014 and 0015 were applied on a Neon branch (PostgreSQL 18.6, role `neondb_owner`); see `P1D_NEON_VERIFICATION.md`. The checks showed that:
   - `academic_app` can be created and granted there;
   - it has no superuser, BYPASSRLS or login;
   - the fail-closed probe passes;
   - projects are isolated, and no rows are visible without a user;
   - cross-project, impersonating and viewer inserts are rejected;
   - the probe detects every way enforcement can be lost (RLS disabled, the role bypassing, missing or not granted).

   The application's connection role on Neon is `neondb_owner`: it is the only login role and it owns the tables. The probe was run through that role. The verification branch has since been deleted.

   **Still blocking before `FF_RUNS` is enabled anywhere real** (§5 of that document):
   - running the application's own run path (`test:runs:db`) against a Neon branch, directly and through the pooler. This was **not executed**: this environment's network policy denies the Neon endpoints;
   - confirming the production `DATABASE_URL` role and host;
   - running the probe against production after migrating with the flag off.

   The fail-closed behaviour is unchanged: without enforceable RLS, every run is refused (`rls_unavailable`).
2. **RLS covers only the run tables.** Graph and statistics writes made by tools are authorised in the application, by the P1-A/P1-C services (as approved). The whole app is not RLS-protected.
3. **Completing a step spans services and is not atomic.** A tool's effect (a P1-C run, a node) and the step's `SUCCEEDED` row are written in separate transactions. A crash between the two is handled by idempotency: the retry returns the existing effect. It does not produce a second one.
4. **Some decisions are settled as the run owner.** When a project OWNER who is not the run owner rejects an approval, the server settles the run's rows under the run owner's RLS scope. The OWNER's own rights were checked first.
5. **A timeout does not kill a handler.** The executor stops waiting and fails or cancels the step, but an in-flight P1-C computation finishes in the background. Its result is keyed by the step, so it cannot be recorded twice.
6. **The per-user rate limiter can fall back to memory.** If Redis is unavailable, the limiter uses per-instance memory (existing behaviour), which is weaker across instances. The per-run and per-day limits in the database are unaffected.
7. **Runs need a queue.** With `JOB_RUNNER=direct` (the default on Vercel without configuration), runs are refused with `queue_required`.
8. **Browser tests use no AI provider.** In the browser tests, a run ends `FAILED` with `planner_failed`. Planning, approval, execution and graph provenance are covered end to end by `test:runs:db`, which uses a scripted model through the real gateway.
9. **npm audit.** 0 production advisories. The 5 development-only advisories (esbuild via drizzle-kit; js-yaml via eslint) were already on `main` and are left for a separate PR, as instructed.
