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

### Left for later WS4 PRs

G1–G8 (metering, settlement, cancellation, leases, idempotency, attempt caps), rate limits on the routes that have none, the cap on concurrent task streams, and the missing `.env.example` entries.
