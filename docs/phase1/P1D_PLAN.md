# P1-D plan: research run engine, tool registry, policy engine, approvals, RLS

**Date:** 2026-09-23 · **Base:** `main` at `003d95b` (P0, P1.0, P1-A, P1-A.1, P1-B and P1-C merged) · **Status:** audit and plan only. **No code has been changed. Implementation waits for approval.**

**Goal.** Put one controlled path between a user's intent and anything the system does:

```
intent → planner (Model Gateway, structured plan; never executes)
       → tool registry (the only list of tools)
       → policy (ALLOW / DENY / REQUIRE_APPROVAL, server-side, immediately before execution)
       → approval (bound to the exact action by hash)
       → executor (durable run → steps, idempotent, leased, cancellable)
       → result (typed, bounded; P1-C for every number)
       → Research Graph (provenance: run, step, actor)
       → run events (audit: what happened, why it was allowed, what the model asked for)
```

P1-D is an execution layer over what P1-B (gateway) and P1-C (statistics, versions, graph integration) already provide. It is not an agent rewrite, and it does not change P1-C's methods.

**How this audit was done.** Four read-only audits traced production call paths from routes and UI down to the database. They covered:

- tasks, planner, executor and jobs;
- tools, gateway, entitlements and policy;
- authorisation, RLS, schema and graph;
- user-facing flows.

The load-bearing claims were then re-checked by hand against the code, and the database catalog was queried. File references are to `003d95b`.

---

## 1. Current architecture

| Layer | Where | State |
|---|---|---|
| Model access | `src/server/ai/gateway/` (P1-B) | One path to providers. Fail-closed user scope, per-tier entitlement and output caps, quota reservation, per-attempt metering (`ai_usage_events`), tool-call records (`ai_tool_calls`). |
| Task system | `src/server/tasks/` (planner, executor, 16 capability handlers), `tasks` / `task_steps` | The live path for chat's "agent" route (`/api/chat` → `startTask`). LLM plan over capability ids; DAG executor; leases; reaper. |
| Analysis jobs | `analysis_jobs` + `src/server/jobs/` (pg-boss) | `pls.bootstrap`, `research.deep`, `stats.run`. Conditional transitions (P1-C). |
| Statistics | `src/server/stats/` (P1-C) | Versions, specs, immutable runs, graph recording, 7 `stats` tools (the only native tool-calling path). |
| Research Graph | `src/server/graph/` (P1-A/A.1) | Nodes, edges, versions, stale marks; Impact Report acknowledgement; engine-only `recordRun`. |
| Legacy agent | `src/agents/orchestrator.ts` + `POST /api/agent` | A second planner/executor (`MAX_STEPS=12`, `agent_tasks`). Not reachable from the UI; still callable by HTTP. |
| Jobs | one pg-boss instance, queues `task-run`, `analysis-job-run`, `jobs-reaper` | `JOB_RUNNER` = inline / worker / direct (direct is the Vercel default: no queue, no lease, no reaper). |
| Flags | `FF_GRAPH` only (`config/env.ts:170`) | `flagged()` (`graph/access.ts:25`) is hard-wired to it. All `/api/v1/**` routes (graph and statistics) sit behind it. |
| Database | one role `postgres` (superuser, BYPASSRLS, owns every table) | **No RLS**: 0 of 41 tables; `pg_policies` empty. |

## 2. Existing execution paths (traced)

1. **Chat.** `agent-chat.tsx` → `POST /api/chat` → `routeRequest` (LLM intent + rules) → `fast` (streamed answer) or `agent` (`startTask` → 202 → task panel with SSE). There are no tool calls in chat itself. The mode is hard-wired to `'chat'` (`agent-chat.tsx:211`), so the web-search, deep-research, workspace and `/api/agent` branches cannot be reached from the UI.
2. **Tasks.** `startTask` → `dispatchTask` (pg-boss or an in-process promise) → `runTaskJob` → `planAndRun` → `planTask` → `persistPlan` → `runTask`. The UI streams `/api/tasks/[id]/stream` (DB poll every 1.5 s).
3. **Statistics (FF_GRAPH).** Workbench → `/api/v1/.../analyses/specs` → `startRun` (inline, or `stats.run` job) → graph. Assistant: `POST .../analyses/assistant` → `runAssistant` → `gateway().toolCall` with the 7 `stats` tools (`stats/tools.ts:119`), the **only** production `toolCall`.
4. **Direct routes, reachable by HTTP only:** `/api/deep-research`, `/api/pls`, `/api/cbsem`, `/api/web-search`, `/api/agent`, `/api/ai/tools`, `/api/ai/sections`.
5. **Writing.** `POST /api/ai/sections` → `generateSection` → `saveSection(status:'AI_SUGGESTED')`. This overwrites the current section, including an APPROVED one (only history keeps the old text). Section routes check the project *creator* only and ignore project members.

## 3. Existing planner / executor behaviour

- **The planner proposes; it does not execute.** It calls `generateStructured` with a loose shape (`steps: z.record(z.string(), z.unknown())`, `planner.ts:430`).
  - Unknown capabilities, duplicates, dangling dependencies and cycles are dropped. Prerequisites are auto-inserted.
  - "At most 40 steps" appears only in the prompt; `parsePlan` does not enforce it.
  - **Step input is free-form** (`planner.ts:521`), and there is no schema per capability.
