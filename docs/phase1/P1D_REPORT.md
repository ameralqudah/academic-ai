# P1-D report: research run engine, tool registry, policy engine, approvals, RLS on run paths

**Date:** 2026-09-23 · **Plan and audit:** `docs/phase1/P1D_PLAN.md` · **Branch:** `claude/stoic-wozniak-5l0xmv` · **Base:** `main` at `003d95b` · **Status:** implemented under the approval conditions below. The full regression is green locally (§9). **Merged into `main` via [#33](https://github.com/ameralqudah/academic-ai/pull/33) (merge commit `5f18aaa`; PR head `a6fa42d`, all CI checks green). `FF_RUNS` remains off (default `false`). P1-E has not been started. **Verification closed (2026-09-24) for security and deployment:** Neon RLS and fail-closed behaviour verified; production migrations 0014/0015 applied and the read-only RLS probe passed; `FF_RUNS` and `FF_GRAPH` are absent in production (off). **Remaining gate before `FF_RUNS` is enabled:** the app-level `test:runs:db` on a Neon branch, covering `postgres-js` through the Neon pooled host on PostgreSQL 18 (§11.1; `P1D_NEON_VERIFICATION.md` §6).** **WS1 run-engine hardening (after the merge) is implemented on the same branch in groups 1–4 (§12), not yet merged; `FF_RUNS` stays off and the Neon app-level gate is still open.**

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
| `8879cb3` | WS1 group 1 (after the merge): active-time accounting; approval consume, authorise and claim in one transaction (§12) |
| `44517b3` | WS1 group 2: deterministic settlement of approval waits, reaper recovery, `rls_unavailable`, claim limit (§12) |
| `9c6cecb` | WS1 group 3: `replaceDatasetVersion` conflict and provenance; lease loss and write fencing (§12) |
| `52e8cf2` | WS1 group 4: run cancel/update ownership; migration `0016_p1d_run_owner.sql` (§12) |
| (group 5) | WS1 group 5: documentation only (this report's §12, the item 7 note, the `state.ts` header) |

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
  - Updates come from the run owner (still an EDITOR) or a project OWNER. In 0015 the run update policy allowed any EDITOR; migration `0016` (WS1 group 4, §12) narrows it to this.
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
- **Active time per run:** 10 / 30 / 60 min, with a per-step cap. Since WS1 group 1 (§12) this counts active execution only; time parked on an approval is bounded by the approval TTL instead.
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

1. **Neon: verification closed for security and deployment; one gate remains on `FF_RUNS`.** See `P1D_NEON_VERIFICATION.md`.
   - **Verified on a Neon branch** (PostgreSQL 18.6, role `neondb_owner`):
     - `academic_app` can be created and granted there;
     - it has no superuser, BYPASSRLS or login;
     - projects are isolated, and no rows are visible without a user;
     - cross-project, impersonating and viewer writes are rejected;
     - the probe refuses runs when RLS is disabled, the role bypasses, is missing, or is not granted.
   - **Verified in production:**
     - migrations 0014/0015 are applied;
     - the read-only `assertRlsEnforced` probe passes;
     - the app connects as `neondb_owner` via the **pooled** host;
     - `FF_RUNS` and `FF_GRAPH` are absent (off).
   - **Gate before `FF_RUNS` is enabled:** the app-level `test:runs:db` on a temporary Neon branch, direct and pooled. It covers `postgres-js` through the Neon pooled host on PostgreSQL 18, which is not yet exercised end to end; the suite passes on PostgreSQL 16 locally and in CI. It has **not** been executed.
   - **Why this is a gate, not a blocker:** it is functional, not a security gap. Without enforceable RLS, every run is refused (`rls_unavailable`).
2. **RLS covers only the run tables.** Graph and statistics writes made by tools are authorised in the application, by the P1-A/P1-C services (as approved). The whole app is not RLS-protected.
3. **Completing a step spans services and is not atomic.** A tool's effect (a P1-C run, a node) and the step's `SUCCEEDED` row are written in separate transactions. A crash between the two is handled by idempotency: the retry returns the existing effect. It does not produce a second one.
4. **Some decisions are settled as the run owner.** When a project OWNER who is not the run owner rejects an approval, the server settles the run's rows under the run owner's RLS scope. The OWNER's own rights were checked first.
5. **A timeout, a cancellation or a lost lease does not kill a handler.** The executor stops waiting and fails or cancels the step (or, on a lost lease, settles nothing), but an in-flight P1-C computation or model call finishes in the background. Keyed effects cannot be recorded twice. Model calls inside tools are not given the step's abort signal, so a retry can be billed a second time (outside WS1 scope).
6. **The per-user rate limiter can fall back to memory.** If Redis is unavailable, the limiter uses per-instance memory (existing behaviour), which is weaker across instances. The per-run and per-day limits in the database are unaffected.
7. **Runs need a queue.** With `JOB_RUNNER=direct` (the default on Vercel without configuration), runs are refused with `queue_required`.
8. **Browser tests use no AI provider.** In the browser tests, a run ends `FAILED` with `planner_failed`. Planning, approval, execution and graph provenance are covered end to end by `test:runs:db`, which uses a scripted model through the real gateway.
9. **Policy evaluation has a documented side effect (WS1 item 7, design note).** Evaluating the policy for `replaceDatasetVersion` asks the tool for its approval, which builds the Impact Report through `previewVersionReplacement` → `ensureVersionNode`. That creates the dataset versions' graph mirror nodes if they do not exist yet. It is idempotent, changes no result and is documented in the function (`src/server/stats/graph.ts`). WS1 deliberately did not change it (making the preview read-only would change the P1-A graph API); it is recorded here as a known limitation, not fixed.
10. **npm audit.** 0 production advisories. The 5 development-only advisories (esbuild via drizzle-kit; js-yaml via eslint) were already on `main` and are left for a separate PR, as instructed.

## 12. WS1: run-engine hardening after the merge

The post-P1-D readiness audit found run-engine correctness bugs. The approved WS1 plan fixes them on `claude/stoic-wozniak-5l0xmv` in separate commits, each with regression tests. **Not merged yet. `FF_RUNS` and `FF_GRAPH` stay off. The Neon app-level gate (§11.1) is unchanged and still open.** WS2 and WS3 (claim strictness, legacy numbers, `projectId` checks, metering) are not part of this.

**Group 1 (`8879cb3`), items 1 and 3:**
- **Active time.** `maxDurationMs` now bounds active execution only.
  - Parking on an approval records `spent.waitingSince` from the database's clock; resuming adds the wait to `spent.waitedMs`.
  - The executor and the policy both use `activeElapsedMs`, so an approval decided within its TTL no longer fails the run with `limit_time`.
  - `spent` is merged in SQL rather than overwritten from a snapshot.
- **Atomic authorise and claim.** Consuming an approval, authorising the step and claiming it as RUNNING happen in one transaction.
  - `requestApproval` parks the step and the run together or not at all.
  - A leftover AUTHORIZED step is re-queued and decided again.

**Group 2 (`44517b3`), items 2 and 4:**
- **Settling an approval wait.** A run waiting on an approval settles deterministically (`settleWaiting`):
  - an open request within its TTL keeps it waiting;
  - APPROVED resumes it;
  - REJECTED stops it with `approval_rejected`;
  - anything else stops it with `approval_expired`;
  - no waiting step at all resumes it, and the step logic settles it.
- **Reaper recovery.** The reaper also re-dispatches runs that have been quiet for 2 minutes with no live lease and need attention: an unfinished cancellation, or a wait no PENDING, unexpired request can end. The TTL is unchanged.
- **`rls_unavailable`.** An RLS failure at the lease claim or during a run ends it FAILED with `rls_unavailable`, with one event and nothing executed.
  - The write goes through `systemFailRunRlsUnavailable`, the only write on the owner connection. A smoke gate allows no other.
- **Claim limit.** `attempts` counts the lease claims since the run's last state change. The 21st claim without progress stops the run as `worker_lost`, so nothing is re-dispatched forever.

**Group 3 (`9c6cecb`), items 5, 5b and 6:**
- **Replacement success.** `replaceDatasetVersion` reports success only for its own effect: the `supersedes` edge must come from the requested new version and have been recorded by this run step. Otherwise it returns `CONFLICT` (`already_replaced`) and changes nothing.
- **Replacement provenance.** A run's replacement edge records `created_by_run_id`, `created_by_step_id` and origin `agent`. The user-facing replace route is unchanged.
- **Lease loss.** `src/server/runs/lease.ts` treats a renewal that finds the lease taken, or 2 renewal failures in a row, as a lost lease.
  - The step's signal is aborted, and the runner stops and settles nothing.
- **Write fencing.** The store fences every run and step write of a runner on the lease it holds (`asLeaseHolder`). A stale runner can't move the run, settle its steps or clear the new holder's lease.

**Group 4 (`52e8cf2`), item 9:**
- **Service.** `cancelRun` allows only the run's owner (still an EDITOR) or a project OWNER. An EDITOR can no longer cancel another member's run.
- **Migration `0016_p1d_run_owner.sql`.** It replaces the one policy `research_runs_update` with `(user_id = current user AND rank >= 3) OR rank >= 4`, in USING and WITH CHECK. Nothing else changes:
  - there's still no DELETE policy or grant;
  - the delete and truncate guards stay;
  - RLS stays on all four run tables;
  - there are 11 policies and no data change.
- **Where 0016 was applied:**
  - locally, incrementally and on a fresh database;
  - on a temporary Neon branch of `academic-ai-eu` (PostgreSQL 18.6, since deleted), where the same authorisation rules held through the restricted role.

  **It is not applied to production yet**; it will be applied by the normal migration step after the branch is merged, with `FF_RUNS` still off.

**Not changed (by decision):**
- **Item 7:** the policy preview's graph-mirror side effect is recorded as a known limitation (§11.9).
- **Item 8:** the `state.ts` header was corrected to say the database triggers enforce the transitions (no behaviour change).

**Tests after group 4** (local PostgreSQL 16):

| Suite | Result |
|---|---|
| `test:runs` | 82 passed (+11 across groups 1 and 3) |
| `test:runs:db` | 140 passed (+66 across groups 1–4) |
| `test:jobs` | 22 |
| `test:stats:db` | 105 |
| `test:tasks:db` | 39 |
| `test:graph` | 170 |
| typecheck, lint, smoke (including 2 new owner-connection gates) | green |

For each group, the new database checks were also run against the previous implementation. They fail there as expected: 8, 15, 12 and 4 checks for groups 1–4. **The full regression (build, browser tests with flags off and on) is still to be run before the PR is opened.**
