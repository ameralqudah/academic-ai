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

Merged via #57.

## PR #3 — execution safety (G3, G4, G7)

No migration: the attempt count lives in the task's existing `context` column. No configuration change; `FF_RUNS` and `FF_GRAPH` stay off.

| Finding | Change |
|---|---|
| **G3** — cancelling stopped the executor's wait but not the work: long-form writing ran its remaining rounds (each one metered), and deep research ran its model call in flight (cancel was checked only between stages) | A real abort signal reaches the call itself. `generateLongForm` takes `signal`: it is passed to every round, checked before each, and an abort throws `LongFormCancelled` (no partial text offered as a result). The writing and literature-review handlers pass the step's signal. `runDeepResearch` takes `signal`, passes it through `runCompletion` to each stage's model call (plan, extract, gaps, synthesis), treats an aborted signal like `shouldStop`, and reports an aborted call as `ResearchCancelled`. The deep-research handler passes the step's signal. The research job polls for a cancel every 2 s and aborts its controller, so a cancel stops the call in flight. The stats explain route passes the request's own signal, so a client that goes away stops the call. |
| **G4** — a failed lease renewal only logged a warning, and the work ran on beside its new owner (duplicate execution) | `withLease` hands the work a signal that aborts with `LeaseLost` when a renewal finds another owner, or when renewals have failed so long that the next heartbeat would land after the lease expires. The result is then `lost`. The task executor stops the running steps at once (the step's controller aborts, like a cancel), applies none of their results, starts no further step, and writes nothing: no step state, no task status, no failure, no plan made after the loss. The step is left `RUNNING` for the next owner's `recoverStranded`, which counts the attempt. PLS bootstrap and deep-research jobs take the lease signal too and write no result or failure once it is lost. |
| **G7** — a task that kept crashing its worker (or losing its lease) was re-queued by the reaper forever, paying for planning and its first steps each time | Each execution opens in the task's `context` (`executionOpen`, `interruptedExecutions`, one atomic `jsonb` update that touches nothing else). An execution that reaches any end (completed, failed, paused or waiting for input) closes. One that never closed (a crash, a redeploy, a lost lease) is counted when the next one opens. At `MAX_INTERRUPTED_EXECUTIONS` (3) the task is failed with `task.error.interrupted` instead of being started again, before any planning or step. Planning loops are covered the same way. The reason has an English and an Arabic message. |

### Tests

- `test:tasks:db`: 104/0, of which 22 are new.
  - **G3:** long-form runs its rounds without a signal; sends nothing on an aborted signal; stops a round in flight at once with no round after it. Through a real task, a cancelled step's writing stops (the round in flight is aborted and no later round is sent) and the step is set aside. A cancelled research job stops its model call in flight (well before the scripted 6 s reply) and writes no failure; a research job with its lease lost sends nothing and writes nothing. The real handlers pass the step's signal to their long-running work.
  - **G4:** a lease that keeps renewing never aborts; a lease taken by another worker aborts the work with `LeaseLost` and returns `lost`. Through `executeTask`, the running step stops at once, the next step never starts, the task is neither failed nor finished, and the execution is left open; the next owner then recovers and completes the task, counting one interruption. A bootstrap job with its lease lost writes no result, while one whose lease holds completes.
  - **G7:** a clean run counts nothing and closes its execution; one interruption is counted and the task still runs; at the cap the task fails with `task.error.interrupted` and runs nothing; a planning loop is capped before any planning call; a task that waits for input counts nothing however often it resumes; the count sits beside the existing context.
- `test:stats:db`: 172/0, of which 3 are new (G3: an explanation whose client went away is stopped mid-call at once; one asked for after it went away is never sent; the route passes `request.signal`).

### Limitations and decisions

- **Planning is not interrupted mid-call.** The planner's own model call is bounded by the gateway timeout; after a lost lease its plan is discarded, not written.
- **Statistics jobs (`stats.run`) take no lease signal.** They are deterministic computation with their own run claim (`executeRun(..., { reclaim })`), which already refuses a second writer.
- **A renewal that fails for a database reason is tolerated** until the lease could have expired (about 90 s with the 120 s lease and 30 s heartbeat), then treated as lost.
- **The interruption count is cumulative** for the task's lifetime: a clean end closes the execution but does not reset the count.

Merged via #58.

## PR #4 — limits and hygiene (G5, rate limits, stream cap, `.env.example`)

No migration: G5 keeps its keys in the artifact's existing `metadata`. No production or configuration change; `FF_RUNS` and `FF_GRAPH` stay off; the storage implementation is untouched.

| Item | Change |
|---|---|
| **G5** — an artifact had no idempotency, so a double submit, a client retry or a re-run step stored the file twice | `storeArtifact` is idempotent. With an `idempotencyKey` (the artifacts route takes it from an `Idempotency-Key` header, the same format as the runs route), a replay returns the artifact the first request stored, at any time, even if the bytes were regenerated; the same key for a different file (kind, name, project, thread, job or replaced version) is refused with `CONFLICT`. Without a key, the same request with the same bytes within `REPEAT_WINDOW_MINUTES` (10) returns the artifact already stored instead of a duplicate, or instead of an extra version for a replacement. Lookup and store run under a per-user, per-key transaction lock, so identical requests racing each other store once; every query of a store uses the lock's own transaction (one connection per store, so waiting stores cannot exhaust the pool, which on serverless is a single connection). A deleted artifact is never handed back. |
| **Rate limits** — routes that named no limit had none, although the option's comment promised a fallback | `withApi` now applies the global limit (`RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_SECONDS`, 60 per 60 s by default) to every authenticated write (any method but GET, HEAD or OPTIONS) whose route names no limit of its own. It is counted per signed-in user, so many users behind one address are not one bucket. Of the 25 write handlers that had no limit, 24 now fall back to it, among them title selection, references, section edits and approval, recommendations, the billing portal, settings, project and conversation edits, and the deletes. The 25th, task actions (answer, resume, retry), starts model work again, so it gets an explicit limit like starting an agent turn (30 per 5 min). |
| **Stream cap** — the task stream had no limit, and each open stream re-reads the database every 1.5 s for up to 10 min | Opening a stream is limited per user (60 per 5 min), and what one user holds open at once is capped at `MAX_STREAMS_PER_USER` (5, per process); over either, the answer is 429 with `Retry-After`. A slot is freed when the stream ends, the client goes away, a write fails, or the runtime cancels it. The stream itself moved to `server/http/task-stream.ts` (the route keeps the sign-in check), so it is tested without a session. |
| **`.env.example`** | Added `FF_RUNS`, `RUN_LIMITS`, `SERPER_API_KEY`, `OPENALEX_API_KEY`, `STORAGE_PROVIDER`, `STORAGE_LOCAL_DIR` and the `S3_*` keys (documentation only, safe defaults), and corrected the description of the global limit. |

### Tests

- `test:tasks:db`: 122/0, of which 18 are new.
  - **G5:** an identical repeat returns the stored artifact (one row); five identical racing requests store once; different bytes, or another user's identical request, are separate artifacts; after the window the request stores again; a deleted artifact is never replayed; a key returns its first artifact even after a regeneration and a day later; the same key for a different file is refused; another user's identical key is their own; a replacement submitted twice adds one version.
  - **Stream cap:** a user holds the cap's worth of streams; one more is refused with 429 and `Retry-After`, without taking a slot; another user's streams count apart; a foreign task is refused before taking a slot; closing a stream frees its slot at once; opening is limited at 60 per five minutes even when each stream closes at once.
  - **Route checks:** task actions are limited; the artifacts route passes its key; the stream route hands over to the limited stream.
- `e2e/limits.spec.ts` (new, against the built server): a write route with no limit of its own is refused at the 61st write per user, with `Retry-After`, while 70 reads pass; an artifact request retried with the same `Idempotency-Key` returns the first artifact, the key reused for another file is refused with 409, and an identical keyless request moments later is the same artifact.
- `scripts/integration.ts`: its source checks on the task stream now read `server/http/task-stream.ts`.

### Limitations and decisions

- **The stream cap is per process**, like the memory rate-limit store: on several instances it bounds what one user can hold on any one instance, not across all of them.
- **Content-hash deduplication only catches byte-identical repeats.** Formats that embed a timestamp, or a step that regenerates its text, produce different bytes; for client retries the `Idempotency-Key` header is the reliable path.
- **The global write limit uses the memory store unless `RATE_LIMIT_STORE=redis`**, as every other limit does.

### WS4 status

With PRs #1–#4, every WS4 finding from the audit is addressed: A1, A3, A4 and A5; A2 decided (legacy records stay creator-only); G1–G8; rate limits; the stream cap; `.env.example`.
