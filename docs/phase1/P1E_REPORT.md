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

## Remaining decisions (later PRs)

- **Graph context (PR #3).** Which graph reads build the snapshot's graph section and the focus-graph slice, behind both flags.
- **Exact token counters.** Whether and when to register an exact offline counter per provider (bundle size, licence).
- **Summary refresh.** Cadence, model, and metering through the gateway with an idempotency key per version.
- **Memory API, UI and proposal flow.** Routes and limits, the "What Academic AI remembers" page, and when an agent may propose.
