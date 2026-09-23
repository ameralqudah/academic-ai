# Phase 1 plan — foundations for the Research Operating System

**Status:** started 2026-09-23, after P0 was merged ([#28](https://github.com/ameralqudah/academic-ai/pull/28)).
**Governing documents:** `docs/architecture/TARGET_ARCHITECTURE.md` (§N P1 and Part II R1–R10).

**Rules for Phase 1** (the same as P0):
- **Additive, non-destructive migrations**; legacy tables stay the source of truth until each area is switched over.
- **Feature flags**: every new user-visible path defaults to off (`FF_*` environment variables), so existing features keep working (R7).
- **One PR per step**, each green in CI before it is merged. Tests are added with every change.
- **Provider-neutral** (R9); **integrity-first** (R4).

## Steps, in order

| Step | Contents | Why this order | Exit criteria |
|---|---|---|---|
| **P1.0 Security hardening** | Audit findings left out of P0: SSRF (redirect re-validation, IPv6, DNS pinning at connect), upload hardening (decompression caps, magic bytes, body-size check before buffering), `/api/health` minimal in public, CSP without `unsafe-eval` in production, seed no longer overwriting admin plan edits | Security before new surface area | Tests for each; CI green |
| **P1-A Research Graph core** | `graph_nodes`, `node_versions`, `graph_edges`, `stale_marks`, `edge_rules`; `project_members` (owner backfilled); graph service (create, update with versions, link, **impact** dry-run and apply, trace); `/api/v1/projects/:p/…` graph routes behind `FF_GRAPH` | Everything else writes into the graph | Impact on construct, hypothesis, item, column, dataset, model, result, citation and section changes returns the right stale set (R6); cross-project isolation tests |
| **P1-B Model Gateway** | `ContentPart` messages (R3), capability declarations, native tool calling per provider, structured output, timeouts, per-call metering (`usage_events`), plan-aware failover, sanitised errors | The agent loop needs tool calling; fixes audit AI-layer items | Provider contract tests with recorded responses; every call metered |
| **P1-C Tool registry + policy engine** | `ToolDef` (zod → JSON Schema), registry, scopes, three autonomy modes (R2) with always-on hard rules, idempotency; first tools (`graph.*`, `retrieve`, `stats.run` on the TS core, `citation.format`) | Tools and permissions before the loop that calls them | Policy matrix tests for all 3 modes |
| **P1-D Run engine v2** | Agent loop as a step type of the durable executor, parked waits, approvals API, `run_events` outbox and SSE with resume, sub-runs (`delegate`), Quality agent read-only profile (R8) | Needs B + C | Supervisor completes a multi-tool goal; an approval survives a worker restart |
| **P1-E Context and memory** | Context Assembler v2 (turn order fixed, Project State Snapshot, graph slice, real token counting), thread summaries, user and project memories with UI | Needs A | Snapshot always present; memories editable |
| **P1-F Consolidation** | Retire `/api/agent`, `/api/ai/chat`, the legacy orchestrator, `chat-panel` and the dead chat modes; merge the job tables into runs | Only after D covers their use | No references left; e2e green |
| **P1-G Ingestion and retrieval** | Ingest worker (GROBID, PDF text, OCR ara+eng, DOCX/PPTX), assets and representations (R3), pgvector and hybrid search | Needs the P0 queue | Retrieval eval (Arabic and English) at or above target |
| **P1-H Citation engine** | Sources as CSL-JSON, BibTeX/RIS import, citeproc styles, verification pipeline (DOI, DataCite, retraction), migration of `references` | Needs A | CSL fixtures; retracted-paper fixture detected |
| **P1-I Workspace v1** | Project workspace shell, pipeline rail, agent panel, inspector, Impact Report dialog, inbox, "promote to project" | Needs A, D, E | IA reachable, RTL and mobile checks pass |
| **P1-J Evaluation engine skeleton** | `evals/` suites and runner, `eval_runs`/`eval_results`, fast tier in CI (R5) | Grows with each step | stats-parity and policy suites run in CI |

Each step gets its own section in `docs/phase1/PHASE1_REPORT.md` when it is merged.
