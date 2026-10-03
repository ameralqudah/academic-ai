# P1-E — Context and memory

**Scope (PHASE1_PLAN.md):** Context Assembler v2 (turn order fixed, Project State Snapshot, graph slice, real token counting), thread summaries, user and project memories with UI. **Readiness audit:** GO (2026-10-02). **Base:** `main` at `9c9e1aa`.

## Approved decisions

- **Flag.** `FF_CONTEXT_V2`, default `false`, not enabled in production. Graph-based context (the snapshot's graph section, the focus-graph slice) requires both `FF_CONTEXT_V2=true` and `FF_GRAPH=true` (`graphContextEnabled()`). `FF_RUNS` and `FF_GRAPH` stay `false`.
- **Migration.** Approved for `memories` and `thread_summaries`, with per-user and per-project RLS on the run-table security model, database tests, and a fail-closed start when RLS cannot be enforced.
- **Sequence.** PR #1 is schema and security only; the assembler is not implemented in it. PR #2 starts only after PR #1 is reviewed and merged.
- **Context design requirements (for the assembler PRs).** Chronological turn order; the project summary snapshot always present when Context V2 is on; member-scoped project and graph data per the WS4 A2 decision (no creator-only legacy reads); `{{claim:id}}` rendered into readable claim text before context reaches a model; the graph slice behind `FF_GRAPH`.
- **Token counting.** Provider-aware and offline; no token-count API calls and no new metering. PR #1 defines the interface only; the implementation choice is made explicitly before the assembler PR.
- **Storage.** No storage code or production configuration is changed. The production storage provider currently fails every write with status 540, "Project paused" (seen in the Render logs of every deploy, most recently `9c9e1aa`). This is recorded as an **external operational blocker for a future `FF_RUNS` enablement only**; it does not block P1-E, which stores no files.

## PR #1 — schema and security

### Migration `0018_p1e_memory.sql`

| Table | Columns (main) | Constraints and guards |
|---|---|---|
| `memories` | `scope` (user / project), `user_id` (the subject, or the author of a project memory), `project_id` (exactly for project scope), `kind` (preference, fact, instruction, style, decision), `content`, `source` (user / agent), `status` (proposed / confirmed / archived), `pinned`, `origin` (ids only), `confirmed_at`, timestamps | CHECK constraints on every vocabulary, on scope ↔ project, and on content length (1–2000). Trigger `memories_guard`: an agent may only *propose*; scope, user, project, source and creation time are immutable, so a memory cannot be moved out of its project's policies; status moves proposed → confirmed/archived and confirmed ↔ archived; confirming stamps `confirmed_at`. Cascades with its user and its project. |
| `thread_summaries` | `conversation_id`, `user_id` (the conversation's owner), `version` (1, 2, …; unique per conversation), `summary`, `through_message_id`, `message_count`, `model` | CHECKs on version, summary length (1–20000) and count. Trigger `thread_summaries_guard`: never edited (a new version is a new row), and only for the conversation's owner, checked through `app_conversation_owner` even on the owner connection. Cascades with its conversation. |

No embedding column: retrieval is P1-G.

### Row-level security (same binding as 0015: `SET LOCAL ROLE academic_app` + transaction-local `app.user_id`)

| Policy | Rule |
|---|---|
| `memories_read` | a user memory: its user; a project memory: any member (`app_project_rank ≥ 1`) |
| `memories_create` | as oneself only; a user memory with no project; a project memory as an EDITOR (rank ≥ 3) |
| `memories_update`, `memories_delete` | a user memory: its user; a project memory: its author while still an EDITOR, or a project OWNER (rank 4), as for runs and approvals |
| `thread_summaries_read`, `_create`, `_delete` | the acting user is the row's user and owns the conversation (`app_conversation_owner`, SECURITY DEFINER, fixed `search_path`) |

Grants to `academic_app`: `memories` SELECT, INSERT, UPDATE, DELETE; `thread_summaries` SELECT, INSERT, DELETE (no UPDATE); EXECUTE on `app_conversation_owner`. If the role is missing, the grants are skipped with a warning and memory refuses to start.

### Code

- `server/memory/db-scope.ts`: `withMemoryScope` (restricted role, acting user) and `assertMemoryRlsEnforced`, which proves the role cannot bypass RLS, is not a superuser, and RLS is on for both tables. Otherwise it fails closed (`UNAVAILABLE`, `rls_unavailable`), never falling back to application checks; an unreachable database is retried and refused as `infra_unavailable`.
- `server/memory/repository.ts`: the storage layer only (create, list, update, delete a memory; append and read the latest summary), all inside the scope, with database refusals mapped to FORBIDDEN, NOT_FOUND or VALIDATION. No API, UI or model call.
- `server/context/flags.ts`: `contextV2Enabled()`, `graphContextEnabled()`.
- `server/context/token-count.ts`: the `TokenCounter` interface (offline, provider-aware, exact or estimate), `tokenCounterFor(provider)` and `registerTokenCounter`. Every provider uses the existing conservative estimate until an exact offline counter is chosen.
- `conversations.repository.ts`: the deprecated unscoped `listMessages` is removed; the smoke check now asserts it no longer exists.
- `FF_CONTEXT_V2` in `config/env.ts` and `.env.example` (`"false"`). CI runs the new suite (`test:memory:db`).

### Tests

`test:memory:db` (new): 53/0. It covers:

- **RLS and fail-closed start:** RLS is on and the seven policies and grants are as approved. Memory refuses to start, fail closed, when the role can bypass RLS, when RLS is off on a table, or when the role is missing; an unreachable database is refused after three probes.
- **User memories:** private to their user. Others cannot read, edit, delete or plant them.
- **Project memories:** every member reads them; viewers and non-members cannot create; only the author while an EDITOR, or a project OWNER, edits or deletes; a demoted author loses edit but keeps read.
- **Memory guards:** a memory cannot be moved to another project, re-scoped or re-owned. Agents only propose, and confirming stamps `confirmed_at`. Cascades work.
- **Thread summaries:** private to the conversation's owner. Never edited (no UPDATE grant, plus the guard on the owner connection), and never written for a non-owner. Versions are unique; cascades work.
- **Flags and token counter:** all four flag combinations; the counter interface.

### Regression (on this branch, base `9c9e1aa`)

All green: typecheck, lint, `git diff --check`, production audit (0 vulnerabilities), smoke, gateway 93, stats 361, runs 116, analysis 1329, knowledge, migrate and seed on a fresh database, integration 958, jobs 22, tasks 122, runs-db 221, graph 195, gateway-db 57, stats-db 172, memory-db 53, `drizzle-kit generate` (no schema changes), build, and end-to-end 71/71 with `FF_GRAPH`/`FF_RUNS` both off and both on.

### Mutation testing

Sixteen mutations of the migration and the scope code, each run against a freshly migrated database; all sixteen were killed by `test:memory:db`.

| # | Mutation | Result |
|---|---|---|
| S1 | `memories_read` open to every user | killed (3 failures) |
| S2 | `memories_create` without the own-user check | killed (3) |
| S3 | viewers may create project memories | killed (2) |
| S4 | any editor edits or deletes any project memory | killed (1) |
| S5 | delete open to everyone | killed (1) |
| S6 | summaries readable by everyone | killed (1) |
| S7 | summary ownership unchecked, in the policy and the guard | killed (3) |
| S8 | scope, user and project no longer immutable | killed (3) |
| S9 | agents may store confirmed memories | killed (1) |
| S10 | any status transition allowed | killed (1) |
| S11 | RLS not enabled on `memories` | killed: memory refuses to start (`rls_unavailable`), stopping the suite |
| S12 | UPDATE granted on `thread_summaries` | killed (2) |
| C1 | the scope keeps the owner connection | killed (4) |
| C2 | the scope names no user | killed: the first write is refused by the policy (`FORBIDDEN`, `memory_policy`), stopping the suite |
| C3 | the probe accepts a role that bypasses RLS | killed (2) |
| C4 | the probe accepts RLS off | killed (1) |

## Decisions for PR #2 (approved 2026-10-02)

PR #1 merged as `0d7225b`; migration 0018 applied on the Render deploy `dep-davtejjm8hqs73cfvp6g` (live); post-merge regression green. The six open questions were narrowed to the four PR #2 needs; summary refresh (5) and the memory API, UI and proposal flow (6) stay open for their own PRs.

1. **Token counting.** The `TokenCounter` interface from PR #1, with the existing conservative deterministic estimate (`estimateCounter`) for every provider. No external tokenizer packages yet; the interface stays provider-neutral, so an exact counter can be registered later without changing the assembler.
2. **Turn order.** Chronological. The assembler never reorders turns by relevance or authority; over budget it keeps the newest turns and drops the oldest.
3. **Project snapshot.** Always present with `FF_CONTEXT_V2=true`; member-scoped project data only; legacy creator-only records are no authorization shortcut. With `FF_GRAPH=false` it carries the non-graph summary only; graph-derived content needs both flags.
4. **Claim rendering.** `{{claim:id}}` resolved before assembly; readable claim text, or the visible marker `[unresolved claim]`; nothing reconstructed; no raw token reaches a model. **Revised in review:** resolution does not depend on `FF_GRAPH`. With `FF_CONTEXT_V2=true`, a referenced claim resolves whenever it belongs to the same project, is current and verified, and the caller is a member of that project; `FF_GRAPH` controls graph-derived context only (the snapshot's graph section, the focus-graph slice). With `FF_CONTEXT_V2=false`, v1 is unchanged.
5. **Scope.** Assembler core, chronological turns, snapshot, claim rendering, TokenCounter integration and `FF_CONTEXT_V2` gating only. No graph context, thread summaries, memories or UI.
6. **Flags.** `FF_CONTEXT_V2`, `FF_GRAPH` and `FF_RUNS` stay `false`; no production configuration change.

## PR #2 — Context Assembler V2 core

With `FF_CONTEXT_V2` off (the default) `buildContextPrompt` runs the v1 builder exactly as before. With it on, it runs `server/context/v2/assembler.ts`:

| Part | Behaviour |
|---|---|
| Turns (`v2/turns.ts`) | Conversation turns are taken out of relevance scoring and authority sorting and kept as one block, ordered by time with ties in the order given. They are fitted newest first until the next older turn does not fit, then stop (no gap), and rendered oldest first under one heading; the number of dropped turns is recorded and stated. The conversation may take `TURN_SHARE` (half) of the room left after pinned fragments; what it does not use goes to the other fragments. |
| Snapshot (`v2/snapshot.ts`) | Pinned, first, always present. Access is the project role (`requireProjectRole`, VIEWER and up, the rank the database policies use); the v1 creator-only project reader (`findOwned`) is replaced. Content: the project's fields, the caller's role, and the sections' keys and status (never their bodies). A non-member, or a project that does not exist, gets the same no-project snapshot. No graph content. |
| Membership gate for other sources | Only a project the caller is a member of reaches the other collectors. A legacy record (an artifact, say) a non-member filed under the project is therefore not shown with it; a member's own legacy records still appear, and another person's do not (legacy stays creator-only, WS4 A2). |
| Claims (`v2/claims.ts`) | Every `{{claim:id}}` in the snapshot, the fragments, the turns and the request is rendered before anything is measured: a claim that passes the export checks (`claimTraceability`: this project, current, verified) becomes its stored text, anything else `[unresolved claim]` (Arabic `[ادعاء غير محلول]`). Resolution needs `FF_CONTEXT_V2` and membership of the project, and is independent of `FF_GRAPH`: an explicitly referenced claim is a direct lookup, not graph-derived context. With no project, or one the caller is not a member of, every reference is the marker. The finished prompt is scrubbed once more for any claim-shaped token (spacing and case variants). |
| Budget | Every fragment and turn is measured by the `TokenCounter` (the caller's, or the provider's, defaulting to the estimate). |
| Model calls | The rendered request is returned with the prompt. The general answer uses it for the message (`contextRequest` from the chat route, or its own build), and with V2 on scrubs the system prompt, history and message of every general answer; the diagram extractor does the same. |

Files: `server/context/v2/{assembler,turns,snapshot,claims}.ts`, `server/context/budgets.ts` (the per-purpose budgets, shared), small changes to `manager.ts`, `sources.ts` (a collector can be replaced), `envelope.ts` (`turns`), `ai.service.ts`, `api/chat/route.ts`, `diagrams/extract.ts`. No migration, no new dependency.

### Tests

`test:context:db` (new, in CI): 63/0. It covers:

- **Turn order:** chronological whatever order turns arrive in; relevance scores (and a request matching only the newest turn) do not move them; ties keep their order; one block, not split by authority.
- **Budget:** over budget the oldest turns are dropped and the newest kept, in order, with no gap; the drop is recorded and stated; a budget too small for anything still carries the snapshot.
- **TokenCounter:** the same turns and budget fit all or none depending on the counter; the envelope's used tokens are the counter's.
- **Snapshot:** present, first and pinned, with or without a project; fields and section keys, never section bodies; a VIEWER member (not the creator) gets it; a non-member gets exactly what a missing project gets; a removed member loses it at once; the v1 creator-only project reader is not used.
- **Legacy records:** a non-member's own artifact filed under the project is not shown with it (v1 did show it); a member sees their own legacy records and not another person's.
- **Claims, across the flag matrix:** with `FF_CONTEXT_V2=true` and `FF_GRAPH` both off and on, a valid, current, verified claim of the project resolves to its text (for the owner and for a VIEWER member), while an unverified, another project's, a missing and a non-current claim each become the marker, with neither their text nor their ids shown; a non-member, or a request with no project, gets the marker; the snapshot carries no graph-derived content; with `FF_CONTEXT_V2=false` v1 is unchanged. Loosely spelled tokens are caught; Arabic marker; no raw token in the context or in what the scripted model receives (system, message, history and material), and the chat route hands on the rendered message.
- **V2 off:** the v1 envelope and prompt, unchanged (no snapshot, no turn block, claim references as before, the general answer's message as before).

### Regression (on this branch, base `0d7225b`)

All green: typecheck, lint, `git diff --check`, production audit (0 vulnerabilities), smoke, gateway 93, stats 361, runs 116, analysis 1329, knowledge, migrate and seed on a fresh database, integration 958, jobs 22, tasks 122, runs-db 221, graph 195, gateway-db 57, stats-db 172, memory-db 53, context-db 48, `drizzle-kit generate` (no schema changes), build, and end-to-end 71/71 with `FF_GRAPH`/`FF_RUNS` both off and both on, and once more with `FF_CONTEXT_V2`, `FF_GRAPH` and `FF_RUNS` all on in the local test environment.

### Mutation testing

Twenty-four mutations of the critical guards, each run against `test:context:db` (re-run after the claim-resolution revision). Twenty-two were killed; the two survivors are equivalent mutants, each stopped by a second layer that the suite then proves (R2b).

| # | Mutation | Result |
|---|---|---|
| T1 | turns sorted by relevance instead of time | killed (4 failures) |
| T2 | a turn that does not fit is skipped rather than stopping (a gap) | killed (4) |
| T3 | the oldest turns kept and the newest dropped | killed (8) |
| T4 | turns measured without the counter | killed (5) |
| A1 | turns mixed into relevance and authority sorting | killed (6) |
| A2 | fragments measured without the counter | killed (3) |
| A3 | the snapshot left out of the envelope | killed (the suite stops: no snapshot to read) |
| A4 | a non-member's project reaches the other collectors | killed (1) |
| A5 | the creator-only v1 project reader kept | killed (1) |
| A7 | the final claim scrub removed | killed (2) |
| A8 | rendering ignores the resolved claims | killed (5) |
| A9 | the request returned raw | killed (4) |
| S1 | snapshot access creator-only (`findOwned`) | killed (1) |
| S2 | any project id passes the membership check | killed (4) |
| G1 | V2 never used with the flag on | killed (2) |
| G2 | V2 used with the flag off | killed (3) |
| I1 | the general answer's scrub removed | killed (1) |
| I2 | the general answer ignores the rendered request | killed (1) |
| R1 | claim resolution gated on `FF_GRAPH` again | killed (3) |
| R2 | claims resolved for the named project with the assembler's membership check ignored | survived: equivalent — `claimTraceability` reads currency through `graph.assess`, which requires the VIEWER role, so a non-member still gets the marker |
| R2b | membership ignored in both layers (the assembler and `graph.assess`) | killed (2) |
| R3 | currency and verification ignored (both the context check and the trace's) | killed (6) |
| R4 | claims looked up across projects | killed (8) |
| R5 | claims resolved with no project | survived: equivalent — with no project id the claim lookup matches no node |

## PR #3 — Graph context

PR #2 merged as `2f9efdb` (Render deploy `dep-davugeoae00c73e1jh0g` live; no migration). PR #3 adds the graph-derived context, in `server/context/v2/graph-context.ts`, called by the assembler only when **`FF_CONTEXT_V2` and `FF_GRAPH` are both on** (`graphContextEnabled()`) **and** the caller is a member of the project (the snapshot's `projectId`). With either flag off, or for a non-member, nothing is read from the graph for context, except an explicitly referenced claim (PR #2's rule, independent of `FF_GRAPH`).

| Part | Design |
|---|---|
| Snapshot graph section (`graphSummary`) | Appended to the pinned snapshot: live node counts by type (superseded nodes not counted), the research questions and hypotheses by label (five each, then "+N more"), and the number of open review marks. Labels only, truncated at 120 characters; no payload (definitions, statements, claim text, values). |
| Focus-graph slice (`focusSlice`) | The one-step neighbourhood (both directions) of the focus nodes. Focus: the nodes a caller names (`focusNodeIds`) and the claims the request and the collected context reference; when none resolve, the research questions, hypotheses, constructs, variables and objectives whose labels share words (four letters or more) with the request. Bounded: at most `MAX_FOCUS` (4) focus nodes, `MAX_SLICE_NODES` (12) nodes and `MAX_SLICE_EDGES` (20) edges; superseded neighbours left out. Rendered as `- [type] label —rel→ [type] label` lines. An ordinary, unpinned `project-data` fragment, budgeted like any other, so turn order and the budget rules of PR #2 are unchanged. |
| Authorization | Every read goes through the graph service (`listNodes`, `listStale`, `trace`), which requires the VIEWER role and reads that project only: a second, independent layer behind the assembler's membership gate. A focus node of another project, or one that does not exist, is skipped and says nothing. No legacy creator-only record is read. |
| Claims | A claim node in the slice is written as its `{{claim:id}}` reference and then rendered by PR #2's claim pass: a current, verified claim of the project as its text, anything else `[unresolved claim]`; never raw, never reconstructed. |
| Failures | A failing graph read costs only its own part (logged); the snapshot and the rest of the context are built as usual. |

No migration, no new dependency, no change to storage or production configuration.

### Regression (on this branch, base `2f9efdb`)

All green: typecheck, lint, `git diff --check`, production audit (0 vulnerabilities), smoke, gateway 93, stats 361, runs 116, analysis 1329, knowledge, migrate and seed on a fresh database, integration 958, jobs 22, tasks 122, runs-db 221, graph 195, gateway-db 57, stats-db 172, memory-db 53, context-db 63, graphctx-db 31, `drizzle-kit generate` (no schema changes), build, and end-to-end 71/71 under four flag combinations (`FF_CONTEXT_V2`/`FF_GRAPH`/`FF_RUNS`): off/off/off, off/on/on, on/off/off, on/on/off.

### Tests

`test:graphctx:db` (new, in CI): 31/0. `test:context:db` stays 63/0; its snapshot check now expects the graph section exactly when `FF_GRAPH` is on.

- **Flag matrix:** both off, and `FF_GRAPH` alone, run v1 with no graph-derived data; Context V2 on with `FF_GRAPH` off has no graph section and no slice even with a focus node named, while an explicitly referenced claim still resolves; both on carries the section and the slice.
- **Snapshot section:** live counts by type (the superseded construct not counted); research questions and hypotheses by label; no payload of any node (definitions, statements, direction, claim text, values); nothing of another project; still the pinned snapshot.
- **Slice boundaries:** one step around a named focus node, nothing two steps away; superseded neighbours left out; lexical focus when none is named, no slice when nothing matches; at most 12 nodes out of 19 and at most 4 focus nodes.
- **Membership and isolation:** a VIEWER member gets both; a non-member gets neither and no graph label at all, even naming a focus node; a removed member loses graph context at once; a focus node of another project is skipped, and this project's nodes never appear in the other's context; a missing focus id yields no slice and no error.
- **Claims:** a current, verified claim in the slice shows as its text, an unverified one as the marker with its numbers never shown; no raw `{{claim:…}}` or claim id in the prompt; a claim referenced in the request is a focus node.
- **Unchanged budget rules:** turns stay one chronological block; the slice is unpinned, measured by the counter, and dropped before the snapshot when room runs out.

### Mutation testing (PR #3)

Thirteen mutations of the authorization, flag and boundary guards, each run against `test:graphctx:db`: eleven killed; the two survivors are equivalent mutants, each layer of authorization holding on its own (F2b, removing both, is killed). F12 first survived (the payload check covered only unlisted nodes); the check was extended and F12 is now killed.

| # | Mutation | Result |
|---|---|---|
| F1 | graph context without `FF_GRAPH` | killed (1) |
| F2 | the assembler's membership gate removed | survived: equivalent — the graph service still requires the VIEWER role |
| F2b | membership removed in both layers | killed (2) |
| F3 | the graph service's authorization removed | survived: equivalent — the assembler's membership gate still holds |
| F4 | the slice two steps deep | killed (1) |
| F5 | the slice's node cap removed | killed (1) |
| F6 | the focus cap removed | killed (1) |
| F7 | superseded neighbours kept in the slice | killed (1) |
| F8 | superseded nodes counted in the summary | killed (1) |
| F9 | a claim's stored text written into the slice | killed (1) |
| F10 | the slice pinned (never dropped by the budget) | killed (2) |
| F11 | an unmatched request still gets a slice | killed (1) |
| F12 | the summary copies payloads | killed (1, after the check was extended) |

## Accelerated plan (approved 2026-10-02)

After PR #62 (`2fb8a39`), the remaining P1-E work was audited and grouped into three PRs: **#4** thread summaries (R1, R2, R9), **#5** memories end to end (R3–R6), **#6** snapshot completeness, k=1 formalised, and closure (R7, R8, R14). Approved decisions: summaries are an internal gateway step (tokens charged, no request or words, the router's default model); own user memories are `user-instruction`, project memories `project-data`, proposed and archived memories never in context; agent proposals through the runs tool registry, proposed only; the slice stays k=1; the legacy `src/ai/context/*` builder (R10) moves to P1-F.

## PR #4 — Thread summaries

All behind `FF_CONTEXT_V2` (off: nothing is scheduled, generated or read, and the v1 prompt is byte-for-byte unchanged).

| Part | Design |
|---|---|
| When (`v2/summaries.ts`) | After a recorded turn (`chat.service.recordTurn`), a background refresh (`dispatchThreadSummary`, queue `thread-summary`, stately: one queued and one active per conversation, retried twice; in-process when the queue is unavailable). Due once `SUMMARY_EVERY` (10) messages beyond the last summary are older than the `KEEP_RECENT` (6) most recent; the most recent messages are never summarised. At most 60 new messages per refresh. |
| Metering | One gateway call, purpose `thread.summary`, routed by the router's default (capability `thread.summary`, no model requested). Internal step: `countsAsRequest: false`, `estimatedWords: 0`; tokens and cost on the usage ledger. The gateway reserves before any provider is contacted, so a refused reservation means no model call. |
| Idempotency | Key `thread-summary:{conversationId}:v{version}`. A concurrent second refresh shares the reservation and finds the version taken (unique (conversation, version) index → `duplicate`); a key already charged is refused before the model, so a version is never paid for twice. |
| Numeric integrity | The text is checked by the existing guard (`checkNumbers`, model mode) against the values the conversation's recorded analyses produced (`allowedFromLegacyResults`) and the numbers the user wrote (and the previous, already-guarded summary); untraced numbers are quarantined with the visible marker before storing. Claim references stay references; the context's claim pass renders them. |
| Ownership | Messages are read through the owner-scoped reader; the summary is written through the memory scope (RLS) and its guard trigger. |
| Failure | Quota, provider, a deleted conversation (refused by the guard trigger) or anything else: nothing is written, the outcome is logged, the context is built without it. |
| In the context (`v2/summary-context.ts`) | Loaded through the memory scope (fail-safe: refused or failing → no summary). Used when turns had to be dropped, or when it covers only history older than every loaded turn; left out when every turn is shown verbatim. Costed by the same counter out of the conversation's share; the turns are refitted to the rest; **a kept turn the summary covers is removed**, so no turn is both summarised and shown, and the turns shown stay the newest contiguous run. Rendered first in the conversation block (`model-generated`, not evidence). |
| R9 | `buildContextPrompt` accepts `tokenProvider`; the general answer passes its routed provider, the chat route the chosen one, the diagram extractor the preferred one. V2 measures with that provider's counter (today the estimate for all); v1 ignores it. |

No migration (the repository accepts an explicit version; a new owner-scoped `findMessageOwned`), no new dependency, no change to storage or production configuration.

### Tests

`test:summary:db` (new, in CI): 35/0. `test:context:db` 63/0, `test:graphctx:db` 31/0 and `test:memory:db` 53/0 unchanged.

- **Flag gating:** with `FF_CONTEXT_V2` off, a refresh is disabled (no model call, no row), a recorded turn schedules nothing, and the v1 prompt is byte-for-byte the same with a summary present and a provider passed.
- **Cadence:** not due below 10 older messages; due writes version 1 through the last message older than the 6 most recent; the model sees only those older messages; routed by the router (no model requested), purpose `thread.summary`.
- **Metering:** the reservation under `thread-summary:{conversation}:v1` is committed with no request and no words; the tokens are on the usage ledger.
- **No duplicates:** nothing new → not due, no call; a version already charged is refused before the model; two refreshes at once write one version; a slow refresh finishing after a faster one is refused, not stored as a second version.
- **Numeric guard:** numbers the analyses produced and the user stated are kept; untraced ones (an invented coefficient, a percentage) are quarantined with the marker, and the guard is recorded with the summary.
- **Ownership, quota, deletion:** another user's refresh is not found with no model call; a refused reservation means no call and no row; a conversation deleted mid-generation leaves nothing written and nothing crashed.
- **In the context:** used when turns are dropped, before the turns; no covered turn is shown; the turns stay chronological and newest; measured by the counter; left out when every turn fits; included when it covers only history older than the loaded turns; never for another user; claim references in it are rendered or marked, never raw; with RLS unavailable, no summary and the context still builds.
- **Hook and counter:** a recorded turn refreshes the summary in the background with the flag on; the routed provider's counter measures the budget.
- **Queue path (`JOB_RUNNER=inline`, as in production):** every queue in `QUEUES` is created before use; the workers start with the summary queue; a queued refresh is picked up by the worker and written once.

### Mutation testing (PR #4)

Nineteen mutations of the idempotency, duplicate, numeric, ownership, overlap, order, flag, metering, fail-safe and queue guards, each run against `test:summary:db`: eighteen killed; one equivalent survivor. D1 first survived (the simultaneous race computes the same version either way); a staggered test was added and D1 is now killed. Q3 is the defect found while preparing the regression: the summary queue was not created (pg-boss 12 needs `createQueue` first), so a queued refresh would fail to send and fall back to the in-process path, losing the queue's durability; the existing jobs suite passed regardless, so the summary suite now checks that every queue is created.

| # | Mutation | Result |
|---|---|---|
| I1 | idempotency key removed | killed (3) |
| D1 | the explicit version ignored | killed (1, after the staggered test) |
| D2 | a version conflict treated as written | killed (1) |
| N1 | numeric guard bypassed | killed (1) |
| N2 | every number allowed | killed (2) |
| O1 | unscoped message read, no owner check | killed (1) |
| O2 | summary read on the owner connection (RLS bypassed) | killed (2) |
| V1 | covered turns still shown (overlap) | killed (1) |
| V2 | summary shown although every turn fits | killed (1) |
| C1 | kept turns reordered | killed (2) |
| C2 | summary rendered after the turns | killed (1) |
| C3 | recent messages summarised | killed (6) |
| F1 | generation ignores `FF_CONTEXT_V2` | killed (10) |
| F2 | the turn hook ignores `FF_CONTEXT_V2` | survived: equivalent — the generation gate (F1, killed) still returns `disabled`, so nothing is called or written |
| Q1 | metered as a request | killed (1) |
| Q2 | metered with words | killed (1) |
| S1 | an RLS failure breaks the context build | killed (suite stops) |
| T1 | the routed provider ignored by the counter | killed (1) |
| Q3 | the summary queue not created | killed (1) |

### Known limitation

If a process stops after the gateway has committed a summary's charge but before the row is written, that version's key is committed and is refused from then on (never charged twice), so the conversation's summary stays at the previous version. Recovering would need a key that also names the summary's last message; not done, to keep the approved key format.

## PR #5 — Memories end to end (R3–R6)

All behind `FF_CONTEXT_V2`. With it off, the memory API answers 404 before the session is checked, the memories page is a 404, settings shows no panel, and no memory reaches the v1 context. No migration (0018's tables, policies and guard trigger are enough), no new dependency, and no change to storage or production configuration.

### API (R3)

| Method and path | Does |
|---|---|
| `GET /api/v1/me/memories?status=` | your own memories (proposed, confirmed, archived; optional filter) |
| `POST /api/v1/me/memories` | add one: `{kind, content, pinned?}`; always `source: user`, `confirmed` (201) |
| `PATCH /api/v1/me/memories/:id` | edit `content`, `kind`, `pinned` (never status, scope, owner or project) |
| `DELETE /api/v1/me/memories/:id` | delete |
| `POST /api/v1/me/memories/:id/confirm` | confirm a proposal, or restore an archived memory |
| `POST /api/v1/me/memories/:id/archive` | archive |
| `… /api/v1/projects/:projectId/memories…` | the same six operations for a project's memories |

Every handler: the flag gate (`memoriesFlagged`), then `withApi` with an address limit and a per-user limit (reads 300/min, writes 60/min), a strict zod schema and an 8 KiB body cap where there is a body. Errors use the existing codes: NOT_FOUND (stranger, removed member, missing project, a memory addressed through the wrong path), FORBIDDEN (`memory_policy` when the role may not change it), VALIDATION (422), UNAVAILABLE (`rls_unavailable` / `infra_unavailable`), RATE_LIMITED (429).

**Defence in depth.** (1) The route: flag, session, limits, schema. (2) The service (`memory/service.ts`): the project role from `requireProjectRole` (the same rank the database uses), and the memory must belong to the path it is addressed through. (3) The database: every statement through `withMemoryScope` (`SET LOCAL ROLE academic_app`, transaction-local `app.user_id`), so the 0018 policies decide again, and the scope fails closed when RLS cannot be enforced. There is no owner-connection path. The existing memory and thread-summary storage is unchanged.

### Authorization matrix

| Caller | List | Create | Edit / archive / confirm / delete own | … someone else's |
|---|---|---|---|---|
| user memories: the owner | yes | yes | yes | n/a |
| user memories: anyone else | sees none | (creates their own) | n/a | NOT_FOUND |
| project: OWNER | yes | yes | yes | yes |
| project: EDITOR | yes | yes | yes | FORBIDDEN `memory_policy` |
| project: COMMENTER / VIEWER | yes (read-only) | FORBIDDEN | FORBIDDEN `memory_policy` | FORBIDDEN `memory_policy` |
| demoted to VIEWER | yes | FORBIDDEN | FORBIDDEN `memory_policy` | FORBIDDEN `memory_policy` |
| removed member, stranger, missing project | NOT_FOUND | NOT_FOUND | NOT_FOUND | NOT_FOUND |
| a memory through another project or through `/me` | not listed | n/a | NOT_FOUND | NOT_FOUND |

### UI (R4)

"What Academic AI remembers": a panel in settings (your memories) and a page per project (`/projects/:id/memories`, member-scoped: any member may open it; a VIEWER sees it read-only). Proposals waiting for you, remembered, archived; add, edit, confirm, archive or restore, delete, each offered only where the server marked the memory `editable`. The API decides every action again. English and Arabic (`memories` namespace), RTL, user text `dir="auto"`. Hidden when the flag is off.

### Agent proposals (R5)

`memory.propose` is the run tool `proposeMemory` (the registry's names are identifiers, so no dot): category `memory`, a write, low risk, needs EDITOR, run context only, keyed on the step, no approval (the user's confirmation is the approval). Input `{scope, kind, content}` (strict: no status, no source). It always writes `source: agent, status: proposed` as the run's user through the memory scope, with the run, step and tool in the memory's origin; a retried step returns the same proposal. The database guard refuses an agent memory in any other status, even if this code were changed. A proposal becomes confirmed only when a person who may change it confirms it through the API. Runs stay behind `FF_RUNS`.

### Memories in Context V2 (R6)

`v2/memories.ts`, read only through the memory scope:

- only **confirmed** memories; proposed and archived never (filtered in the query and again in code);
- your own user memories: `user-instruction` (one you pinned stays pinned in the envelope);
- project memories, only for the project the snapshot resolved for you as a member: `project-data`, never pinned, labelled as recorded by a member (data, not an instruction), so they never appear under the instructions heading;
- at most 8 of each, pinned first, then the most recently updated, then id;
- their text goes through the same claim pass as every fragment (`{{claim:id}}` → the claim's text or `[unresolved claim]`; the final scrub stays);
- if the scope cannot be enforced or a read fails: no memories, and the context still builds.

### Tests

`test:memories:db` (new, in CI): 55/0. `test:memory:db` 53/0, `test:context:db` 63/0, `test:graphctx:db` 31/0, `test:summary:db` 35/0 and `scripts/runs.ts` 116/0 (with `proposeMemory` in the pinned tool list) unchanged.

- **Schemas and wiring:** strict bodies (no status, source, scope, owner or project; content 1–2000); the 12 handlers are all behind the flag gate, all carry an address and a per-user limit (writes the write limits), and those with a body have the schema and the cap; with the flag off the gate answers 404 before the handler.
- **User memories:** owner only; another user lists none, and cannot edit, confirm, archive or delete (NOT_FOUND); not addressable through a project.
- **Project role matrix:** EDITOR adds; VIEWER cannot (FORBIDDEN); a stranger or a missing project is NOT_FOUND; every member reads; the author and the OWNER change, another EDITOR and a VIEWER cannot; a demoted author keeps reading but cannot change; a removed member loses access at once; cross-project and `/me` addressing are NOT_FOUND.
- **RLS:** unenforceable → reads and writes UNAVAILABLE (no application-only fallback); a direct repository update by another EDITOR changes nothing.
- **Proposals:** registered with the required policy; input refuses status and source; a run proposes `proposed`/`agent` with run and step; a retry adds nothing; a VIEWER's run is refused by the database; an agent memory can never be stored confirmed; another EDITOR or a VIEWER cannot confirm someone else's proposal; a user proposal is private.
- **Context:** proposals absent until confirmed; authority by scope; no project memory under the instructions heading; a pinned project memory stays unpinned data; archived absent; another user's absent; a non-member gets none; no project → own only; cap and order deterministic; claim references in a memory rendered, never raw; RLS unavailable → none, context still builds; flag off → none in the v1 context.
- **Browser (`e2e/memories.spec.ts`):** flag off → API and page 404, no panel; flag on → 401 without a session, full HTTP lifecycle, 422 for bad bodies, a stranger reaches nothing (404), project memories on the project page, settings add/archive/restore persisted, Arabic RTL, the write limit returns 429.

### Mutation testing (PR #5)

Twenty-eight mutations, each run against `test:memories:db`: twenty-five killed. Three survive only because the database hides the rows (equivalent under RLS). To show each layer holds by itself, they were re-run on a scratch database with the `memories_read` policy opened to `USING (true)`. The unmutated suite still passed (55/0, the application layer alone), and all three were killed. R1 (the RLS role not taken) is killed on its own, so the database layer is checked by itself as well.

| # | Mutation | Result |
|---|---|---|
| A1 | a VIEWER may create project memories (service) | killed (1; the database still refused) |
| A2 | memory not checked against the path it is addressed through | killed (2) |
| A3 | service change check removed | killed (3; the database still refused) |
| A4 | any EDITOR may change another member's memory | killed (2) |
| A5 | a demoted author may still change their memory | killed (1) |
| A6 | confirm/archive skip the change check (proposal confirmation) | killed (2) |
| A7 | user list not filtered to the caller (service) | equivalent under RLS; killed (2) with the read policy opened |
| R1 | RLS role not taken (owner connection) | killed (2) |
| R2 | fail-closed RLS probe skipped | killed (2) |
| P1 | agent writes `confirmed` | killed (suite stops: the guard refuses, VALIDATION `memory_invalid`) |
| P2 | agent writes as `user`, `confirmed` (escalation) | killed (3) |
| P3 | tool needs only VIEWER | killed (1) |
| P4 | retry idempotency removed | killed (1) |
| X1 | context status filter removed | killed (2) |
| X2 | archived memories included | killed (1) |
| X3 | project memory becomes a user instruction | killed (3) |
| X4 | pinned project memory pinned | killed (1) |
| X5 | unchecked request project instead of the member-resolved one | equivalent under RLS; killed (1) with the read policy opened |
| X6 | other users' memories not filtered (context) | equivalent under RLS; killed (3) with the read policy opened |
| X7 | cap removed | killed (1) |
| X8 | oldest first | killed (1) |
| X9 | pinned not first | killed (1, after the order test was fixed; see below) |
| X10 | fail-safe removed | killed (1) |
| K1 | memories skip the claim resolution pass | killed (1) |
| F1 | flag gate removed | killed (1) |
| L1 | DELETE without rate limits | killed (1) |
| L2 | create uses the higher read limits | killed (1) |
| V1 | create schema not strict | killed (1) |

**Test fixed (found by X9).** The order test set `updated_at` by hand and then pinned the oldest memory, but 0018's trigger stamps `updated_at` on every update. Pinning therefore also made that memory the newest, so "pinned first" was never actually tested. The memory is now created pinned and first, so it is the oldest, and X9 is killed.

### Regression (on this branch, base `24d48af`)

Typecheck, lint, `git diff --check` (worktree and against base), production audit (0 vulnerabilities), smoke (after the fix below), gateway 93/0, stats 361/0, runs 116/0, analysis 1329, knowledge, migrate and seed, integration 958, jobs 22, tasks 122/0, runs-db 221/0, graph 195/0, gateway-db 57/0, stats-db 172/0, memory 53/0, context 63/0, graph context 31/0, summary 35/0, memories 55/0; `drizzle-kit generate`: no schema changes; production build. Browser tests over the four flag combinations (V2/GRAPH/RUNS): false/false/false 73 passed, 4 skipped; false/true/true 73 passed, 4 skipped; true/false/false 76 passed, 1 skipped; true/true/false 76 passed, 1 skipped (the skips are the flag-dependent tests of the other setting).

**Smoke inventory updated.** The smoke suite's check that every `/api/v1` handler is flagged and rate-limited knew only the graph, statistics and runs gates and limits, so it flagged the new routes. It now recognises `memoriesFlagged` and the memory limits, and also requires a per-user limit on every memory handler (removing the DELETE limits, L1, fails it).

### Known limitations

- The project page's link to its memories sits on the existing project page, which stays creator-only (unchanged legacy semantics). Other members reach `/projects/:id/memories` by its URL.
- Over HTTP, the browser suite covers owner and stranger. The VIEWER, EDITOR, demoted and removed rows of the matrix are covered at the service and RLS layers (`test:memories:db`), which the routes call directly.
- The capability is named `proposeMemory`, not `memory.propose`, because tool names may not contain dots.

## PR #6 — Snapshot completeness, slice depth, closure (R7, R8, R14)

PR #5 merged as `10501b9` (Render deploy `dep-db0csd8ae00c73eflcc0` live; no migration). PR #6 is the last P1-E implementation batch. No migration, no new dependency, no change to storage, `render.yaml`, environment or production configuration; `src/ai/context/*` is untouched.

### R7 — Snapshot completeness

| Part | Where | Design |
|---|---|---|
| Per-section integrity counts | `v2/snapshot.ts` (`FF_CONTEXT_V2`; no graph needed) | For each section, the counts the numeric guard **stored** with its latest saved version (`section_versions.integrity`, WS2 D2): `quarantined` (model text) and `manual`, shown as *untraced* (a person's research numbers that trace to no analysis). Rendered as `RESULTS (DRAFT; 2 quarantined numbers; 1 untraced number)`. Counts only, accepted only as non-negative integers: nothing is recomputed from the text, and no finding, number, source or section text is copied in. A version saved before the guard (no record) shows its status only. |
| Untested hypotheses | `v2/graph-context.ts` (`FF_CONTEXT_V2` + `FF_GRAPH`) | Live hypotheses that no live result decides through a `tests` link, by label (at most five listed, the rest counted, in creation order): `Untested hypotheses (2 of 3): H2 …; H3 …`. A result that was superseded no longer counts as a test; a superseded hypothesis is not counted. The `tests` links are read by a new member-scoped graph read, `graph.testedHypothesisIds` (VIEWER and up, this project only, ids only). |
| Latest analysis run | `v2/graph-context.ts` (`FF_CONTEXT_V2` + `FF_GRAPH`) | The most recently recorded live `analysis_run` node of the project's graph: its label, status, engine and date (`Latest analysis run: PLS run (succeeded; pls-sem; recorded 2026-09-20)`). Never its results, method, seed, engine version or hashes. Read from the graph only; the legacy, creator-only analysis-run and dataset tables are not read. |
| Active dataset | — | **Not added.** Datasets are legacy creator-only records (WS4 A2), so the member-scoped snapshot does not name one; the legacy authorization is unchanged. |

The snapshot's invariants are unchanged: always present with Context V2 on, first and pinned (never dropped by the budget), `project-data`, member-scoped (VIEWER and up; anyone else gets the no-project snapshot), no raw research values, no graph payloads.

### R8 — Slice depth: k=1

`SLICE_DEPTH = 1` (`v2/graph-context.ts`) is now the named, documented depth of the focus-graph slice; the two `trace` calls use it. The target architecture's k=2 (§F.4) is intentionally not used in P1-E; nodes further away stay reachable through the graph tools. The caps are unchanged: `MAX_FOCUS` 4, `MAX_SLICE_NODES` 12, `MAX_SLICE_EDGES` 20. Focus selection is unchanged.

### Tests

`test:snapshot:db` (new, in CI): 31/0. `test:graphctx:db` 31/0, `test:context:db` 63/0, `test:memories:db` 55/0, `test:summary:db` 35/0, `test:memory:db` 53/0 and the graph suite 195/0 unchanged.

- **Integrity counts:** the latest record's counts per section; an older record of the same section not used; a record with nothing untraced, or a version with none, shows the status only, even though the section text holds numbers (nothing recounted); no finding, number, source or text copied in; no `FF_GRAPH` needed; a VIEWER sees the same; a non-member gets the no-project snapshot.
- **Active dataset:** a creator's legacy dataset attached to the project is never named, with both flags on.
- **Untested hypotheses and latest run:** an untested hypothesis and one tested only by a superseded result are listed, a tested one is not; a superseded hypothesis is neither counted nor listed; the latest live run by recording time with label, status, engine and date; a newer superseded run and an older run are not shown; no result value, hash, seed, method, engine version or statement copied in; nothing of another project; the same lines for a VIEWER; none for a non-member, with `FF_GRAPH` off, or in v1; the new graph read is member-scoped and per project.
- **Snapshot invariants:** first, pinned and `project-data`, with its counts and graph lines, under a budget with no room, while the focus slice is dropped.
- **R8:** depth 1 and the caps 4/12/20; one-hop neighbours included; a second-hop node and a superseded neighbour excluded; a focus node of another project yields nothing; a non-member gets no slice; `FF_GRAPH` required; the slice is unpinned `project-data` (droppable).

### Mutation testing (PR #6)

Eighteen mutations, each run against `test:snapshot:db`: all eighteen killed.

| # | Mutation | Result |
|---|---|---|
| I1 | quarantined count omitted | killed (4) |
| I2 | untraced count omitted | killed (2) |
| I3 | the wrong stored field read as untraced | killed (3) |
| I4 | the record's findings copied into the snapshot | killed (4) |
| U1 | a non-member treated as a VIEWER (unauthorized snapshot) | killed (1) |
| U2 | the tested-hypotheses read without authorization | killed (1) |
| D1 | the active dataset included | killed (1) |
| F1 | graph lines without `FF_GRAPH` | killed (2) |
| F2 | the `FF_CONTEXT_V2` gate removed | killed (1) |
| K1 | slice depth k=2 | killed (2) |
| K2 | slice node cap raised | killed (1) |
| S1 | superseded nodes in the graph section | killed (5) |
| S2 | a superseded result counts as testing a hypothesis | killed (2) |
| X1 | tested hypotheses read across projects | killed (1) |
| P1 | the snapshot unpinned (droppable) | killed (1) |
| R1 | the run's payload copied in | killed (2) |
| R2 | the oldest run shown as the latest | killed (3) |
| H1 | tested hypotheses listed as untested | killed (2) |

**Fixed while testing:** the untested list first followed the graph's last-updated order, which changes whenever a node is edited; it is now in creation order, so the snapshot reads the same every time.

### Regression (on this branch, base `10501b9`)

PR6_REGRESSION_PLACEHOLDER

### Known limitations

- The integrity counts are those stored with each section's **latest saved version**. If a section's text is changed without a new version being saved, the counts describe the last saved version.
- The graph section reads at most 1000 nodes (the existing `listNodes` bound); in a larger graph the untested list and the latest run are taken from those.

## P1-E closure

### Pull requests

| PR | Batch | Merged | Render deploy | Migration |
|---|---|---|---|---|
| [#60](https://github.com/ameralqudah/academic-ai/pull/60) | PR #1 — schema and security (`memories`, `thread_summaries`, RLS, fail-closed scope) | `0d7225b` | `dep-davtejjm8hqs73cfvp6g` (live at the time) | `0018_p1e_memory.sql` |
| [#61](https://github.com/ameralqudah/academic-ai/pull/61) | PR #2 — Context Assembler V2 core (chronological turns, snapshot, claim rendering, token counting, flag) | `2f9efdb` | `dep-davugeoae00c73e1jh0g` | none |
| [#62](https://github.com/ameralqudah/academic-ai/pull/62) | PR #3 — graph context (snapshot graph section, focus-graph slice) | `2fb8a39` | `dep-db00bmlg1s2s738888lg` | none |
| [#63](https://github.com/ameralqudah/academic-ai/pull/63) | PR #4 — thread summaries, routed token counter (R1, R2, R9) | `24d48af` | `dep-db0b930ae00c73eecdug` | none |
| [#64](https://github.com/ameralqudah/academic-ai/pull/64) | PR #5 — memories end to end (R3–R6) | `10501b9` | `dep-db0csd8ae00c73eflcc0` (live) | none |
| PR #6 (this PR) | snapshot completeness, k=1, closure (R7, R8, R14) | not merged | — | none |

Each merged PR passed CI on its head, a full local regression (all suites, the production build, and the browser tests under the four flag combinations), and a post-merge regression on `main` with a Render check (deploy live, migrations applied, no new errors besides the known S3 status 540).

### Status by item

| Item | Status | Where |
|---|---|---|
| Context V2 behind `FF_CONTEXT_V2` (v1 unchanged when off) | implemented, verified | PR #2 |
| Chronological turns; newest kept; dropped turns noted | implemented, verified | PR #2 |
| Project snapshot, always present, member-scoped | implemented, verified | PR #2, PR #6 (R7) |
| Claim rendering (`{{claim:id}}` → text or `[unresolved claim]`) | implemented, verified | PR #2 |
| Graph context (snapshot graph section, focus slice; both flags) | implemented, verified | PR #3, PR #6 (R7, R8) |
| Thread summaries (R1, R2) and routed token counter (R9) | implemented, verified | PR #4 |
| Memory API (R3), UI (R4), agent proposals (R5), memories in context (R6) | implemented, verified | PR #5 |
| Snapshot completeness (R7) | implemented, verified (active dataset intentionally excluded) | PR #6 |
| Slice depth (R8) | k=1 intentionally retained, verified | PR #6 |
| R10 — retire the legacy `src/ai/context/*` builder | **deferred to P1-F** (not modified) | — |
| R11 — thread focus node and `/projects/:p/state` | **deferred** to later workspace work (P1-I or later) | — |
| R12 — Project Brief | **deferred** | — |
| R13 — account deletion | closed (memories and summaries cascade with the user) | audit |
| Active dataset in the snapshot | **intentionally excluded** (legacy datasets are creator-only, WS4 A2) | PR #6 |
| k=2 slice | **intentionally excluded** for P1-E | PR #6 |
| Exact per-provider token counters | deferred (the estimate is used for every provider) | PR #2 decision |
| Production enablement of `FF_CONTEXT_V2`, `FF_GRAPH`, `FF_RUNS` | **not done**; all three remain off in production | — |

### Readiness checklist

"Verified" means covered by the named suites in CI and in the local and post-merge regressions; nothing here was run against production data.

| Area | State |
|---|---|
| Flag gating | `FF_CONTEXT_V2` off → v1 byte-for-byte unchanged (context, summary and memory suites); memory API and pages 404 when off; graph-derived context needs `FF_GRAPH` too. Verified. |
| Chronological turns | Turns in the order said; over budget the newest are kept and the oldest dropped, with a note of how many. Verified (`test:context:db`). |
| Dropped turns and summaries | A summary is used only when turns were dropped (or it covers only older history); no turn is both summarised and shown. Verified (`test:summary:db`). |
| Thread summaries | Background refresh behind the flag; never summarises the most recent turns; numeric guard applied before storing. Verified. |
| Memory authority | Own memories `user-instruction`; project memories `project-data`, never pinned, never under the instructions heading. Verified (`test:memories:db`). |
| Proposal and confirmation safety | Agents propose only (`proposed`, guarded in the database too); only a person who may change the memory confirms it. Verified. |
| Project snapshot | Always present, first and pinned; member-scoped; integrity counts from stored records; no active dataset; no raw values or payloads. Verified (`test:context:db`, `test:snapshot:db`). |
| Graph context | Both flags, members only, one hop, caps 4/12/20, superseded and cross-project nodes excluded, droppable. Verified (`test:graphctx:db`, `test:snapshot:db`). |
| Claim rendering | Text of a current, verified claim of the project, else `[unresolved claim]`; no raw token reaches a model; independent of `FF_GRAPH`. Verified. |
| Numeric integrity | Snapshot carries stored counts only; summaries go through the numeric guard; claims in memories and summaries go through the claim pass. Verified. |
| Provenance | Proposals keep run, step and tool in their origin; summaries record their guard result; graph context reads labels and a few run fields only. Verified. |
| Project and member authorization | `requireProjectRole` (database rank) everywhere in Context V2 and the memory service; strangers, removed members and missing projects get nothing (NOT_FOUND). Verified. |
| RLS | `memories` and `thread_summaries` under `academic_app` with per-user and per-project policies; the scope fails closed when RLS cannot be enforced; context omits memories and summaries then. Verified (`test:memory:db`, `test:memories:db`, `test:summary:db`). |
| Token budgeting | One counter per build (the routed provider's; today the estimate for all); the snapshot never dropped; other fragments fitted by authority and relevance. Verified. Exact counters deferred. |
| Metering | Context assembly makes no model call. A summary is one gateway call (`thread.summary`) charged in tokens, no request, no words; a refused reservation means no call. Verified. |
| Idempotency | Summary key `thread-summary:{conversation}:v{version}`, one version per key; proposals keyed on the run step. Verified. |
| Failure and cancellation | A failing graph, memory or summary read costs only its own part and the context still builds; a failed or refused summary writes nothing; a retried run step proposes nothing new. Verified. A summary charged but not written blocks that version (PR #4 known limitation). |
| Browser matrix | Four combinations (V2/GRAPH/RUNS): false/false/false, false/true/true, true/false/false, true/true/false, on every P1-E PR and post-merge. Verified. |
| Migrations and schema | One migration in P1-E (`0018`, PR #1); `drizzle-kit generate` reports no drift. Verified. |
| Production flags | `FF_CONTEXT_V2`, `FF_GRAPH`, `FF_RUNS` remain off (not set in `render.yaml`; default false). Render's dashboard environment is not readable with the tools used here. |
| Render | Every P1-E merge deployed and went live; migration 0018 applied. The production storage provider still fails writes with status 540 ("Project paused") — an external blocker for a future `FF_RUNS` enablement; not touched by P1-E. |

**Ready for development use: yes.** With `FF_CONTEXT_V2` (and, for graph context, `FF_GRAPH`) turned on in a development or staging environment, every P1-E behaviour above is implemented and verified by CI and the regressions.

**Ready for production flag enablement: not yet.** Before `FF_CONTEXT_V2` is turned on in production:

1. verify on a staging deployment with production-like configuration: the `academic_app` role exists and the memory scope's RLS probe passes there (otherwise memories and summaries fail closed);
2. confirm summary metering against a real provider (charge, no request, no words) and the gateway's routed default model for `thread.summary`;
3. confirm the background queue (`thread-summary`) runs on the deployed worker;
4. decide whether graph context ships too: that needs `FF_GRAPH` in production, which is a separate decision;
5. `FF_RUNS` (agent proposals run only inside research runs) stays blocked by the storage status 540 until that is resolved.

### Known limitations (P1-E as a whole)

- Token counts are the conservative estimate for every provider; exact counters are deferred.
- Focus selection is lexical (shared words), and only the assembler's `focusNodeIds` input names focus nodes; there is no API or UI for it.
- The slice is one hop; deeper context stays behind the graph tools.
- A summary charged but not written blocks that version (PR #4).
- The project page's link to its memories is on the creator-only project page; other members open `/projects/:id/memories` by URL (PR #5).
- The integrity counts describe each section's latest saved version (PR #6).
- The legacy context builder (`src/ai/context/*`) still serves the legacy paths (R10, P1-F).

## Remaining decisions (after P1-E)

- **Graph context, later.** A relevance-ranked (rather than lexical) focus choice, and an API or UI for a caller to name focus nodes; today only the assembler's `focusNodeIds` input does.
- **Exact token counters.** Whether and when to register an exact offline counter per provider (bundle size, licence).
