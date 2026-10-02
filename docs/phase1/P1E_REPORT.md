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

## Remaining decisions before the Context V2 assembler (PR #2)

1. **Token counting implementation.** Choose an exact offline counter per provider (for example a bundled tokenizer for each model family), or keep the conservative estimate everywhere; record the bundle-size and licence impact.
2. **Snapshot sources.** Exactly which member-scoped v1 and Research Graph reads build the project summary snapshot, and what it shows when `FF_GRAPH` is off (project, stages, sections and integrity from v1 data only).
3. **Claim rendering.** Render `{{claim:id}}` with `renderClaimTokens` and the quarantine marker for unresolved references, before the envelope is built, so no raw token reaches a model.
4. **Turn order.** Keep conversation turns as one chronological block, outside relevance sorting, budgeted from the newest backwards.
5. **Summary refresh.** Cadence (every about 10 turns), which model, and metering through the gateway with an idempotency key per version.
6. **Memory API, UI and proposal flow.** Routes and limits, the "What Academic AI remembers" page, and when an agent may propose.