- **The executor** (`executor.ts:241`):
  - runs in `runForUser(owner)` + `withCallIds({taskId, projectId})`;
  - claims steps conditionally (`claimStep`) and batches up to 3;
  - has a budget of 50 steps, 2 h, 120 model calls and 12 retries. Model calls are *self-reported* by handlers, not metered.
- **Verified defects:**
  - `recoverStranded` resets **every** RUNNING step of the task to PENDING at the start of each run (`tasks.repository.ts:264`), regardless of who holds it. A second runner, such as direct-mode `resumeInterrupted` on another instance or a lease lapse, **re-executes steps**. A crash re-run does not increment `attempts`.
  - `setStatus` (task) and `completeStep` / `failStep` / `skipStep` are unconditional. `cancelTask` sets CANCELLED even on COMPLETED or FAILED tasks (`task.service.ts:543`).
  - Cancellation is checked only between batches. It can be overwritten by the REPLANNING → RUNNING write, or by WAITING_FOR_INPUT during planning.
  - The step timeout only calls `controller.abort()` (`executor.ts:712`); only `deep.research` reads the signal. A hung handler hangs the task.
  - `startTask` stores `projectId` **without an ownership check**. `POST /api/tasks` does not check `conversationId` before creating the task.
  - `statistics.pls` / `statistics.cbsem` accept a planner-supplied `input.model` that bypasses the `confirmed` gate (`handlers.ts:706`).
  - Mutating steps carry no idempotency key: duplicate artifacts and `analysis_runs` rows on re-run. `persistPlan` is not transactional.
  - `MAX_ACTIVE=2` is read-then-insert. Resume can add +50 steps and +200 model calls, repeatably.
  - The UI "Retry" on FAILED calls `resume`, which the server rejects for anything not PAUSED.

## 4. Existing tool registry status

There are **four independent registries** with no shared type or test:

| Registry | Entries | Metadata |
|---|---|---|
| A. `tasks/capabilities.ts` `CAPABILITIES` | 16 capability ids | timeout, retry, parallelSafe, estimated calls. **No input schema, risk, mutating flag or plan gate.** `registerCapability` mutates it at runtime (unused). |
| B. `stats/tool-names.ts` + `stats/tools.ts` `STATS_TOOLS` | 7 | strict zod via `defineTool`. Dispatch is a `switch`. |
| C. `src/agents/registry.ts` | 23 intent keys | status, agent, requiresDataset, tests. Used by the live intent router. |
| D. `config/research.ts` `TOOLS` | 8 writing tools | per-plan `toolAccess` gate (the only per-plan feature gate that is enforced). |

- Two different exported `capabilityFor` functions exist (A and C). The header comment in `gateway/tools.ts` says "no second registry", which is untrue.
- `GatewayTool` is `{name, description, parameters, validate}`: no risk, side effect, role, plan, cost or approval.
- `permittedTools` is a caller-supplied list (the stats assistant passes all 7).

## 5. Existing policy / entitlement status

- **There is no policy engine.** (`gateway/policy.ts` holds timeouts and retries.)
- **Gateway:**
  - The project check is VIEWER only. Mutating authorisation lives in each service: EDITOR checks in stats and graph.
  - Plan tier is derived twice (`gateway/index.ts:70` and `model-access.service.ts:27`). Model entitlement is duplicated (routing `ENTITLEMENT` vs `agents/modes.ts`).
- **Plan limits:**
  - `maxExports` and `maxAiTasks` are not enforced; `hasToolAccess` is unused.
  - Task capabilities (deep research, PLS, …) have no plan gating.
- **Quota:** legacy `assertCanUseAI` (check-then-act) still runs alongside the gateway reservation.
- **Rate limits** are keyed **by IP only**, run before authentication, and **fail open** (`http/rate-limit.ts:9, 258`).
- **Approvals:**
  - **Hash-bound:**
    - The Research Graph Impact Report (`reportHash`, `assertAcknowledged`, 428 `IMPACT_ACK_REQUIRED`, re-checked at commit).
    - P1-C `startRun` supersede (also re-checked after computing).
  - **Generic booleans:**
    - dataset `deleteEverything(confirmed)` (`?confirm=yes`, route passes `true`);
    - PLS `confirmed`, which is never produced.
  - `ai_tool_calls` has no decision or approval column.

## 6. Existing run / step persistence

| Record | Status column | Transitions | Idempotency | Payload limits |
|---|---|---|---|---|
| `tasks` | varchar (9 states) | **unconditional** | none | none (jsonb context, budget, spent) |
| `task_steps` | varchar (6 states) | claim conditional; the rest unconditional | none | none |
| `analysis_jobs` | enum | conditional (P1-C) | `singletonKey = id` | `result` jsonb |
| `stat_runs` | varchar + DB trigger | DB-enforced state machine | `(spec_id, idempotency_key)` unique | typed columns |
| `agent_tasks` (legacy) | — | — | — | — |

- `ai_usage_events.run_id` / `ai_tool_calls.run_id` exist, but **`runId` is never set in production** (`withCallIds` callers pass only project, task and job ids).

## 7. Existing job integration

- **One pg-boss instance.** Queues: `task-run` (retry 3, 3 h), `analysis-job-run` (retry 2, 1 h), `jobs-reaper` (every minute). Enqueued with `singletonKey = id`.
- **Leases.** 120 s, with a 30 s heartbeat.
  - A CPU-bound synchronous PLS computation can starve the heartbeat.
  - The reaper then re-enqueues the task, and `recoverStranded` re-runs its steps.
