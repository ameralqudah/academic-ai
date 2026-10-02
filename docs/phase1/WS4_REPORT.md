# WS4 — Authorization & Operations Hygiene

**Base:** `main` at `3605d13`. `FF_RUNS` and `FF_GRAPH` stay off. No migration, no production or configuration change, no change to storage.

The read-only WS4 audit re-verified findings A1–A5 and G1–G8 and recommended four PRs. This report records them as they land.

## Decision A2 (approved)

Legacy records — datasets, analysis runs, tasks and artifacts — **remain creator-only**. Their authorization semantics are not changed. P1-E (context and memory) reads member-scoped v1 and Research Graph data instead.

## PR #1 — authorization (A1, A3, A4, A5)

| Finding | Change |
|---|---|
| **A1** — a request's `projectId` / `conversationId` stored unchecked | The existing helpers (`assertProjectLink`: editor of the project; `assertConversationLink`: owner of the thread; both `NOT_FOUND` for unknown or foreign) now run at the five write paths, before any record or file is written: `chat.service.startConversation` (the conversations route and the agent's first turn), `orchestrator.runAgent` (before its `try`, so a refusal records no conversation, task or failure turn), `artifact.service.storeArtifact` (the artifacts route and every task handler), `deep-research.service.startDeepResearch` and `web-search.service.searchWeb`. |
| **A3** — legacy analyses did not compare the dataset's project with the request's | New `assertSameProject` (`ownership.ts`): a record filed under project X is not used or re-filed under project Y. Applied after the dataset load in `statistics.runAnalysis`, `data-analysis.analyseDataRequest`, `pls.runPls` and `pls.startBootstrap`, and to the run in `statistics.attachRun`. A record with no project, or a request naming none, behaves as before (A2: legacy stays creator-only; filing one's own unfiled data under a project one edits is what the editor check allows). |
| **A4** — graph helpers handed out a cached node before the project check | `ensureVersionNode` checks the project before returning the cached node; `ensureSpecNode` gains the project check it lacked. Every caller already checked first, so this is defence in depth. |
| **A5** — unscoped lookups exported with no callers | Removed `conversationsRepo.findById`, `conversationsRepo.listForProject` and `projectsRepo.findById`. One test that read a project through `findById` now uses `findOwned`. |

### Tests

- `scripts/tasks-hardening.ts` (`test:tasks:db`): new WS4 A1, A3 and A5 sections. Every path has negative checks (another user's project → `NOT_FOUND`, a project the caller only views → `FORBIDDEN`, another user's conversation → `NOT_FOUND`, a project-X record under project Y → `NOT_FOUND`), checks that a refusal wrote nothing (no conversation, agent task, artifact, analysis run or job), and positive controls (the caller's own project and thread pass; deep research and web search then stop only at the missing provider, `VALIDATION`).
- `scripts/stats-integration.ts` (`test:stats:db`): new WS4 A4 section (a cached version node and spec node are refused for another project, returned in their own, and nothing is created in the other project).
- **Mutation check:** each of the 18 guards was removed or weakened one at a time (both A1 checks on each path, each A3 call site, the helper itself, the order of the A4 version guard, the A4 spec guard, and putting back an A5 export). The relevant suite failed every time: 18 of 18 mutations were caught.

Merged via #56.

## PR #2 — metering and settlement (G1, G2, G6, G8)

No migration: every fix uses columns that already exist. The gateway's architecture and quota rules are unchanged (reserve → execute → commit or release; a per-user lock; internal steps reserve nothing but are refused on a used-up plan).

| Finding | Change |
|---|---|
| **G1** — task-step model calls metered without their step | Each step's handler runs inside `withCallIds({ stepId })` (`tasks/executor.ts`). The fix also exposed a larger gap: `runTask` re-entered `runForUser`, which starts a fresh scope, so the task and project ids that `executeTask` set around planning were dropped too, and every step call was recorded with no task, no project and no step. `runTask` now carries `{ taskId, projectId }` into that scope. `ai_usage_events.step_id` now names a research-run step (with `run_id`) or a task step (with `task_id`). |
| **G2** — a failed settlement was only logged, so the reservation was later released and the provider usage never billed | `settle` retries up to `SETTLE_ATTEMPTS` (3) times with a pause, never failing the delivered answer. If every try fails, the reservation stays `reserved`. At expiry the reaper's new `quota.settleExpired` (replacing `releaseExpired`) commits it from the call's durable `ai_usage_events` rows, which are written before settlement and name the reservation. It charges tokens, cost and project; a request when an attempt succeeded and the call counted as one; and words estimated from output tokens (`RECOVERED_WORDS_PER_TOKEN` = 0.75, since the text was never seen). A reservation that reached no usage is released, as before. `commit` stays idempotent under the user lock and now reports whether it wrote, so a second sweep or the call's own late commit never charges twice. |
| **G6** — embeddings bypassed the quota with a fake, already-committed reservation | `embed` takes a real reservation as an internal step (no request, no words) under its call id. It is refused before the provider on a used-up plan, committed with its tokens and cost on success, and released on failure or cancellation. |
| **G8** — a committed idempotency key let a new call run unbilled (its commit was a no-op) | `quota.reserve` refuses a key whose reservation is already `committed` with `invalid_request` (`detail: idempotency_key_committed`), before any provider is contacted. This keeps the existing rule that a retried step reserves and counts once: a `reserved` key (a retry of unfinished work) still shares its reservation, and a `released` key is reserved afresh. The existing test that encoded the old behaviour (two calls, one key, one charge) now asserts the refusal. |

### Tests

- `test:gateway` (unit, fakes): 93/0, of which 6 are new (G6 reservation, refusal and commit; G2 retry until success, give-up after three tries, single try when it works).
- `test:gateway:db`: 57/0, of which 20 are new, against real quota, ledger and usage rows. They cover G8 refusal, in-flight sharing and released-key reuse; G2 transient retry, persistent failure → reaper recovery (request, tokens, cost, estimated words), no double charge on a second sweep or a late commit, a consumed-but-failed call (tokens and cost only), and a call with no usage (released); and G6 commit, refusal on a used-up plan with no provider call, and release on failure.
- `test:tasks:db`: 82/0, of which 5 are new for G1, through the production `executeTask` path. Each step's call names its own step and the task; a call outside a step names none; a project task's step call names the project.

### Limitations and decisions

- **Recovered words are an estimate.** The reaper never sees the text, so `GENERATED_WORD` is estimated from output tokens; requests, tokens and cost are exact.
- **Concurrent use of one in-flight key still shares one charge.** Two calls racing on the same `reserved` key share a reservation, and only the first commit writes the ledger. Separating them would need a per-call settlement record (a migration); no caller passes its own key today (the gateway uses a fresh call id, or `callId:repair`).
- **No usage rows, no recovery.** If the database is down for the attempt rows as well as the commit, nothing durable describes the call; that case is released at expiry, as before.

### Left for later WS4 PRs

G3, G4, G5 and G7 (cancellation, leases, artifact idempotency, task attempt caps), rate limits on the routes that have none, the cap on concurrent task streams, and the missing `.env.example` entries.