- **Direct mode (Vercel default).** Runs a floating promise with no lease. `resumeInterrupted()` on every cold start re-dispatches up to 20 RUNNING tasks of any user; the code comment admits it cannot tell a dead run from a live one.
- **There is no second queue technology.** There are three run models on the one queue: tasks, analysis jobs and legacy `agent_tasks`.

## 8. Existing Research Graph integration

- **`Actor {userId, runId?, origin?}`** (`graph/service.ts:82`) flows into `graph_nodes.created_by_run_id` / `origin`, `graph_edges.*` and `node_versions.created_by_run_id`.
  - `created_by_run_id` is text with **no FK**. Today it holds a `stat_runs.id` or NULL.
- **Engine-only writes.** `recordRun` is idempotent on the engine run id (advisory lock). `createClaim` is atomic (P1-C).
- **Tasks never write to the graph.** The statistics path is the only graph writer outside the `/api/v1` graph routes.
- **`authorize()`** reads project roles on the global `db`, outside the write transaction.

## 9. Existing RLS status

- **None.** No `ENABLE ROW LEVEL SECURITY`, policy, `SET ROLE`, `set_config` or role anywhere in migrations or code. In the test database, `relrowsecurity` is set on 0 of 41 tables.
- **One role.** `postgres` (superuser, BYPASSRLS) is used by the app, migrations, seed, CI and pg-boss, and it owns every table. RLS would be bypassed even if enabled.
- **Pooling.** `postgres-js` with `prepare:false` behind the Neon pooler (transaction mode); `max` is 1 on serverless. Only transaction-local settings (`set_config(…, true)`, `SET LOCAL ROLE`) are safe. Most reads, including `requireProjectRole`, run outside transactions.
- **Ownership model.** Every project has an OWNER row in `project_members` (backfilled in 0011; `projectsRepo.create` inserts one). Legacy project routes (sections, titles, references, notes, export) still check `research_projects.user_id` only (P1-A review F-19).

## 10. Security gaps (relevant to P1-D)

| # | Gap | Evidence |
|---|---|---|
| S-1 | Task `projectId` (and `conversationId` on `/api/tasks`) is stored without an ownership check, then used for metering and artifacts | `task.service.ts:52-106` |
| S-2 | Planner-supplied PLS/CB-SEM model bypasses the confirmation gate; model size unbounded | `handlers.ts:706, 787` |
| S-3 | Step input is free-form; there is no schema per capability | `planner.ts:521` |
| S-4 | No policy layer: the tools that change data (`createAnalysisSpec`, `runAnalysis`) are offered and executed exactly like read-only tools | `stats/tools.ts:121` |
| S-5 | A tool-call audit insert failure is swallowed, and the tool still runs | `gateway.ts:521-524` |
| S-6 | Rate limits IP-only, before auth, fail-open | `rate-limit.ts` |
| S-7 | No database-level isolation (no RLS, superuser app role) | catalog |
| S-8 | Approvals outside the graph are generic booleans (`confirm=yes`) | `datasets/[id]/route.ts` |
| S-9 | Section writes: client-asserted `origin` / `status`; AI overwrites APPROVED text; creator-only check | `validation/project.ts:36`, `ai.service.ts:427` |
| S-10 | Legacy `POST /api/agent` (second planner/executor) is still callable | `api/agent/route.ts` |

## 11. Reliability gaps

| # | Gap |
|---|---|
| R-1 | Duplicate step execution (`recoverStranded` plus a second runner); crash re-runs don't count attempts, so `maxAttempts: 1` is not honoured |
| R-2 | Cancellation is not monotonic: it overwrites terminal states, can be lost during REPLANNING or planning, is never checked mid-step, and is not propagated to handlers |
| R-3 | Timeouts are not enforced (abort only; handlers ignore it) |
| R-4 | `persistPlan` is not transactional; `MAX_ACTIVE` is not atomic |
| R-5 | Direct mode (Vercel default): no lease or reaper; `resumeInterrupted` may run a live task twice |
| R-6 | Unbounded jsonb payloads (context, step output) served in full on every stream tick |
| R-7 | UI "Retry" on FAILED is broken (server only resumes PAUSED) |

## 12. Cost-control gaps

- The task budget counts **self-reported** model calls, not metered usage (`ai_usage_events` exists but is unused for this). Resume raises budgets without an upper bound.
- **No money budget** per run, user or day: cost is recorded but not enforced.
- **No cap on tool calls per round** in the stats assistant (a round may return N calls).
- **Weak plan limits.** Capabilities have no plan gating. `maxAiTasks` is unenforced.
- **Concurrency caps share one counter.** Tasks allow 2, deep research 1, PLS 2 and statistics 3, but the three job caps are all counted from `analysis_jobs.countActive`.

---

## 13. Proposed P1-D architecture

New server module **`src/server/runs/`**, the only code that executes tools on behalf of a plan:

| File | Responsibility |
|---|---|
| `registry.ts` | **The** tool registry: `ToolDef`s, frozen at module load; `toolByName`, `listTools`, and `toolsForGateway(decisions)` → `GatewayTool[]`. |
| `tools/*.ts` | Tool adapters, one file per category (data, statistics, research, writing, graph). Each adapter calls an existing service (P1-C `createSpec` / `startRun` / `getRun` / `transformVersion` / `replaceVersion`, graph `createNode` / `createClaim` / `trace`, knowledge `search`, gateway). **No business logic or statistics in adapters.** |
| `policy.ts` | `decide(ctx, tool, input) → PolicyDecision`. Pure function plus a context loader. |
| `approvals.ts` | Hash-bound approvals: request, decide, verify and consume. |
| `state.ts` | Run and step state machines (a transition table used by the service; the same table in a DB trigger). |
| `planner.ts` | Intent → `RunPlan` through `gateway().generateStructured`. Never executes. |
| `executor.ts` | Claims, authorises, executes and records steps. Leased, idempotent, cancellable. |
| `limits.ts` | Hard limits (§ Phase 12/14) and the stop logic. |
| `events.ts` | Append-only run events (audit plus the stream source). |
| `service.ts` | Public API for routes: `createRun`, `getRun`, `listRuns`, `cancelRun`, `decideApproval`. |
| `db-scope.ts` | `withRlsScope(userId, fn)`: one transaction with `SET LOCAL ROLE academic_app` and `set_config('app.user_id', …, true)`, with `tx` carried in AsyncLocalStorage. |

**What stays and what changes (decisions for review):**

| Component | Decision | Why |
|---|---|---|
| P1-B gateway | **Unchanged** except: `withCallIds` gains `stepId`; `runId`/`stepId` are populated; `toolCall`'s `permittedTools` comes from policy decisions. | Already correct; the audit record just needs the ids. |
| P1-C statistics | **Unchanged methodology.** `STATS_TOOLS` / `executeStatsTool` move into the registry as adapters over the same service calls. The `/analyses/assistant` route keeps its contract and runs through the registry + policy. | One registry; no second statistics path. |
| Graph service | **Unchanged rules.** Adapters call its public functions with `Actor {userId, runId: researchRunId, stepId, origin: 'agent'}`. One additive column pair for step provenance. | Keeps P1-A/A.1 integrity. |
| Task planner / executor | **Wrapped, not replaced, in P1-D.** Chat keeps using tasks. With `FF_RUNS` off nothing changes. The run engine reuses `findCycle` / `readySteps` / `blockedSteps` / `repairPrerequisites` but has its own executor. | Rewriting chat's path is a large behavioural change. Replacing tasks with runs for chat belongs to a later phase once runs are proven. |
| Task defects S-1, S-2, R-1, R-2, R-7 | **Proposed as always-on fixes in P1-D** (small, conditional writes; ownership check; monotonic cancel; attempts on reclaim; PLS model requires confirmation; working retry). | They are correctness and security bugs in the live chat path; same approach as P1-C's legacy fixes. **Needs your approval** (it touches pre-P1 code). |
| Legacy `/api/agent` orchestrator | **Out of scope** (listed in §24). | Not reachable from the UI; removal is a separate decision. |
| Capability registry A, intent registry C, TOOLS D | Unchanged in P1-D. The run registry is authoritative **for runs and tool calling**; a smoke gate forbids any new `defineTool` outside `src/server/runs/`. | Merging A/C/D touches chat routing and billing; deferred. |

**Request flow (flag on):**

```
POST /api/v1/projects/:id/runs {intent, datasetVersionId?}
  → auth, flag, per-user rate limit, EDITOR on project
  → research_runs row (QUEUED) + run_events(created) → enqueue 'research-run' (existing pg-boss)
worker: claim lease → PLANNING → planner (gateway, structured, tools = registry ∩ policy preview)
  → plan validated (schemas, limits, DAG) → run_steps rows (one transaction)
  → for each ready step: policy.decide → ALLOW | DENY | REQUIRE_APPROVAL
      REQUIRE_APPROVAL → approval row (hash) → step WAITING_APPROVAL, run WAITING_APPROVAL → stop
      ALLOW → AUTHORIZED → RUNNING → adapter (idempotency key) → output reference → SUCCEEDED
  → user approves (hash echoed) → run re-enqueued → policy re-evaluated → executes
  → finally SUCCEEDED / FAILED (with stop reason) / CANCELLED
```

## 14. Database changes (migration `0014_p1d_runs.sql` + `0015_p1d_rls.sql`)

`0014` (additive):

- **`research_runs`**:
  - `id`, `project_id` (NOT NULL; every run belongs to a project), `user_id`, `intent` (text ≤ 4000), `plan` (jsonb, validated, ≤ 64 KB);
  - `status`, `stop_reason` (enum: `limit_steps`, `limit_time`, `limit_tokens`, `limit_cost`, `policy_denied`, `approval_rejected`, `approval_expired`, `planner_failed`, `tool_failed`, `cancelled`, `worker_lost`);
  - `budget`, `spent` (jsonb, typed), `planner_model`, `planner_provider`, `planner_call_id`;
  - `cancel_requested_at`, `lease_owner`, `lease_expires_at`, `attempts`;
  - `idempotency_key` (unique per user), `error` (jsonb, bounded);
  - `created_at`, `started_at`, `finished_at`.
- **`run_steps`**:
  - `id`, `run_id`, `seq` (unique per run), `tool`, `tool_version`, `depends_on` (uuid[] ≤ 20);
  - `input` (as planned, ≤ 16 KB), `validated_input` (≤ 16 KB), `input_hash`;
  - `status`, `attempts`, `max_attempts`;
  - `policy` (jsonb: decision, rule ids, reasons, evaluated_at, role, tier), `approval_id`;
  - `idempotency_key` (UNIQUE), `output` (≤ 64 KB), `output_ref` (typed: `{kind: 'stat_run'|'stat_spec'|'dataset_version'|'graph_node'|'claim'|'artifact'|'text', id}`);
  - `error` (≤ 4 KB), `started_at`, `finished_at`, `duration_ms`.
- **`run_approvals`**:
  - `id`, `run_id`, `step_id`, `project_id`, `user_id` (requester), `action_hash` (sha256), `action` (jsonb: tool, version, validated input digest, human summary, targets, impact report hash if any);
  - `status` (PENDING, APPROVED, REJECTED, EXPIRED, CONSUMED), `expires_at`;
  - `decided_by`, `decided_at`, `consumed_at`.
- **`run_events`**: `id` bigserial, `run_id`, `step_id`, `project_id`, `type`, `data` (jsonb ≤ 4 KB, no raw datasets or secrets), `created_at`. Insert-only.
- **Triggers (P1-C style):**
  - legal status transitions for runs and steps, and terminal states frozen;
  - identity columns immutable;
  - `run_events` / `run_approvals` rows immutable except the approval decision and consume (`PENDING → …`, `APPROVED → CONSUMED`);
  - no direct DELETE or TRUNCATE outside cascades;
  - CHECKs on sizes (`octet_length(...::text)`).
- **Additive columns elsewhere:**
  - `ai_tool_calls.step_id`, `ai_usage_events.step_id` (nullable).
  - `graph_nodes.created_by_step_id`, `graph_edges.created_by_step_id`, `node_versions.created_by_step_id` (nullable text, like `created_by_run_id`).
  - `dataset_transformations.idempotency_key` (nullable; unique per input version). This adds a column to a write-once P1-C table; the write-once trigger is unaffected for new rows.
- **pg-boss:** one new queue name `research-run` on the **existing** instance (not a new system), plus reaper coverage.

`0015` (RLS, reviewable separately): see §21.

## 15. API changes (all behind `FF_RUNS`, which requires `FF_GRAPH`)

| Route | Purpose |
|---|---|
| `POST /api/v1/projects/:id/runs` | Create a run from an intent (optional `datasetVersionId`, `Idempotency-Key` header). EDITOR. |
| `GET /api/v1/projects/:id/runs` | List (bounded, paged). VIEWER. |
| `GET /api/v1/projects/:id/runs/:runId` | Run + steps (bounded outputs) + pending approvals. VIEWER. |
| `DELETE /api/v1/projects/:id/runs/:runId` | Request cancellation (monotonic). EDITOR. |
| `POST /api/v1/projects/:id/runs/:runId/approvals/:approvalId` | `{decision: 'approve'|'reject', actionHash}`. The hash must equal the stored one. Only the run's user or a project OWNER may decide. |
| `GET /api/v1/projects/:id/runs/:runId/events?after=` | Event page (cursor). The UI polls it; SSE is optional (reuses the task-stream pattern with bounded payloads). |
| `GET /api/v1/projects/:id/tools` | Tools available to the caller here, with the policy preview (for the UI and the planner prompt). |

- **Existing routes unchanged**, except:
  - `/analyses/assistant` now executes through the registry and policy (same response shape);
  - `flagged()` is generalised to `flagged('graph' | 'runs')`.
- **Rate limits.** New routes use a per-**user** limiter key (after auth), and fail **closed** for run creation and approvals when the store is down. The IP limiter stays as the first layer.

## 16. Tool registry design

```ts
interface ToolDef<I, O> {
  name: string;               // 'stats.runAnalysis' — /^[a-z]+\.[a-zA-Z]+$/
  version: string;            // semver; recorded on every step
  description: string;        // model-facing
  category: 'data' | 'statistics' | 'research' | 'writing' | 'graph';
  input: ZodType<I>;          // strict, bounded (string lengths, array sizes); also the JSON Schema for the model
  output: ZodType<O>;         // validated before anything is stored or returned to a model
  sideEffect: 'read' | 'compute' | 'write' | 'external_read' | 'destructive';
  risk: 'low' | 'medium' | 'high';
  requiredRole: 'VIEWER' | 'EDITOR' | 'OWNER';
  entitlement: { tiers: Tier[]; feature?: string };
  contexts: Array<'run' | 'assistant'>;       // where it may be offered
  approval: 'never' | 'always' | ((input, ctx) => ApprovalReason | null);
  timeoutMs: number;
  retry: { maxAttempts: number; retryOn: ErrorClass[] };   // 0 retries for destructive
  idempotency: 'natural' | 'keyed' | 'none-read-only';     // mutating tools must be 'keyed'
  costEstimate(input, ctx): { modelCalls: number; computeUnits: number };
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;   // ctx: actor, project, run, step, idempotencyKey, signal, gateway, tx scope
}
```

**Proposed v1 tool set** (each an adapter over an existing function; none new in substance):

| Tool | Side effect | Approval | Backing function |
|---|---|---|---|
| `data.listDatasets` | read | never | `listProjectDatasets` |
| `data.inspectDataset` | read | never | `qualityReport` |
| `data.validateDataset` | read | never | `validateDataset` via `qualityReport` |
| `data.createVersion` | write | when the transformation drops rows or imputes | `transformVersion` (keyed) |
| `data.replaceVersion` | destructive (makes dependents stale) | **always**; action hash includes the Impact Report hash | `replaceVersion` |
| `stats.createAnalysisSpec` | write | never | `createSpec` |
| `stats.validateAnalysisSpec` | read | never | `validateSpecRecord` |
| `stats.runAnalysis` | compute | when heavy (above `INLINE_COST_LIMIT`) or superseding | `startRun` with `idempotencyKey = step key` |
| `stats.getAnalysisResult`, `stats.getAnalysisProvenance` | read | never | `getRun`, `getProvenance` |
| `stats.generateTable`, `stats.generateFigure` | read | never | stored tables and figures |
| `research.searchLiterature` | external_read | never | `knowledge.search` (OpenAlex / Crossref) |
| `research.retrieveSource` | external_read | never | `fetch-content` (existing SSRF guard) |
| `research.extractEvidence` | compute (model) | never | gateway `generateStructured` over retrieved text; output bounded; nothing stored in the graph |
| `writing.explainResult` | compute (model) | never | `explainRun` (token protocol; no typed digits) |
| `writing.generateDraft` | compute (model) | never | gateway `generate`. Stored as step output only, never written into project sections in P1-D. Statistics only as `{{value:key}}` tokens (strict check). |
| `graph.read` | read | never | `trace`, `getNode`, `listNodes` (bounded) |
| `graph.createNode` | write | never; allowed types only: `hypothesis`, `construct`, `research_question`, `note-like` (no engine types) | `graph.createNode` |
| `graph.createClaim` | write (manuscript) | **always** | `insertClaim` (P1-C) |

- **Not exposed:** delete of anything, section writes, exports, PLS/CB-SEM (legacy, CPU-bound, unconfirmed models) and deep research (10-minute external pipeline). These are listed in §24.
- **Smoke gates:**
  - every registered tool has input and output schemas, and a mutating tool must be `keyed`;
  - no `defineTool` outside `src/server/runs/`;
  - adapters import no provider SDK and no `@/analysis/engine` numerics (statistics only through P1-C services).

## 17. Policy engine design

`decide(ctx, tool, input): PolicyDecision` with `{outcome: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL', rules: RuleResult[], approval?: {reason, actionHash}}`. The rules run in a fixed order, and the first DENY wins:

1. **tool.known**: the name is in the frozen registry (no arbitrary names).
2. **tool.context**: the tool is allowed in this context (run or assistant).
3. **flag**: the tool's feature flag is on.
4. **auth.project**: the actor's role on the project (via `requireProjectRole`, fresh per decision) ≥ `requiredRole`.
5. **auth.resources**: every id in the validated input belongs to this project and is visible to the actor. Adapters declare their id fields and the policy resolves them: dataset version, spec, run, graph node. This closes forged cross-project ids.
6. **entitlement**: the plan tier (`resolvePlanForUser`, same derivation as the gateway) is in `tool.entitlement.tiers`.
7. **limits.run**: steps used, tool calls, wall time, retries, tokens and cost (metered from `ai_usage_events` by `run_id`) below the run budget.
8. **limits.user**: active runs per user (atomic count under an advisory lock) and the daily cost ceiling per tier.
9. **run.state**: the run is RUNNING, not cancel-requested, and within its lease.
10. **approval**: `tool.approval(input, ctx)` → if an approval is needed, look for an APPROVED, unexpired, unconsumed approval whose `action_hash` equals the recomputed hash. Present → ALLOW (and consume). Absent → REQUIRE_APPROVAL.

- The decision (outcome, rule ids, reasons, role, tier) is stored on the step and in `run_events`. That answers "why was this allowed or denied".
- **Where it runs.** The executor calls `decide` **immediately before execution**, inside the step claim. The planner may call it for a preview, but the preview is never trusted.
- **No LLM input.** The model's output is data for the policy, never a decision.
- **Gateway `toolCall`.** `permittedTools` = the tools whose preview is not DENY. Every model-requested call is still re-decided before it runs.

## 18. Approval design

- **The action hash:**

  ```
  action_hash = sha256(canonical{project_id, run_id, step_id, tool, tool_version,
                                 validated_input_hash, target_versions, impact_report_hash?})
  ```

  - `target_versions` are the current versions or hashes of what the action touches: the dataset version's content hash, the graph node versions, the P1-C run id being superseded.
  - `impact_report_hash` is included for graph-affecting tools. It is computed with the existing `previewRerun` / `buildReport`.
- **Requesting.** `run_approvals` row PENDING, with an `expires_at` (default 24 h). `action` holds a human summary plus a structured preview, so the UI shows exactly what will happen.
- **Deciding.** The client sends back `actionHash`. The server:
  - checks it equals the stored hash;
  - checks the decider may decide (the run's user or a project OWNER; VIEWERs never);
  - checks the approval is still PENDING and unexpired.
- **Before execution.** The executor **recomputes** the hash from the current state. If the input, the target versions or the impact set changed, the approval does not match: the step returns to REQUIRE_APPROVAL with a new request, and the old one is marked EXPIRED. A consumed approval cannot be reused (single-use, `consumed_at`, unique per step).
- **Graph acknowledgement.** For graph writes the adapter passes the same `impact_report_hash` as `impactAcknowledged`, so the P1-A protocol re-checks at commit as it does today.
- **Audit.** Every request, decision, expiry and consumption is a `run_events` row.

## 19. State machine

**Run:**

```
QUEUED → PLANNING → RUNNING ⇄ WAITING_APPROVAL
PLANNING → FAILED (planner_failed | limits) | CANCELLED
RUNNING → SUCCEEDED | FAILED | CANCELLED
WAITING_APPROVAL → RUNNING (approved) | FAILED (rejected/expired) | CANCELLED
terminal: SUCCEEDED, FAILED, CANCELLED (frozen)
```

**Step:**

```
QUEUED → AUTHORIZED | WAITING_APPROVAL | SKIPPED (denied / dependency failed) | CANCELLED
WAITING_APPROVAL → AUTHORIZED | SKIPPED (rejected/expired) | CANCELLED
AUTHORIZED → RUNNING | CANCELLED
RUNNING → SUCCEEDED | FAILED | CANCELLED (only if no effect was committed)
FAILED → QUEUED (retry: attempts < max_attempts, tool retryable, not destructive)
terminal: SUCCEEDED, SKIPPED, CANCELLED, FAILED (after last attempt) — frozen
```

- **Enforced twice:**
  - in the service (conditional `UPDATE … WHERE status = <from>`, returning whether it applied);
  - by a DB trigger with the same table.
- **Cancellation is monotonic:**
  - `cancel_requested_at` is set once;
  - the executor checks it before claiming each step and passes an `AbortSignal` into every adapter;
  - a SUCCEEDED step never becomes CANCELLED;
  - a CANCELLED run never becomes SUCCEEDED (the trigger refuses).
- **Replanning.** At most 1 replan per run (bounded); it appends steps with new seq numbers and never edits executed steps.

## 20. Idempotency strategy

- **Step key.** `idempotency_key = sha256(project_id | run_id | seq | tool | tool_version | validated_input_hash)`, unique on `run_steps`.
- **Every mutating adapter is `keyed`.** It makes the target record idempotent on that key, using the target's own mechanism:
  - `stats.runAnalysis` → P1-C `startRun({idempotencyKey})`, unique `(spec_id, idempotency_key)`. It returns the existing run.
  - `stats.createAnalysisSpec` → specs are content-hashed; the adapter first looks up `(project, version, spec_hash, created_by step)`, a new nullable column, and reuses the spec it finds.
  - `data.createVersion` → `dataset_transformations.idempotency_key` (new, unique per input version).
  - `graph.createNode` / `graph.createClaim` → `created_by_step_id` + a partial unique index `(project_id, created_by_step_id, type)`, looked up before the insert.
  - `data.replaceVersion` → graph `supersede` refuses a second supersede of the same node (`already_superseded`); the adapter treats that as success when the recorded replacement matches.
- **Retries.** On retry, recovery or double delivery, the adapter returns the existing effect instead of creating a second one.
- **Consistency across services.** The step's SUCCEEDED write happens after the effect commits.
  - If the process dies in between, the reclaim finds the effect by key and completes the step.
  - This converges without a cross-service transaction and without hiding duplicates.
  - Where the effect is written in the run's own transaction (run events, approvals), it is atomic.
- **Run creation.** Idempotent on `(user_id, idempotency_key)` from the `Idempotency-Key` header.

## 21. RLS strategy

**Principle.** RLS as a second, enforced layer for **the P1-D paths**, without changing the connection role of the whole application in this phase.

- **Roles** (`0015`):
  - `academic_app`: NOLOGIN, **NOBYPASSRLS**, with SELECT/INSERT/UPDATE on the protected tables.
  - `academic_worker`: NOLOGIN, BYPASSRLS, for the reaper, leases and admin reports.
  - Both are granted to the migration/owner role.
- **Scope.** `withRlsScope(userId, fn)` opens one transaction, runs `SET LOCAL ROLE academic_app` and `set_config('app.user_id', userId, true)`, and exposes `tx` through AsyncLocalStorage. Both settings are transaction-local, so they are safe behind the transaction pooler.
- **Policies:**

  | Table | Read | Write | Worker | Admin |
  |---|---|---|---|---|
  | `research_runs`, `run_steps` (via run), `run_approvals`, `run_events` | project member | run user (insert); status updates through the executor | executor runs **as the run's user** under `academic_app`; the reaper as `academic_worker` | via worker role, read-only reports |
  | `graph_nodes`, `graph_edges`, `node_versions`, `stale_marks` | member ≥ VIEWER | member ≥ EDITOR (insert/update) | as above | — |
  | `stat_specs`, `stat_runs`, `stat_estimates`/`tables`/`figures` (via run), `dataset_versions`, `dataset_transformations` | member, or `user_id = me` when `project_id` is NULL (mirrors `stats/access.ts`) | same as read, insert-only (existing triggers still apply) | as above | — |
  | `project_members` | own rows + rows of projects I belong to | — (no write path in P1-D) | — | — |
  | `ai_tool_calls`, `ai_usage_events` | `user_id = me` | insert by the scoped user | — | admin usage reports via worker role |

  **Cross-project denial** is the default: no matching membership row, no row.
- **Helper function.** `app_is_member(project_id, min_role)` is `SECURITY DEFINER`, `STABLE`, with a fixed `search_path`, reading `project_members`. This avoids policy recursion on `project_members`.
- **Triggers.** Existing triggers stay: P1-C guards and graph immutability. `p1c_result_insert_guard` reads `stat_runs`; under `academic_app` the run is visible to its owner, which is covered by a test. No new trigger is added to P1-C tables, so the `pg_trigger_depth()` cascade assumption is unchanged.
- **Enforcement boundary (honest).**
  - Enforced for every query issued inside `withRlsScope`: run APIs, the executor, read-only tool adapters, and approvals.
  - Graph and stats *write* services keep using the global connection with their own transactions, so their writes remain application-authorised. Threading `tx` through `graph/service.ts` is a larger refactor, deferred.
  - The legacy app (chat, tasks, sections) is unchanged and still connects as owner.
  - Moving the whole application to `academic_app` is a later phase (§24).
- **Deadlock guard (`max:1` on serverless).** Inside `withRlsScope`, a helper refuses use of the global `db` (dev and test assertion), so no code waits on the single connection it already holds.
- **Tests** connect as the superuser and `SET ROLE academic_app` to prove policies deny cross-project reads and writes, and allow member reads and EDITOR writes.

## 22. Testing strategy

| Suite | Scope |
|---|---|
| `scripts/runs.ts` (`test:runs`, no DB, CI checks job) | Registry (unique names, schemas, mutating → keyed, frozen), schema bounds, policy rules (each rule allow/deny), approval hash (changes with input, target version or impact; single use), state machine (every legal and illegal transition), limits and stop reasons, idempotency key derivation, planner output validation (unknown tool, oversize, cycles, too many steps). |
| `scripts/runs-integration.ts` (`test:runs:db`, CI database job) | Full flow with a scripted gateway provider: intent → plan → policy → approval → execute → stats run (P1-C) → graph provenance (`created_by_step_id`, `origin: 'agent'`) → events. **Security:** forged tool name, forged project id and forged resource ids (another project's dataset version, spec or node), VIEWER trying to run, forged, expired, reused or mismatched approval, direct executor bypass (step not AUTHORIZED), recursion (a tool cannot start a run). **Failure:** worker crash mid-step (reclaim, no duplicate `stat_runs` / versions / claims), job retry, lease expiry, cancel races (cancel during planning, approval wait and running), provider failure, tool timeout, partial result, limit reached (stops with a reason). DB trigger refusals for illegal transitions and edits. |
| `scripts/rls-integration.ts` (`test:rls`) | Under `SET ROLE academic_app`: member vs non-member vs VIEWER vs EDITOR, per protected table; worker role; cross-project denial; P1-C insert guard under RLS. |
| Always-on task fixes (if approved) | Added to `scripts/integration.ts`: ownership check on `projectId` / `conversationId`, monotonic cancel, no re-execution on reclaim (attempts counted), PLS model requires confirmation, retry from FAILED. |
| `e2e/runs.spec.ts` | `FF_RUNS` off: routes 404, page absent, chat and task flows unchanged. On: create a run, see steps, approve a step, see the result and provenance, cancel. |
| Smoke gates | One registry; no `defineTool` outside it; no adapter reaches the engine's numerics or a provider directly; every `/api/v1/**/runs` route uses `flagged('runs')`, `withApi`, the per-user limit and the body cap. |
| Regression | All existing suites unchanged and green: typecheck, lint, audit (production dependencies), smoke, analysis, knowledge, gateway (unit and DB), stats (engine and DB), integration, jobs, graph, build, e2e with flags off and on. |

## 23. Feature-flag strategy

- **`FF_RUNS`** (new, default off; requires `FF_GRAPH`, and refuses to start in `JOB_RUNNER=direct`, since a run engine without leases or a reaper would reintroduce R-5).
- **Flag off:**
  - every new route returns 404 and the Runs page is absent;
  - the stats assistant keeps its current behaviour, but routed through the registry and policy, since those are internal;
  - chat, tasks and all legacy routes are byte-for-byte unchanged.
- **Always-on** (if approved): the task-path correctness and security fixes (§13), and the migrations (additive; RLS roles and policies exist but only bind the P1-D scoped paths).
- **Flag on:** runs API, Runs UI, worker queue `research-run`, approvals.
- Both states run in CI e2e, as with `FF_GRAPH`.

## 24. Explicitly deferred (not in P1-D)

- **Chat and tasks.** Routing chat's agent path through research runs, and retiring the task planner/executor. This needs a migration path for existing task turns; a later phase, once runs are proven.
- **Legacy code.** Removing legacy `POST /api/agent` / `src/agents/orchestrator.ts` / `agent_tasks`, and the duplicate deep-research job path.
- **Registries and entitlements.** Merging capability registry A, intent registry C and the `TOOLS` of D into the run registry; unifying tier derivation and model entitlement; enforcing `maxExports` / `maxAiTasks`.
- **Tools not exposed:** PLS / CB-SEM, deep research, section writes, exports, deletes. PLS/CB-SEM need bounded models and job execution first; section writes need the F-19 membership fix and server-owned `origin` / `status`.
- **RLS scope.** RLS for the whole application (switching the connection role); threading `tx` through the graph and stats write services; RLS on legacy tables (sections, conversations, tasks).
- **Runs.** Sub-runs or delegation, parallel step execution (P1-D executes ready steps sequentially), outbox-based SSE with resume, and external side-effect tools (publishing, email).
- **Limits and audit.** Money budgets beyond a per-run and per-day ceiling per tier; per-user rate limits on legacy routes; a durable audit log for admin and billing actions.
- **Later phases.** P1-E and everything after.

---

### Hard limits (server-enforced; values proposed, configurable per tier)

| Limit | Free | Paid | Admin |
|---|---|---|---|
| Steps per run | 10 | 20 | 30 |
| Tool calls per step | 1 | 1 | 1 |
| Model-requested tool calls per assistant round | 3 | 5 | 8 |
| Replans per run | 1 | 1 | 2 |
| Nested depth | 0 (a tool can never start a run) | 0 | 0 |
| Retries per step | ≤ 2 (0 for destructive) | ≤ 2 | ≤ 3 |
| Wall time per run | 10 min | 30 min | 60 min |
| Model tokens per run (metered) | 60k | 400k | 1M |
| Estimated cost per run / per day | $0.20 / $1 | $2 / $20 | $10 / $100 |
| Active runs per user | 1 | 3 | 5 |
| Step input / output stored | 16 KB / 64 KB | same | same |
| Plan size | 64 KB | same | same |

When a limit is reached, the run stops, the current step is not started, and `stop_reason` and a `run_events` row say which limit was reached. The run never continues silently.
