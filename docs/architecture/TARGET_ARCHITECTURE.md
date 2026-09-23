# Academic AI — Target Architecture: a traceable research agent platform

**Status:** core decisions approved 2026-09-23, with binding requirements R1–R10 in Part II. Implementation starts with P0 (`docs/p0/P0_PLAN.md`).
**Builds on:** `academic-ai-audit.md`, the audit of commit `7586bea`.
**Scope:**
- Target architecture (A–L).
- The 20 subsystem designs you asked for.
- A migration path that keeps every working feature running.

---

## 0. Guiding decisions

| # | Decision | Why |
|---|---|---|
| D1 | **The project is the unit of work, not the conversation.** Every artifact, number, citation and message belongs to a Research Project and hangs off its **Research Graph**. | You asked for this. It is also where general assistants are structurally weak: their state lives in chat transcripts. |
| D2 | **The LLM never produces a research number.** Numbers come from deterministic engines (the existing TypeScript core for classical tests; established R libraries for SEM, EFA and PROCESS). The LLM writes the analysis *specification* and the *prose*. The prose can cite a number only by reference to a stored value. | This is what makes numbers traceable and turns the value-integrity checks from heuristics into guarantees. |
| D3 | **One supervisor agent, a few specialists, many tools.** Specialists exist only where they need their own context, their own model or budget, or must be independent (the verifier). Everything else is a tool or a skill profile. | Unnecessary agents add latency, cost and failure modes without adding capability. See §D. |
| D4 | **Postgres is the system of record for the graph.** Typed node tables, a node registry and an edge table, traversed with recursive CTEs. pgvector handles semantic search. No separate graph database or vector database. | One transactional store, and it already runs on Neon. A research project's graph has thousands of nodes, not billions. |
| D5 | **Durable jobs on Postgres (pg-boss) with separate worker services.** Nothing long-running happens in a web request. | This fixes the audit's durability, duplication and event-loop findings without new infrastructure. |
| D6 | **Everything is versioned and nothing important is overwritten.** Graph nodes have immutable versions. Edges pin the version they depended on. Staleness spreads along the edges. | This powers impact analysis, reproducibility and integrity (for example, detecting hypotheses changed after results were seen). |
| D7 | **Strangler-fig migration.** The new `/api/v1` and graph run alongside the current system behind feature flags. Current tables are backfilled, not dropped, until each area has moved. | This keeps billing, auth, admin, wizard, chat, exports, PLS, diagrams and deep research working throughout. |
| D8 | **Provider-neutral model gateway, native tool calling.** The first adapter uses the provider's native tool-use API. Models are tiered (a strong model for planning, writing and verification; a fast one for extraction and classification). | This replaces JSON-in-prose planning. The multi-provider support in `src/ai` is kept. |

---

## A. Target architecture

### A.1 Layers

```
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ 1. EXPERIENCE      Next.js (App Router, RSC) — Project Workspace, Library, Inbox      │
 ├──────────────────────────────────────────────────────────────────────────────────────┤
 │ 2. API / BFF       /api/v1 route handlers: authN, project RBAC, zod, idempotency,     │
 │                    rate limits, quota reservation, SSE event gateway, presigned I/O   │
 ├──────────────────────────────────────────────────────────────────────────────────────┤
 │ 3. DOMAIN SERVICES Research Graph · Project State · Literature · Data · Analysis ·    │
 │  (TS, shared by    Manuscript · Citation · Integrity · Reproducibility · Memory ·     │
 │   web + workers)   Publication · Billing/Usage (existing) · Auth (existing)           │
 ├──────────────────────────────────────────────────────────────────────────────────────┤
 │ 4. AGENT RUNTIME   Run engine (durable DAG + agent loop) · Supervisor · Specialists · │
 │  (worker-agent)    Tool Registry · Policy/Approval engine · Context Assembler ·       │
 │                    Model Gateway (tool calling, structured output, metering, traces)  │
 ├──────────────────────────────────────────────────────────────────────────────────────┤
 │ 5. COMPUTE         worker-stats (R: lavaan/semTools/seminr/psych/boot + TS core) ·    │
 │  (isolated)        worker-ingest (GROBID, pdf text, OCR, embeddings) ·                │
 │                    worker-render (docx/pptx/xlsx, PDF via Chromium/Typst, LaTeX) ·    │
 │                    egress proxy (the only path to the internet for fetches)           │
 ├──────────────────────────────────────────────────────────────────────────────────────┤
 │ 6. DATA            PostgreSQL 16 + pgvector (Neon) · pg-boss queues · Object storage  │
 │                    (S3/R2) · Redis/Upstash (rate limits, optional pub/sub cache)      │
 ├──────────────────────────────────────────────────────────────────────────────────────┤
 │ 7. PLATFORM        Sentry · OpenTelemetry traces · LLM traces & cost · audit log ·    │
 │                    CI/CD · backups/PITR · secrets manager                             │
 └──────────────────────────────────────────────────────────────────────────────────────┘
```

### A.2 Deployment topology

**Recommendation: Render**, which you already use, plus Neon. Vercel stays optional for the web tier only.

| Unit | Runtime | Scale | Network |
|---|---|---|---|
| `web` | Next.js Node server | 2+ instances | Public |
| `worker-agent` | Node, same repository, `npm run worker:agent` | 1–N | Private; egress only through the model gateway and egress proxy |
| `worker-ingest` | Node + GROBID sidecar + Tesseract (ara+eng) | 1–N | Private; egress proxy only |
| `worker-render` | Node + headless Chromium/Typst | 1–N | **No internet access** |
| `worker-stats` | R 4.x (plumber) + Node job adapter; pinned image digest | 1–N | **No internet**; CPU/memory/time limits per job |
| `egress-proxy` | Small allow-listing forward proxy | 1 | The only path out to the internet for fetched URLs |
| Postgres | Neon (pgvector, PITR) | — | — |
| Object storage | S3/R2 | — | — |
| Redis | Upstash | — | — |

---

## B. Component diagram

```
                                   ┌────────────────────────── Browser ───────────────────────────┐
                                   │ Project Workspace  ─ Pipeline rail ─ Tabs ─ Agent panel      │
                                   │ React Query cache · typed SSE client (Last-Event-ID resume)  │
                                   └──────┬──────────────────────────▲────────────────────────────┘
                                          │ REST /api/v1             │ SSE /api/v1/runs/:id/events
┌─────────────────────────────────────────▼──────────────────────────┴───────────────────────────────┐
│ BFF (Next route handlers)                                                                          │
│ authN(session, DB-checked) → authZ(requireProjectRole) → zod → idempotency → quota.reserve()       │
│ ├─ Graph API (nodes/edges/versions/impact)      ├─ Run API (start/approve/cancel/events)           │
│ ├─ Upload API (presign → complete → ingest job) ├─ Export API (render/repro jobs)                  │
│ └─ Legacy routes (kept behind flags during migration)                                              │
└───────┬──────────────────────────────┬──────────────────────────────────────────┬──────────────────┘
        │ domain calls (same process)  │ enqueue (pg-boss, same TX as run row)    │ LISTEN run_events
┌───────▼──────────────────────────────▼───────────┐                   ┌──────────┴──────────┐
│ DOMAIN SERVICES (src/server/domain/*)            │                   │ Event outbox         │
│ graph · state · literature · data · analysis ·   │◄──── writes ──────│ run_events table +   │
│ manuscript · citation · integrity · repro ·      │                   │ NOTIFY → SSE gateway │
│ memory · publication · usage · auth · billing    │                   └─────────▲────────────┘
└───────┬──────────────────────────────────────────┘                             │ append events
        │                                                                        │
┌───────▼────────────────────────────────────────────────────────────────────────┴────────────────────┐
│ worker-agent: RUN ENGINE                                                                            │
│  lease(run) → load state → Context Assembler → Supervisor loop:                                     │
│     model.call(tools) → tool_use → Policy engine (allow | needs_approval | deny) → Tool executor     │
│     → tool_result (+ graph writes, provenance) → observe → … → Verifier gate → Final synthesis      │
│  Specialists = sub-runs (Literature | Analysis | Writing | Quality) with own budget/toolset         │
│  Model Gateway: adapters(anthropic|openai|google) · native tools · structured output · timeouts ·  │
│                 retries+failover(plan-aware) · token metering · prompt cache · traces               │
└───────┬───────────────────┬───────────────────────┬────────────────────┬───────────────────────────┘
        │ job: stats.run    │ job: ingest.*         │ job: render.*      │ HTTP via egress proxy
┌───────▼────────┐  ┌───────▼─────────────┐  ┌──────▼───────────┐  ┌─────▼──────────────────────────┐
│ worker-stats   │  │ worker-ingest       │  │ worker-render    │  │ External scholarly & web APIs  │
│ TS core engine │  │ MIME/magic check    │  │ doc model → docx │  │ OpenAlex · Crossref · DataCite │
│ R engine:      │  │ GROBID (TEI)        │  │ PDF (Arabic)     │  │ Semantic Scholar · PubMed ·    │
│ lavaan,seminr, │  │ pdf text / OCR      │  │ LaTeX · pptx ·   │  │ arXiv · Unpaywall · Retraction │
│ psych, boot    │  │ chunk → embed →     │  │ xlsx · CSL       │  │ data · Serper (web)            │
│ → ResultBundle │  │ pgvector + FTS      │  │ (citeproc-js)    │  └────────────────────────────────┘
└───────┬────────┘  └───────┬─────────────┘  └──────┬───────────┘
        └──────────── writes result nodes / chunks / artifacts ───────────► PostgreSQL + S3
```

### B.1 Key interaction sequences

**(1) A user edits a construct.**
1. `PATCH /api/v1/projects/:p/nodes/:constructId` with `If-Match: v3`.
2. The graph service writes construct v4 and runs `impact(constructId, v3→v4)`. This is a recursive CTE over dependency edges pinned to v3.
3. The dependents are marked `stale` with a reason:
   - hypotheses H2, H5;
   - questionnaire items Q7–Q12;
   - model M1 (a measurement block);
   - analysis run R9 and its result values;
   - manuscript blocks that use those values or define the construct;
   - citations attached to the old definition.
4. The response returns an ImpactReport grouped by type, with a severity per item.
5. The UI shows an impact panel. The user chooses "Ask agent to propose updates", which starts a Writing/Analysis run with human checkpoints.

**(2) An analysis flows into the manuscript.**
1. The Analysis agent calls `analysis.propose_spec` and gets a spec. The policy engine requires approval before inferential SEM runs.
2. The user approves. `stats.run` goes to the queue, then `worker-stats`, which returns a ResultBundle.
3. The engine writes: an `analysis_run` node, `result_value` nodes (every coefficient, CI, p, fit index), `result_table` and `figure` nodes, and edges `run —uses→ dataset_version@v2`, `run —tests→ H1..H5`.
4. The Writing agent drafts Results. It may emit numbers only as `{{value:<id>}}` tokens, and the output validator rejects free-typed statistics.
5. The manuscript block stores `valueRef` inline nodes with `reports→result_value` edges. The Verifier confirms that every statistic is traced.

**(3) A citation is used.**
1. The Writing agent calls `citation.insert(sourceId, claimText, locator)`.
2. The citation service creates a `citation` node with the edges `block —cites→ citation —of→ source`.
3. It enqueues `citation.verify`: resolve the DOI, check retraction status, then run a claim-support check against the source's chunks.
4. The status badge in the editor updates live over SSE.

---

## C. Database / data model

### C.1 Principles

- **Hybrid graph storage.**
  - `graph_nodes` is a registry: id, project, type, current version, status. It gives uniform traversal.
  - **Typed detail tables** hold the domain fields, keyed by `node_id`.
  - `graph_edges` holds the relationships.
  - `node_versions` holds immutable snapshots.
- **Project scoping everywhere.** Every row has `project_id`, which enables Row-Level Security as defence in depth (§I).
- **IDs:** UUIDv7, which sorts by time.
- **Every write records provenance:** `created_by_user_id` or `created_by_run_id`, plus `origin` (`user` | `agent` | `import` | `engine`).
- **Money and usage:** the existing `usage_tracking` table plus a granular `usage_events` table.

### C.2 Entity groups (★ = new, ◆ = migrated or extended, ● = kept as is)

**Identity and tenancy**
- ● `users`, `accounts`, `sessions`, `verification_tokens`, `user_settings`
- ◆ `users` gains `email_verified_required`, `token_version`, `password_changed_at`
- ★ `organizations`, `org_members` (P3)
- ★ `project_members(project_id, user_id, role: owner|editor|commenter|viewer)`
- ★ `audit_log`

**Billing and usage:** ● plans, subscriptions, payments, `usage_tracking`; ★ `usage_events(run_id, model, tokens_in/out/cached, cost_micro_usd)`.

**Projects and state**
- ◆ `research_projects` gains `mode (guided|autopilot)`, `current_stage`, `settings jsonb` (privacy: `send_raw_data_to_llm=false`, citation style, target journal).
- ★ `project_stages`
- ★ `decisions` (a log of decisions)

**Graph core**
- ★ `graph_nodes`
- ★ `node_versions`
- ★ `graph_edges`
- ★ `stale_marks`

**Research design nodes (★ detail tables)**
- `ideas`, `research_questions`, `objectives`, `gaps`
- `constructs`
- `variables` (observed indicator, control or demographic)
- `hypotheses`
- `conceptual_models` + `model_elements` (latent/observed/path/moderation/mediation)

**Instrument:** ★ `instruments`, `instrument_items`, `scales` (a library of validated scales with sources), `item_translations`.

**Data**
- ◆ `datasets` becomes the dataset *identity*.
- ★ `dataset_versions` (immutable; content hash; storage key)
- ★ `dataset_columns`
- ★ `transform_steps` (cleaning/recode log per version)
- ★ `column_bindings` (column ↔ variable/item)

**Analysis**
- ★ `analyses`: the analysis spec, which is a node.
- ◆ `analysis_runs`: execution records.
- ★ `result_values`, `result_tables`, `figures`, `diagnostics`.

**Literature**
- ★ `sources` (canonical works, CSL-JSON, identifiers, verification)
- ★ `source_files`, `chunks` (with embedding)
- ★ `evidence` (claims extracted from sources)
- ★ `search_sessions`, `library_items` (user-level)

**Citations and references:** ★ `citations` (usage of a source in a block, with claim and locator); ◆ project `references` become bibliography views over `sources`.

**Manuscript**
- ★ `manuscripts` (thesis/paper/proposal, template, language)
- ◆ `research_sections` become `manuscript_sections`
- ★ `blocks` (ProseMirror JSON + plain text + provenance)
- ◆ `section_versions` become `block_versions` / `manuscript_versions`

**Publication**
- ★ `journal_targets`, `journal_profiles` (a cache of requirements)
- ★ `submissions`, `review_rounds`, `reviewer_comments`, `responses`

**Integrity and reproducibility**
- ★ `integrity_checks`, `integrity_findings`
- ★ `repro_manifests`, `repro_packages`

**Memory**
- ★ `memories(scope: user|project, kind, content, source, pinned, embedding)`
- ★ `thread_summaries`

**Conversations:** ◆ `ai_conversations` becomes `threads` (+ `project_id`, `focus_node_id`, `summary`); ● `ai_messages` (+ `run_id`).

**Agent runtime**
- ◆ `tasks` / `task_steps` become `runs` / `run_steps`, gaining `parent_run_id`, `agent`, `lease`, `heartbeat_at`, `cost`, `idempotency_key`.
- ★ `tool_calls`, `approvals`, `run_events` (outbox)
- `pgboss.*` (queue tables)

**Artifacts:** ◆ `artifacts` gains `node_id` and `render_job_id`. Versions are kept.

**Retired after migration:** `agent_tasks`, `analysis_jobs`, deep-research job rows (moved into `runs`), and the legacy `mode` values on conversations.

### C.3 Core DDL (abridged)

```sql
-- Graph core -------------------------------------------------------------------------
CREATE TABLE graph_nodes (
  id              uuid PRIMARY KEY,
  project_id      uuid NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  type            text NOT NULL,          -- 'construct','hypothesis','instrument_item','dataset_version',
                                          -- 'analysis','analysis_run','result_value','block','citation','source',...
  current_version int  NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'active',  -- draft|active|stale|superseded|archived
  label           text,                   -- short display label (e.g., "H1", "TRUST")
  created_by_user uuid, created_by_run uuid, origin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON graph_nodes (project_id, type, status);

CREATE TABLE node_versions (
  node_id    uuid REFERENCES graph_nodes(id) ON DELETE CASCADE,
  version    int,
  payload    jsonb NOT NULL,              -- full snapshot of the typed row at this version
  hash       text  NOT NULL,              -- sha256(canonical payload)
  change_note text, created_by_user uuid, created_by_run uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, version)
);

CREATE TABLE graph_edges (
  id          uuid PRIMARY KEY,
  project_id  uuid NOT NULL,
  src_id      uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  rel         text NOT NULL,              -- see G.2
  dst_id      uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  dst_version int,                        -- version of dst this edge depends on (NULL = floating)
  dependency  boolean NOT NULL,           -- does a change in dst invalidate src?
  attrs       jsonb NOT NULL DEFAULT '{}',-- e.g., {"role":"moderator"}, {"locator":"p. 12"}
  created_by_run uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (src_id, rel, dst_id)
);
CREATE INDEX ON graph_edges (dst_id) WHERE dependency;   -- impact traversal (reverse)
CREATE INDEX ON graph_edges (project_id, rel);

CREATE TABLE stale_marks (
  node_id uuid REFERENCES graph_nodes(id) ON DELETE CASCADE,
  cause_node_id uuid, cause_version int, path uuid[],      -- how staleness reached it
  severity text,                                            -- info|review|invalidates
  resolved_at timestamptz, resolved_by uuid,
  PRIMARY KEY (node_id, cause_node_id, cause_version)
);

-- Typed detail tables (examples) -----------------------------------------------------
CREATE TABLE constructs (
  node_id uuid PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE CASCADE,
  name text NOT NULL, name_ar text, abbreviation text,
  definition text, definition_source_id uuid,            -- → sources.node_id
  kind text NOT NULL,                                    -- reflective|formative|single_item|higher_order
  role_hint text                                         -- iv|dv|mediator|moderator|control
);

CREATE TABLE hypotheses (
  node_id uuid PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE CASCADE,
  code text NOT NULL,                  -- "H1"
  statement text NOT NULL, statement_ar text,
  kind text NOT NULL,                  -- direct|mediation|moderation|moderated_mediation|difference|association
  direction text,                      -- positive|negative|non_directional
  registered_at timestamptz,           -- frozen (pre-registration) timestamp
  first_seen_results_at timestamptz    -- set when any analysis testing it completes (HARKing signal)
);

CREATE TABLE instrument_items (
  node_id uuid PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE CASCADE,
  instrument_id uuid NOT NULL, code text NOT NULL,       -- "TR1"
  text text NOT NULL, text_ar text, reverse_coded boolean NOT NULL DEFAULT false,
  scale_min int, scale_max int, adapted_from_source_id uuid
);

CREATE TABLE dataset_versions (
  node_id uuid PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL, version int NOT NULL, parent_version_node_id uuid,
  storage_key text NOT NULL, content_sha256 text NOT NULL,
  n_rows int, n_cols int, profile jsonb, transform_log jsonb   -- ordered transform_steps
);

CREATE TABLE analyses (                                  -- the SPEC (versioned node)
  node_id uuid PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE CASCADE,
  family text NOT NULL,       -- descriptive|ttest|anova|regression|efa|cfa|cbsem|plssem|mediation|moderation|modmed|...
  spec jsonb NOT NULL,        -- AnalysisSpec (E.4)
  selected_by text NOT NULL,  -- user|advisor
  rationale jsonb             -- advisor explanation + methodological citations
);

CREATE TABLE analysis_runs (
  node_id uuid PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE CASCADE,
  analysis_node_id uuid NOT NULL, analysis_version int NOT NULL,
  dataset_version_node_id uuid NOT NULL,
  engine text NOT NULL, engine_version text NOT NULL, image_digest text,
  packages jsonb, seed bigint, script text,               -- generated R/TS script (reproducible)
  status text NOT NULL, started_at timestamptz, finished_at timestamptz,
  bundle_key text                                        -- full ResultBundle JSON in S3
);

CREATE TABLE result_values (
  node_id uuid PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE CASCADE,
  run_node_id uuid NOT NULL,
  path text NOT NULL,          -- canonical key, e.g. "structural.TRUST->INTENT.beta"
  stat text NOT NULL,          -- beta|b|se|t|z|p|ci_low|ci_high|r2|f2|q2|cfi|tli|rmsea|srmr|alpha|omega|ave|htmt|...
  value double precision, df1 double precision, df2 double precision,
  display jsonb                -- APA formatting hints per locale
);
CREATE UNIQUE INDEX ON result_values (run_node_id, path, stat);

CREATE TABLE sources (
  node_id uuid PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE CASCADE,
  csl jsonb NOT NULL,                        -- CSL-JSON (authors, title, container, issued, DOI...)
  doi text, openalex_id text, s2_id text, pmid text, arxiv_id text, isbn text,
  abstract text, oa_url text, is_retracted boolean, retraction_checked_at timestamptz,
  verification text NOT NULL DEFAULT 'unverified',  -- verified|mismatch|not_found|unverified|user_confirmed
  venue_signals jsonb                        -- indexing, predatory flags, OA status
);

CREATE TABLE chunks (
  id uuid PRIMARY KEY, project_id uuid, owner_user_id uuid NOT NULL,
  source_node_id uuid, file_id uuid,            -- one of
  section text, page_from int, page_to int, ordinal int,
  text text NOT NULL, lang text, tsv tsvector,
  embedding vector(1024)                        -- dimension depends on chosen multilingual model
);
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON chunks USING gin (tsv);

CREATE TABLE citations (
  node_id uuid PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE CASCADE,
  source_node_id uuid NOT NULL, block_node_id uuid,
  claim_text text, locator text,                   -- "p. 12"
  support text NOT NULL DEFAULT 'unchecked',       -- supported|partial|contradicted|insufficient|unchecked
  evidence_chunk_ids uuid[], support_quote text, checked_at timestamptz, checker_run uuid
);

CREATE TABLE blocks (                               -- manuscript content unit (paragraph/table/figure)
  node_id uuid PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE CASCADE,
  section_id uuid NOT NULL, ordinal int NOT NULL,
  kind text NOT NULL,                     -- paragraph|heading|table_ref|figure_ref|list|equation
  doc jsonb NOT NULL,                     -- ProseMirror JSON with valueRef/citationRef inline nodes
  plain text NOT NULL, lang text,
  authored_by text NOT NULL               -- user|agent|mixed
);

-- Agent runtime ----------------------------------------------------------------------
CREATE TABLE runs (
  id uuid PRIMARY KEY, project_id uuid, user_id uuid NOT NULL, thread_id uuid,
  parent_run_id uuid, agent text NOT NULL,              -- supervisor|literature|analysis|writing|quality
  goal text NOT NULL, status text NOT NULL,             -- queued|running|waiting_approval|waiting_input|
                                                        -- paused|succeeded|failed|cancelled
  plan jsonb, budget jsonb, spent jsonb,                -- steps, tokens, cost, wall time
  lease_owner text, lease_expires_at timestamptz, heartbeat_at timestamptz,
  idempotency_key text UNIQUE, error jsonb,
  created_at timestamptz DEFAULT now(), finished_at timestamptz
);
CREATE TABLE run_steps  (id uuid PRIMARY KEY, run_id uuid, ordinal int, kind text,  -- model|tool|approval|subrun
                         status text, input jsonb, output jsonb, error jsonb, attempts int,
                         started_at timestamptz, finished_at timestamptz);
CREATE TABLE tool_calls (id uuid PRIMARY KEY, run_step_id uuid, tool text, tool_version text,
                         args jsonb, result_ref jsonb, side_effect text, idempotency_key text UNIQUE,
                         graph_writes uuid[], duration_ms int, cost_micro_usd bigint);
CREATE TABLE approvals  (id uuid PRIMARY KEY, run_id uuid, kind text, payload jsonb, preview jsonb,
                         status text, decided_by uuid, decided_at timestamptz, decision jsonb,
                         expires_at timestamptz);
CREATE TABLE run_events (id bigserial PRIMARY KEY, run_id uuid, project_id uuid, type text,
                         data jsonb, created_at timestamptz DEFAULT now());   -- outbox → SSE
```

### C.4 Row-Level Security (defence in depth)

The application connects as `app_user`. Each transaction runs `SET LOCAL app.user_id = …`. Policies on project-scoped tables:

```sql
USING (EXISTS (SELECT 1 FROM project_members m
               WHERE m.project_id = <table>.project_id AND m.user_id = current_setting('app.user_id')::uuid))
```

Ownership checks in the repositories stay the primary control. RLS catches the IDOR class the audit found.

---

## D. Agent architecture

### D.1 Which of the proposed agents should really be agents?

| Proposed agent | Verdict | Implemented as | Why |
|---|---|---|---|
| Research Planner | **Merge into the Supervisor** | Supervisor's planning mode and a `plan.propose` checkpoint | Planning needs the whole project state, which the Supervisor already holds. |
| Literature Agent | **Specialist agent** | `literature` sub-run | Many searches running in parallel, large context of sources, its own budget. It benefits from isolation. |
| Data Analyst Agent | **Merge** into Analysis | Analysis specialist, skill "data-prep" | Data preparation and statistics share context: columns, bindings, assumptions. |
| Statistics Agent | **Merge** into Analysis | Analysis specialist, skill "classical" | The engine does the math. The agent only chooses and specifies. |
| SEM Agent | **Merge** into Analysis | Analysis specialist, skill "sem" (+ SEM tools) | Same reason. Splitting it would duplicate data and model context. |
| Writing Agent | **Specialist agent** | `writing` sub-run | Long outputs, its own model tier, strict output validator (value and citation tokens). |
| Citation Agent | **Not an agent** | A deterministic pipeline and tools (`citation.*`), plus an LLM *judge tool* for claim support | Verification must be reproducible and auditable, not open-ended reasoning. |
| Journal Agent | **Not an agent** | Tools (`journal.match`, `journal.requirements`) + writing skill "submission-kit" | Matching is a retrieval-and-scoring problem. The cover letter is a writing task. |
| Reviewer Agent | **Split** | (a) *Simulated peer review*: a skill of the Quality agent. (b) *Reviewer response*: a Writing skill | Critique must be independent of the author. The response is authoring. |
| Quality Control Agent | **Specialist agent, independent** | `quality` sub-run with **read-only** tools and a different prompt, ideally a different model | An author agent checking its own work shares its own blind spots. |

**Result: one Supervisor and four specialists** (Literature, Analysis, Writing, Quality), plus about 70 tools. It is simple enough to reason about and debug, and each specialist earns its place.

### D.2 Runtime model

```
Run (durable; row in runs; leased by a worker)
 └─ Agent loop (Supervisor or Specialist)
      1. Context Assembler builds the prompt (see §F.4)
      2. Model Gateway: messages + tool schemas (filtered by agent profile + policy)
      3. Model returns text and/or tool_use blocks (parallel tool calls allowed)
      4. For each tool_use:
           Policy.evaluate(tool, args, project, run) → allow | needs_approval | deny
             needs_approval → create approval, emit event, status=waiting_approval, release lease, STOP
           Execute (in-process, or enqueue compute job and wait for completion event)
           Persist run_step + tool_call + graph writes (single transaction) → emit events
           Return tool_result (success | is_error with a structured, model-readable error)
      5. Budget check (steps, tokens, cost, wall time) → pause with summary if exceeded
      6. Loop until the model ends its turn, or the agent calls `run.complete(summary, outputs)`
 └─ Completion gate: if the run produced manuscript/analysis outputs → Quality sub-run (verifier)
      verifier findings with severity ≥ error → back to the author agent (max N=2 rounds) → remaining
      findings attached to the final answer + Integrity report
 └─ Final synthesis: user-facing answer that references the graph nodes changed/created
```

- **Delegation.** The Supervisor calls a specialist through the tool `delegate(agent, goal, focus_nodes, budget)`. That creates a child run. Independent children run in parallel, for example a Literature search while the Analysis agent profiles data.
- **Specialist contract.** Every specialist returns a typed `SubrunResult {summary, created_nodes[], updated_nodes[], open_questions[], findings[]}`. The Supervisor never parses prose.
- **Agent profiles.** A profile is `{system_prompt, skills[], tool_allowlist, model_tier, budget_defaults, output_validators[]}`. Skills are prompt modules loaded on demand, such as `sem`, `process-models`, `apa-results`, `thesis-jordan`, `reviewer-response`.
- **Planning.** For multi-step goals, the Supervisor calls `plan.propose(steps[])` before acting. The plan is shown to the user. Guided mode asks for approval; Autopilot mode proceeds except where a checkpoint is always required. Plans can be revised; each revision is a new plan version with a diff.

### D.3 Why an agent loop and not only a DAG?

The existing executor (dependency graph, budgets, claims) is kept as the **engine**. It runs the agent loop as a step type, and it also runs **deterministic pipelines** as fixed DAGs: deep research, citation verification, ingestion, reproducibility checks. Open-ended work gets the loop. Well-understood pipelines stay deterministic and cheap.

---

## E. Tool architecture

### E.1 Tool definition contract

```ts
interface ToolDef<I, O> {
  name: `${Domain}.${string}`;          // e.g. 'graph.update_node', 'stats.run'
  version: string;                       // semver; recorded on each call
  description: string;                   // model-facing, concise, with when-to-use / when-not-to-use
  input: ZodSchema<I>;                   // → JSON Schema for the provider's native tool API
  output: ZodSchema<O>;                  // validated before returning to the model
  sideEffect: 'read' | 'compute' | 'write_state' | 'external_read' | 'destructive';
  approval: ApprovalPolicy;              // 'never' | 'guided_mode' | 'always' | (ctx) => boolean
  execution: 'inline' | { queue: 'stats' | 'ingest' | 'render' | 'verify' };
  timeoutMs: number; maxAttempts: number; idempotent: boolean;
  scopes: Array<'project:read' | 'project:write' | 'data:raw' | 'net:scholarly' | 'net:web'>;
  graphEffects?: { creates?: NodeType[]; updates?: NodeType[]; edges?: EdgeRel[] };
  costClass: 'free' | 'low' | 'model' | 'compute_heavy';
  agents: AgentName[];                   // who may see it
  handler(input: I, ctx: ToolContext): Promise<O>;
}
```

`ToolContext` provides:
- `{user, project, run, policy, graph (transactional), storage, gateway, emit(event), signal (AbortSignal)}`;
- quota-reserved model access for tools that call a model themselves (e.g. the claim-support judge).

### E.2 Tool-calling system

- **Registry.** `src/server/tools/registry.ts` collects `ToolDef`s at build time. `toolsFor(agentProfile, projectPolicy)` produces the provider-specific tool list; the gateway adapters translate JSON Schema to each provider.
- **Native tool calling** is the default. For a provider without it, a structured-output fallback emits `{tool, args}` validated with zod. The rest of the system does not change.
- **Validation errors** go back to the model as `is_error` tool results with the zod issues, so it can correct itself (at most 2 attempts). They are never thrown out of the loop.
- **Parallel calls.** The model may emit several `tool_use` blocks. Read, compute and external-read calls run concurrently. `write_state` calls run in order within one graph transaction.
- **Long-running tools** (`execution.queue`) enqueue a job and park the step. The run releases its lease. A completion event re-activates the run, which resumes with the tool result. No worker blocks waiting.
- **Idempotency.** `idempotency_key = hash(run_id, step_ordinal, tool, args)`. A retried step never duplicates writes or jobs.
- **Every call** is traced as an OTel span and stored in `tool_calls`. The UI shows it in the activity timeline with the user's inputs and outputs.
- **MCP compatibility (P3).** Registry tools can be exposed as an MCP server, and allow-listed external MCP tools can be imported (e.g. Zotero).

### E.3 Tool catalogue (initial)

| Domain | Tools | Side effect |
|---|---|---|
| graph | `get_state`, `get_node`, `search_nodes`, `neighbors(k)`, `impact(node, proposed_change)`, `create_node`, `update_node`, `link`, `unlink`, `resolve_stale` | read / write_state |
| plan / run | `plan.propose`, `plan.revise`, `ask_user(question, options)`, `request_approval(kind, preview)`, `delegate(agent, goal)`, `run.complete` | — |
| design | `design.generate_questions`, `design.refine_objectives`, `design.propose_constructs`, `design.propose_hypotheses`, `design.build_conceptual_model`, `design.check_alignment` (RQ ↔ objectives ↔ hypotheses ↔ model) | write_state (draft nodes) |
| literature | `lit.search(sources[], query, filters)`, `lit.snowball(source, direction)`, `lit.fetch_fulltext`, `lit.extract_evidence(source, schema)`, `lit.build_matrix`, `lit.find_gaps`, `lit.deep_research(goal)` (pipeline), `lit.add_to_library` | external_read / write_state |
| retrieval | `retrieve.semantic(query, scope, k)`, `retrieve.chunk(id)`, `retrieve.source_passages(source, claim)` | read |
| instrument | `instrument.find_scales(construct)`, `instrument.draft_items`, `instrument.translate`, `instrument.back_translate_check`, `instrument.codebook`, `instrument.export(form: docx/xlsx/Google Forms JSON/KoBo XLSForm)` | write_state |
| data | `data.profile`, `data.bind_columns` (column ↔ item/variable), `data.clean(ops[])`, `data.recode`, `data.reverse_code`, `data.compute_scores`, `data.missingness_report` | write_state (new dataset_version) — **approval** |
| analysis | `analysis.recommend(hypothesis \| question)`, `analysis.propose_spec`, `stats.run(spec)`, `stats.assumptions(spec)`, `sem.build_from_graph(model)`, `sem.modification_indices`, `analysis.compare_runs` | compute (queue: stats) |
| results | `results.get(run)`, `results.table(run, template: apa\|smartpls\|amos\|spss)`, `results.figure(run, kind)`, `results.interpret(run)` (value-token constrained) | read / write_state |
| writing | `ms.outline(template)`, `ms.draft_section(section, focus_nodes)`, `ms.revise_block(block, instructions)`, `ms.insert_value(valueId, format)`, `ms.insert_table/figure`, `ms.translate`, `ms.abstract`, `ms.ai_disclosure` | write_state |
| citation | `citation.insert(source, claim, locator)`, `citation.verify(citation \| all)`, `citation.resolve(identifier \| text)`, `citation.format(style)`, `citation.import(bibtex\|ris\|csl)`, `citation.export` | write_state / external_read |
| integrity | `integrity.check(scope, checks[])`, `integrity.statcheck(block)`, `integrity.trace(value \| number_text)`, `integrity.report` | read |
| publication | `journal.match(manuscript, filters)`, `journal.requirements(venue)`, `journal.format_check`, `sub.cover_letter`, `sub.parse_decision_letter`, `sub.response_matrix`, `sub.draft_response(comment)` | external_read / write_state |
| repro | `repro.manifest(scope)`, `repro.package(options)`, `repro.verify(package)` | compute (queue) |
| render | `render.document(manuscript, format, template)`, `render.slides`, `render.spreadsheet` | compute (queue: render) |
| web | `web.search`, `web.fetch` (through the egress proxy) | external_read |

### E.4 AnalysisSpec (the contract between the agent and the engines)

```jsonc
{
  "family": "plssem",                       // descriptive|ttest|anova|ancova|manova|rm_anova|regression|
                                            // logistic|chisq|nonparam|correlation|efa|cfa|cbsem|plssem|
                                            // mediation|moderation|modmed|reliability
  "datasetVersion": "node-uuid",
  "model": {                                // for SEM/PROCESS, generated from the graph (sem.build_from_graph)
    "constructs": [{ "id": "TRUST", "mode": "reflective", "items": ["TR1","TR2","TR3"] }],
    "paths": [{ "from": "TRUST", "to": "INTENT", "hypothesis": "H1" }],
    "mediations": [{ "x": "TRUST", "m": "ATT", "y": "INTENT", "hypothesis": "H4" }],
    "moderations": [{ "x": "ATT", "w": "EXP", "y": "INTENT", "hypothesis": "H5", "method": "two_stage" }]
  },
  "options": { "bootstrap": 5000, "ci": "percentile|bca", "missing": "listwise|mean|fiml",
               "estimator": "ML|MLR|WLSMV", "seed": 20260923, "weighting": "path" },
  "engine": "auto"                          // auto → registry maps family to ts-core or r-engine
}
```

---

## F. Research Project state model

### F.1 The research pipeline as stages

The 28 steps you listed are grouped into 8 phases. Each stage is a row in `project_stages`, with its status derived from graph nodes.

| Phase | Stages | Primary nodes | Owner (agent / skill) |
|---|---|---|---|
| 1. Framing | Idea → Research questions → Objectives | idea, research_question, objective | Supervisor · design |
| 2. Literature | Literature search → Deep research → Research gap | source, evidence, gap, search_session | Literature |
| 3. Theory | Constructs/variables → Conceptual framework → Hypotheses | construct, variable, conceptual_model, hypothesis | Supervisor · design (+ Literature for definitions) |
| 4. Instrument | Questionnaire → Data-collection plan | instrument, instrument_item, scale | Writing · instrument |
| 5. Data | Data collection (import/connect) → Cleaning | dataset, dataset_version, transform_step, column_binding | Analysis · data-prep |
| 6. Analysis | Test selection → SPSS-style statistics → EFA → CFA → CB-SEM → PLS-SEM → Mediation → Moderation → Moderated mediation → Interpretation → Tables/figures | analysis, analysis_run, result_value, result_table, figure | Analysis |
| 7. Writing | Citation verification → Manuscript | manuscript, section, block, citation | Writing + Quality |
| 8. Publication | Journal matching → Cover letter → Reviewer response → Reproducibility package | journal_target, submission, reviewer_comment, response, repro_package | Writing · submission + repro engine |

Stages are **not strictly linear**: a qualitative project skips phase 6, and a secondary-data project skips phase 4. `research_projects.settings.design` (quantitative-survey, experimental, secondary, qualitative, mixed, systematic-review) selects the applicable stage set.

### F.2 Stage state machine

```
not_started ──► in_progress ──► ready_for_review ──► approved
      ▲              │  ▲               │                 │
      │              ▼  │               ▼                 ▼
      └──────────  blocked (missing input)          stale (upstream changed) ──► in_progress
```

- **Derived, not hand-set.** For example, *Hypotheses* is `in_progress` when at least one hypothesis exists and `ready_for_review` when every construct in the model is covered and every hypothesis maps to a model path or test. Being `approved` requires a user checkpoint.
- **Readiness gates** are deterministic checks for moving on. Example:
  - Analysis needs an approved conceptual model.
  - It needs a dataset version with column bindings covering every item.
  - Missing values must be handled.
- **Stale.** A stage becomes `stale` when any of its approved nodes is stale.

### F.3 Project State Snapshot (what the agent reasons over)

This compact, generated JSON is always in context (about 1.5–4k tokens):

```jsonc
{
  "project": { "title": "...", "design": "quantitative-survey", "language": "ar", "mode": "guided",
               "targetJournal": "…", "citationStyle": "apa7" },
  "stages": [{ "key": "hypotheses", "status": "approved" }, { "key": "cfa", "status": "stale",
               "why": "Construct TRUST v4 changed" }],
  "design":  { "rq": ["RQ1 …"], "constructs": ["TRUST(reflective,3 items)", "…"],
               "hypotheses": ["H1 TRUST→INTENT (+)", "H4 TRUST→ATT→INTENT (mediation)"] },
  "data":    { "active": "survey_v3 (n=412; 2.1% missing; bindings 100%)" },
  "analysis":{ "latest": ["PLS run R12 (succeeded; 5000 bootstrap)"], "untested": ["H5"] },
  "writing": { "sections": ["Intro(approved)", "Results(draft; 3 untraced numbers)"] },
  "integrity": { "open": 4, "blocking": 1 },
  "openQuestions": ["Which moderator method for H5?"]
}
```

### F.4 Context assembly (per model call)

In priority order, with budgets measured by real token counts:
1. System prompt, agent profile and skills.
2. The Project State Snapshot.
3. A **focus-graph slice**: the k-hop neighbourhood (k=2) of the focus nodes, serialised as a compact typed list.
4. Retrieved chunks (fenced as untrusted data).
5. The thread summary and the last N turns in chronological order. This fixes the audit's turn-ordering bug.
6. Pinned user and project memories.
7. The tool results of the current run.

Anything left out stays reachable through the `graph.*` and `retrieve.*` tools. The agent can fetch more, so the prompt doesn't have to hold everything.

### F.5 Memory design

| Memory | Scope | Contents | Written by | Read by |
|---|---|---|---|---|
| **Conversation memory** | Thread | Last N turns + rolling summary (`thread_summaries`, refreshed every ~10 turns) | System | Context assembler |
| **Project memory** | Project | **The Research Graph itself** + `decisions` log + generated **Project Brief** (a narrative summary regenerated on significant graph changes) + project-scoped `memories` ("supervisor requires Harvard style") | Agents (proposed) + user | All agents |
| **Research memory** | User, across projects | Personal library (sources, notes, highlights), methods the user has used, reusable constructs/scales, writing-style profile | Library actions, confirmed agent suggestions | Literature, Writing |
| **User memory** | User | Degree, field, institution, languages, preferred styles, expertise level (explain more vs less) | Settings + confirmed suggestions | All |
| **Semantic index** | Project + user | Embeddings of chunks, blocks, notes, summaries | Ingest and write paths | `retrieve.*` |

Memories are **user-visible and editable**, with a "What Academic AI remembers" page. Agents can *propose* a memory; it is stored only after confirmation or when policy allows. Memory never crosses projects unless it is user-level.

---

## G. Research Graph design

### G.1 Node types

`idea`, `research_question`, `objective`, `gap`, `construct`, `variable`, `conceptual_model`, `model_element`, `hypothesis`, `instrument`, `instrument_item`, `scale`, `dataset`, `dataset_version`, `dataset_column`, `transform_step`, `analysis`, `analysis_run`, `result_value`, `result_table`, `figure`, `interpretation`, `source`, `evidence`, `citation`, `manuscript`, `section`, `block`, `journal_target`, `submission`, `reviewer_comment`, `response`, `repro_package`, `decision`, `note`.

### G.2 Edge relations (`dependency` = whether a change to the target makes the source stale)

| Relation | From → To | dep | Meaning |
|---|---|---|---|
| `addresses` | research_question → gap | ✓ | RQ motivated by the gap |
| `operationalizes` | objective → research_question | ✓ | |
| `defined_by` | construct → source | ✓ | Definition taken from the source |
| `measures` | instrument_item → construct | ✓ | Item measures the construct |
| `adapted_from` | instrument_item → scale/source | ✓ | |
| `binds` | dataset_column → instrument_item \| variable | ✓ | Column holds the item's responses |
| `derived_from` | dataset_version → dataset_version | ✓ | Cleaning lineage (with a transform_step) |
| `element_of` | model_element → conceptual_model | ✓ | |
| `represents` | model_element → construct \| variable | ✓ | |
| `posits` | hypothesis → model_element (path/mediation/moderation) | ✓ | Hypothesis is this path |
| `relates` | hypothesis → construct | ✓ | |
| `grounded_in` | hypothesis → evidence \| citation | ✓ | Theoretical justification |
| `specifies` | analysis → conceptual_model \| hypothesis | ✓ | Spec built from them |
| `executes` | analysis_run → analysis@v | ✓ | |
| `uses_data` | analysis_run → dataset_version | ✓ | |
| `produces` | analysis_run → result_value \| result_table \| figure | ✓ | |
| `tests` | result_value → hypothesis | — | Which value decides which hypothesis |
| `supports` / `contradicts` | evidence → hypothesis \| claim | — | |
| `extracted_from` | evidence → source (+ chunk) | ✓ | |
| `reports` | block → result_value \| result_table \| figure | ✓ | **Traceable numbers** |
| `cites` | block → citation | ✓ | |
| `of_source` | citation → source | ✓ | **Traceable citations** |
| `describes` | block → construct \| hypothesis \| analysis | ✓ | The block explains this node (for impact on prose) |
| `responds_to` | response → reviewer_comment | — | |
| `changes` | response → block@v | — | The response links to the manuscript diff |
| `targets` | manuscript → journal_target | ✓ | Formatting and length rules |
| `packages` | repro_package → analysis_run \| dataset_version \| manuscript@v | ✓ | |

### G.3 Versioning and staleness propagation

- **Updating a node** writes `node_versions(v+1)` and increments `current_version`, in the same transaction as `impact()`.
- **`impact(node, fromVersion)`:**
  - A recursive CTE over reverse dependency edges `{src ← dst}` where `dst_version = fromVersion`.
  - It is bounded by project and has a cycle guard (`path` array).
  - Each reached node gets a `stale_marks` row with the propagation `path` and a severity:
    - `invalidates`: an analysis run that used a changed dataset version or model; a block that reports its values.
    - `review`: a hypothesis wording that depends on a changed construct definition; a citation whose claim was about the old definition.
    - `info`: a distant dependency.
- **Dry run.** `POST …/nodes/:id/impact` with a *proposed* payload returns the same report without writing, so the UI can show "this change will affect…" before saving.
- **Resolving staleness.** Accepting as still valid (edge re-pinned to the new version), or regenerating (a new run, a new block version), clears the mark.
- **Result nodes are immutable.** A new analysis run creates new `result_value` nodes. Blocks keep pointing at the old values until the user or agent re-points them, and the verifier flags blocks that report superseded runs.

### G.4 Traceable numbers

- **Inline node in the manuscript document:** `valueRef { valueId, format: "apa_beta" | "p" | "ci" | "fit_block", locale }`. It renders from the live `result_values` row, formatted per APA and the chosen locale (Arabic or Latin digits by project setting).
- **Writing-output validator:**
  - Any statistic pattern in agent prose (β, r, t(df), F(df1, df2), p, CI, R², CFI, …) that is not a `{{value:id}}` token → the draft is rejected and sent back with the offending spans (up to 2 retries); then it is inserted with an `untraced` mark.
  - User-typed numbers are allowed but flagged `untraced`, with a "link to result" action.
- **`integrity.trace(text)`** matches an untraced number to candidate `result_values` (same stat, same value at the displayed precision) and proposes a link.
- **statcheck-style recomputation:**
  - For any reported test statistic with its df, p is recomputed with the TS distribution library.
  - Inconsistencies are flagged, which also catches manual edits.

### G.5 Traceable citations

`block —cites→ citation —of_source→ source`. The citation carries `claim_text`, `locator`, `support` status and `evidence_chunk_ids`. The bibliography is **generated** from the cited sources through CSL, so the in-text markers and the reference list can never disagree. That fixes the audit's numbering mismatch by design.

### G.6 Integrity signals from the graph

| Signal | How it is detected |
|---|---|
| **HARKing risk** | A hypothesis version was created or changed after `first_seen_results_at` of any run testing it. The fix offered: a disclosure, or relabelling as exploratory. |
| **Selective reporting** | Runs that tested hypotheses but have no `reports` edge from the manuscript. A prompt to disclose them. |
| **Multiplicity** | The number of inferential runs per hypothesis. Suggests a correction when needed. |
| **Orphans** | Items not bound to columns; constructs with no items; hypotheses without tests; sources cited but unverified. |
| **Sample consistency** | Every reported N equals the `n_rows` of the dataset version used. |

---

## H. API architecture

### H.1 Conventions

- **Prefix `/api/v1`.** The existing envelope `{ok, data}` / `{ok:false, error:{code, message, messageAr}}` is kept.
- **Authorisation.** Every project route calls `requireProjectRole(projectId, 'viewer' | 'commenter' | 'editor' | 'owner')`. Repositories also scope by project, and RLS backs that up.
- **Idempotency.** An `Idempotency-Key` header on POSTs that start runs, uploads or exports.
- **Optimistic concurrency.** Graph writes carry `If-Match: <version>`. A mismatch returns 409 with the current version.
- **Pagination.** Cursors (`?cursor=&limit=`).
- **Schemas.** zod schemas live in `src/contracts/*`, are shared with the client, and are used to generate OpenAPI.
- **Rate-limit classes.** `auth`, `write`, `run.start`, `upload`, `export`, `search`. They use Redis and a client IP from a trusted proxy.
- **Long work never runs inside a request.** It returns `202 {runId | jobId}`, and the client follows `/events`.

### H.2 Resources

```
Projects & state
  GET/POST        /projects                         PATCH/DELETE /projects/:p
  GET             /projects/:p/state                (stages + snapshot)
  GET/POST        /projects/:p/members              (P3 collaboration)
  GET             /projects/:p/activity             (runs, approvals, changes)

Graph (generic + typed conveniences)
  GET             /projects/:p/nodes?type=&status=&q=
  POST            /projects/:p/nodes                {type, payload}
  GET/PATCH       /projects/:p/nodes/:n             (If-Match)
  GET             /projects/:p/nodes/:n/versions    /nodes/:n/versions/:v
  POST            /projects/:p/nodes/:n/impact      {proposedPayload} → ImpactReport (dry-run)
  GET             /projects/:p/nodes/:n/trace       (upstream provenance chain)
  POST/DELETE     /projects/:p/edges
  GET             /projects/:p/stale                POST /projects/:p/stale/:n/resolve
  typed:          /projects/:p/{questions|constructs|hypotheses|model|instrument|datasets|analyses|
                                runs|sources|citations|manuscripts|journal-targets|reviews}

Agent & runs
  GET/POST        /projects/:p/threads              GET /threads/:t/messages
  POST            /threads/:t/messages              {text, focusNodeIds?, attachments?} → {messageId, runId?}
  GET             /runs/:r                          GET /runs/:r/events (SSE, Last-Event-ID)
  POST            /runs/:r/approvals/:a             {decision: approve|reject|edit, edits?}
  POST            /runs/:r/answers                  {questionId, answer}
  POST            /runs/:r/cancel | /pause | /resume
  POST            /quick-chat                       (no project; can be promoted: POST /quick-chat/:t/promote)

Files & data
  POST            /uploads                          → {uploadId, presignedUrl}
  POST            /uploads/:u/complete              → ingest job
  GET             /projects/:p/datasets/:d/versions  GET /…/versions/:v/download (signed, owner-checked)

Search & library
  GET             /projects/:p/search?q=&types=     (hybrid semantic + lexical)
  GET/POST        /library/sources                  POST /library/import (bibtex|ris|csl)

Outputs
  POST            /projects/:p/exports              {kind: docx|pdf|latex|pptx|xlsx|repro, template}
  GET             /exports/:e                       GET /artifacts/:a (existing, kept)
  GET             /projects/:p/integrity            POST /projects/:p/integrity/run

Account & admin (existing, hardened)
  /auth/*  /settings  /billing/*  /admin/*  /me/export  DELETE /me  /me/memories
```

### H.3 Events (SSE)

The event stream is typed and discriminated on `type`:

```
run.status · run.plan · step.started · step.finished · tool.called · tool.result · model.delta ·
approval.requested · question.asked · graph.changed{nodeIds,stale[]} · artifact.created ·
integrity.finding · usage.updated · run.completed
```

Events come from the `run_events` outbox:
- The row is inserted in the same transaction as the state change.
- `NOTIFY run_events` fires, and the SSE gateway fans the event out.
- Clients resume with `Last-Event-ID`.
- This replaces the current polling of the database every 1.5 s.

---

## I. Security architecture

| Area | Design |
|---|---|
| **Authentication** | Auth.js with **mandatory email verification**. Owner and admin rights require `emailVerified` plus an explicit DB role; no rights come from the email string alone. `allowDangerousEmailAccountLinking` off. JWTs last 15 minutes and refresh against the DB, checking `status`, `role` and `token_version`. `signIn` callback for OAuth. Password change bumps `token_version`. Optional TOTP 2FA (P2). Rate-limited login. |
| **Authorisation** | Project RBAC through `project_members`. `requireProjectRole` in every route. Repository methods take `(userId, projectId)`. **Postgres RLS** as a second layer. Admin routes require `role=ADMIN` from the DB, not from the token alone. |
| **Agent permissions** | A run executes *as the user* and inherits their project role. The tool policy engine checks `scopes` against the project's settings; for example, `data:raw` is denied when `send_raw_data_to_llm=false`, and tools then receive only aggregates and metadata. Destructive and write tools need approval under the policy table (§J). **Retrieved content can never widen permissions**: the tool list is fixed at run start. |
| **Prompt-injection defence** | All untrusted text (web pages, PDFs, uploaded documents, dataset cells, reviewer letters) goes through the **Context Envelope**, with source labels and a "data, not instructions" fence. Tool results that come from external content are marked `untrusted` in the transcript. High-impact tools (graph writes that delete or overwrite, exports, anything external) require approval if the triggering turn consumed untrusted content. An output filter blocks hidden links and exfiltration patterns in rendered markdown. |
| **Network egress** | Workers have no direct internet. All fetches go through the **egress proxy**, which blocks private/link-local/IPv6-mapped ranges, validates every redirect hop, pins the resolved IP, and enforces size and time caps. The stats and render workers have **no egress at all**. |
| **Files** | Presigned direct-to-bucket uploads with size caps. Magic-byte and MIME checks. Decompression caps (zip entries, total inflated size, PDF stream `maxOutputLength`). ClamAV scan (P1). Parsing happens in the ingest worker with memory limits, never in `web`. Downloads go through owner-checked, short-lived signed URLs. CSV exports neutralise spreadsheet formulas. |
| **Compute sandbox** | The stats worker is an R container running as a non-root user with a read-only filesystem except `/tmp`, no network, and per-job CPU, memory and time limits. It accepts only a validated `AnalysisSpec`, never arbitrary code. The optional code sandbox (P2) is a separate gVisor/Firecracker-class sandbox that can only reach the job's own data. |
| **Secrets** | Provider keys only in the platform secret store and read by the model gateway. The Google key is sent in a header. Keys are never logged and error bodies are sanitised. Keys are rotated, with a runbook. |
| **Data protection** | TLS everywhere. Neon encryption at rest. Per-project privacy settings. **Dataset rows are never sent to an LLM by default**; only column metadata, aggregates and results are. Retention jobs cover expired tokens, orphaned files and deleted projects. GDPR self-service export (`/me/export`, a zip) and deletion (cascade plus storage purge). An accurate subprocessor list in the privacy policy. |
| **Audit** | `audit_log` records sign-ins, role changes, project sharing, exports, deletions, approvals and admin actions. Append-only, retained for 1 year. |
| **Headers and app** | CSP with nonces and no `unsafe-eval`. HSTS. Sandboxed SVG. Admin-only detailed health check (public `/api/health` returns only up/down). Dependency scanning in CI. |
| **Abuse and cost** | Atomic quota reservation before each model call, settled afterwards. Per-run budgets. Per-user concurrency caps. Anomaly alerts on spend. |

---

## J. Cross-cutting designs: the remaining numbered subsystems

### J.1 Document retrieval and semantic search (item 6)

1. **Ingest pipeline** (queue `ingest`):
   - Upload.
   - Magic/MIME check and scan.
   - Route by type:
     - Scholarly PDF → **GROBID** (TEI: title, authors, sections, references, figures).
     - Other PDF → text layer with pdf.js/pdfium.
     - Scanned pages → **Tesseract OCR (ara+eng)**.
     - DOCX → structured parse: headings, tables, footnotes.
     - PPTX → slide text.
     - XLSX/CSV/SAV → the dataset path.
2. **Chunking.** Section-aware, 500–800 tokens with 15% overlap. Each chunk keeps its page range and heading path. There is no limit on the number of chunks per document (the current 100-chunk cap is removed).
3. **Embedding.**
   - A multilingual embedding model with strong Arabic support, chosen through a bake-off on an Arabic+English academic retrieval set, sits behind an `Embedder` interface so it can be swapped.
   - Stored in pgvector with an HNSW index.
4. **Search.**
   - **Hybrid**: Postgres full-text (with an Arabic-normalising configuration) plus vector search, merged by Reciprocal Rank Fusion.
   - An optional cross-encoder or LLM re-rank for the top 30.
   - Scoped to project, library or source.
5. **Citeable results.** Each hit returns `{chunkId, sourceId, page, heading, text}`, so answers and citations can point to page-level locators.

### J.2 Citation verification (item 7)

The pipeline (queue `verify`) runs these stages for each citation or source:
1. **Resolve.** DOI → Crossref, with DataCite as fallback. Without a DOI → OpenAlex/Semantic Scholar fuzzy match on title, year and authors, with a confidence score.
2. **Metadata consistency.** Title similarity, author surnames and year. Mismatches go to the user.
3. **Existence status:** `verified` | `mismatch` | `not_found` | `unverified` | `user_confirmed`.
4. **Retraction and corrections.** Crossref's retraction and update metadata (Retraction Watch data).
5. **Venue signals.** Indexing (via OpenAlex source metadata) and predatory-journal heuristics, shown as *signals*, never verdicts.
6. **Claim support.**
   - Retrieve the top passages for `claim_text` from the source's abstract or full text (J.1).
   - An LLM judge with a fixed rubric returns `supported | partial | contradicted | insufficient` plus a quote.
   - If only the abstract is available, "insufficient" is the honest default.
7. **Style.** citeproc-js with CSL styles (APA 7, Vancouver, IEEE, Harvard, Chicago, MLA, plus journal-specific styles).

**Policy at export:** warn on `unverified`. Block (overridable, with the override recorded) on `not_found` and `contradicted`, as configured per project.

### J.3 Statistical analysis service (item 8)

- **Engine registry.** Maps each `family` to an engine.

  | Family | Engine | Library |
  |---|---|---|
  | descriptive, ttest, anova (one-way), regression, logistic, chisq, nonparam, correlation, reliability (α) | **ts-core** (existing, bugs fixed) | `src/analysis` |
  | factorial/RM/mixed ANOVA, ANCOVA, MANOVA, Friedman/Dunn, Kendall/partial correlation, hierarchical regression | **r-engine** | `afex`/`car`/`emmeans`, `stats`, `ppcor`, `rstatix` |
  | EFA (+ KMO, Bartlett, parallel analysis, rotations), ω | r-engine | `psych`, `GPArotation` |
  | CFA, CB-SEM (ML/MLR/WLSMV, FIML, modification indices, invariance) | r-engine | `lavaan`, `semTools` |
  | PLS-SEM (PLSc, bootstrap, PLSpredict, HTMT inference, MGA, higher-order constructs) | r-engine | `seminr` (+ in-house IPMA/MGA helpers) |
  | Mediation, moderation, moderated mediation (PROCESS model equivalents 1, 4, 5, 6, 7, 8, 14, 58, 59) | r-engine | `lavaan` with defined parameters + bootstrap; simple slopes / Johnson-Neyman via `interactions` |

- **The TS core stays** because it is fast, verified and needs no infrastructure. It serves interactive previews and classical tests.
- **Parity suite.** Overlapping tests run on both engines in CI with the same fixtures, to a tolerance of 1e-6.
- **ResultBundle** (engine output, normalised):
  - `values[]`, each `{path, stat, value, df?}`, which become `result_values`;
  - `tables[]`, templated as APA, SmartPLS-style, AMOS-style or SPSS-style;
  - `figures[]`, as SVG plus data;
  - `assumptions[]`, `warnings[]`, `diagnostics[]`;
  - `engine {name, version, packages, imageDigest}`, `seed`, `script`.
- **Test advisor.** The existing `recommend.ts` is extended into a rules engine over the graph:
  - Inputs: hypothesis kind; variable scales and roles from the bindings; groups; n; distribution diagnostics.
  - Output: a recommended family with **a rationale citing methodological references** (Hair et al., Hayes, Kline, Field). The LLM only turns the rationale into prose.
- **Interpretation.** `results.interpret` produces text constrained to value tokens (G.4). Reporting templates follow APA JARS and the PLS-SEM reporting guidelines, in Arabic and English.
- **Figures.** Server-side SVG: boxplot, scatter with fit, Q-Q, interaction/simple-slopes plot, path diagram with estimates (existing layout code), forest plot, scree plot. Exported as SVG/PNG, and EMF for Word via the render worker.

### J.4 Manuscript generation engine (item 9)

- **Canonical document model.** ProseMirror (Tiptap) JSON with custom nodes: `valueRef`, `citationRef`, `tableRef`, `figureRef`, `crossRef`, `footnote`, `equation`. One model serves the editor, the agents and every exporter.
- **Templates.** A manuscript type (IMRaD paper, thesis per university, proposal, review) plus a journal profile (sections, word limits, abstract structure, CSL style, reference and figure rules).
  - The existing 13-step wizard and chapter keys become a *thesis template*, so no current content is lost.
- **Writing flow.**
  - `ms.outline` → a draft per section by the Writing agent from focus nodes (for example, Methods from instrument, sample and analysis specs).
  - Long sections are written in rounds (the existing `generateLongForm`, now metered and checking stop reasons).
  - The validator enforces value and citation tokens. The Quality gate follows.
- **Rendering** (render worker):
  - **DOCX:** the existing `docx` generator, extended with styles, a table of contents, captions and footnotes.
  - **PDF:** HTML/CSS through headless Chromium with embedded Arabic fonts (Amiri / IBM Plex Sans Arabic) for correct shaping; Typst is an alternative.
  - **LaTeX:** per-journal class templates.
  - **PPTX, XLSX:** the existing generators.
  - The bibliography comes from CSL.
- **Versions and diffs.** Block versions and manuscript snapshots (for each submission) with a visual diff. Reviewer responses link to these diffs.

### J.5 Self-verification / Quality-control agent (item 10)

- It runs as a **separate Quality specialist** with read-only tools. It is triggered:
  - at the completion gate of runs that produce manuscript or analysis output;
  - on demand;
  - before export.
- **Two tiers:**
  1. **Deterministic checks (Integrity engine, J.6):** fast, free, always on.
  2. **LLM review checks**, each with a rubric:
     - alignment of RQs, objectives, hypotheses, analysis and conclusions;
     - over-claiming (causal language from correlational data);
     - logical gaps;
     - missing limitations;
     - clarity and academic register (Arabic/English);
     - a simulated peer-review mode (Reviewer 1/2/3 personas with a journal-specific focus).
- **Findings** have the form `{severity: blocker|error|warning|info, nodeId/blockId, span, message, suggestedFix, checkId}`. Error-level findings return to the author agent, for up to 2 rounds. The rest are shown in the Integrity panel.

### J.6 Research integrity engine (item 11)

A deterministic rule library. Each rule has an ID, a version, and tests.

| Rule | Checks |
|---|---|
| TRACE-001 | Every statistic in the manuscript is a `valueRef`, or is flagged untraced. |
| TRACE-002 | Reported values belong to the latest non-superseded run, or are explicitly pinned. |
| STAT-001 | statcheck: p recomputed from the statistic and df agrees with the reported p. |
| STAT-002 | The N reported equals the N of the dataset version. |
| STAT-003 | Degrees of freedom are plausible for the test. |
| CITE-001 | Every citation resolves to a verified source. |
| CITE-002 | Claim support checked, with no `contradicted`. |
| CITE-003 | No retracted sources, or the retraction is acknowledged. |
| CITE-004 | Every entry in the reference list is cited, and every citation is listed (true by construction). |
| DESIGN-001 | Every hypothesis is tested, or explicitly deferred. |
| DESIGN-002 | Every construct has at least 3 items (for reflective constructs), or is justified. |
| DESIGN-003 | Measurement quality gates are met before structural claims (α/CR/AVE/HTMT thresholds per method). |
| HARK-001 | Hypothesis changed after results → disclosure required. |
| SELECT-001 | Unreported inferential runs → disclosure prompt. |
| AI-001 | An AI-use disclosure statement is generated from the run history. |
| LANG-001 | Causal language used with a non-experimental design. |
| SIM-001 (P3) | Similarity against retrieved sources (n-gram/embedding) for inadvertent close paraphrase. |

The output is the **Integrity Report**, stored as an artifact and exportable as PDF next to the manuscript. It lists every number with its run, every citation with its verification status, and the disclosures.

### J.7 Reproducibility engine (item 12)

- **Run manifest** for every `analysis_run`: dataset version hash, spec version, engine image digest, package versions (`renv.lock`), seed, generated script, and a result-bundle hash.
- **Package** (`repro.package`), a zip containing:
  - `README.md` (bilingual);
  - `data/` (the raw version if allowed + the cleaned version) + `codebook.csv`;
  - `transform/` (the cleaning log as an R script);
  - `analysis/` (one script per run, generated from the spec);
  - `results/` (ResultBundles, APA tables as CSV/XLSX, figures);
  - `manuscript/` (DOCX/PDF + the value map CSV `value_id, path, stat, value, manuscript_location`);
  - `references.bib`;
  - `environment/` (Dockerfile, renv.lock);
  - `integrity-report.pdf`.
- **Verify** (`repro.verify`): re-runs every script in a clean stats container and diffs the results within tolerance. Earns a "Reproduced ✓" badge.
- **Data-sharing controls.** De-identification helpers (drop direct identifiers, bin ages) and a "synthetic data" option (P3) for sensitive datasets.

### J.8 Human approval checkpoints (item 14)

Three autonomy modes (see Part II, R2). **"Always"** rows ignore the mode.

| Checkpoint | Guided | Semi-autonomous | Autopilot | Notes |
|---|---|---|---|---|
| Plan for a multi-step run | Required | Required above the cost/steps threshold | Shown; auto-continues | Editable plan |
| Agent-proposed research questions, constructs, hypotheses, model | Required | Required | Required | Research design is the researcher's intellectual contribution |
| Any change to a hypothesis after results exist | **Always** | **Always** | **Always** | HARKing guard + disclosure |
| Non-destructive data transformation (new version, nothing dropped) | Required | Auto | Auto | Always a new dataset version |
| Destructive transformation (drop rows/columns, impute, recode) and **activating** a dataset version | **Always** | **Always** | **Always** | Preview of affected rows |
| Column ↔ item bindings | Required | Auto if confidence ≥ 0.9 | Auto if confidence ≥ 0.8 | |
| Inferential analysis spec (EFA/CFA/SEM/PLS/PROCESS) | Required | Required the first time per model; auto for re-runs | Auto after the model is approved | Model canvas preview |
| Accepting agent-written manuscript blocks | Required | Accept as draft; approve per section | Accept as draft; approve per section | Track changes |
| Accepting a change whose Impact Report has `invalidates` items | Required | Required | Required | Impact Report shown first (R6) |
| Sending raw dataset rows to an LLM provider | **Always** (per-project setting) | **Always** | **Always** | Privacy |
| Budget above the plan default | **Always** | **Always** | **Always** | Cost control |
| Overriding a blocking integrity finding at export | **Always** | **Always** | **Always** | Audit-logged |
| External sharing / submission kit finalisation | **Always** | **Always** | **Always** | |
| Deleting nodes, datasets, projects | **Always** | **Always** | **Always** | Soft delete + 30-day restore |

An approval is a typed object with a **preview** (a diff, an impact report, the model diagram or a sample of rows). Users can approve, reject, or **edit and approve**; edits flow back as tool args. Expired approvals pause the run; they never fail it.

### J.9 Error recovery (item 15)

| Error class | Example | Strategy |
|---|---|---|
| Transient provider/network | 429, 5xx, timeout | Retry with backoff and jitter (3×). Then plan-aware failover to an allowed provider or model. Then pause with an explanation. |
| Tool input invalid | zod failure | `is_error` tool_result with issues. The model corrects itself (≤2). Then the step fails, and the run continues or asks. |
| Deterministic compute issue | Non-convergence, singular matrix, Heywood case, separation | A structured diagnostic goes back to the Analysis agent, which proposes a remedy (drop item, estimator change, constraints). The remedy is a new spec that needs approval. |
| Missing prerequisite | No bindings, no model | `ask_user`, or `delegate` to create the prerequisite. The stage becomes `blocked`. |
| Budget exceeded | Tokens, cost, steps, time | Pause with a progress summary and an estimate of what remains. The user can extend. |
| Worker crash / deploy | Process killed | Lease expires → another worker resumes from the last committed step. Steps are idempotent through idempotency keys. |
| Poison job | Repeated crash on the same input | After max attempts → dead-letter queue. The run fails with a user-readable message and a retry button, and an alert is raised. |
| External data degraded | Crossref down | `unchecked` status (never `not_found`), with a scheduled re-verification. |
| Model output invalid | Untraced numbers, broken citation tokens | Validator rejects → regenerate with specific feedback (≤2) → insert with flags. |

**Partial results are always saved.** A run always ends with a coherent summary of what was done and what was not.

### J.10 Background job architecture (item 16)

- **Queue: pg-boss** on the existing Postgres, so there is no new infrastructure. It provides transactional enqueue (the run row and the job in one transaction), retries, dead-letter queues, scheduling (cron for maintenance), singleton keys and throttling.
- **Queues and workers:**

  | Queue | Worker | Concurrency (initial) |
  |---|---|---|
  | `agent.run` | worker-agent | 10 per instance |
  | `stats.run` | worker-stats | CPU-bound, 1–2 per vCPU |
  | `ingest.*`, `embed.*` | worker-ingest | — |
  | `render.*` | worker-render | — |
  | `verify.*` | worker-agent | Rate-limited to the external APIs' limits |
  | `maintenance.*` | worker-agent | Cron: purge tokens, retention, re-verify stale citations, usage roll-ups |

- **Leases.** The worker sets `runs.lease_owner/lease_expires_at` and heartbeats every 15 s. The reaper re-queues runs with expired leases. No resume on cold start.
- **Waiting is free.** A run waiting on a compute job, an approval or user input holds no worker. It is re-enqueued by the event that unblocks it.
- **Per-user fairness:** a maximum of 2 concurrent agent runs and 2 heavy compute jobs per user, set by plan.
- **Observability.** Every job carries an OTel trace context from the originating request. Dashboards show queue depth, age, failure rate and cost per run.

---

## K. Frontend information architecture (item 20)

```
┌───────────┬──────────────────────────────────────────────────────────────┬──────────────────────┐
│ LEFT RAIL │ PROJECT HEADER: title · design · language · mode(Guided/Auto)│                      │
│           │ PIPELINE RAIL: Framing ▸ Literature ▸ Theory ▸ Instrument ▸  │   RIGHT PANEL        │
│ ⌂ Home    │   Data ▸ Analysis ▸ Writing ▸ Publication  (status per stage;│   (toggle)           │
│ 📁Projects│    stale/blocked badges; click = go to stage)                │  ┌────────────────┐  │
│ 📚Library │──────────────────────────────────────────────────────────────│  │ Agent          │  │
│ 🔔Inbox(3)│ TABS                                                         │  │ chat scoped to │  │
│ 🔍 ⌘K     │  Overview · Design · Literature · Instrument · Data ·        │  │ project + focus│  │
│           │  Analysis · Manuscript · Citations · Publication · Integrity │  │ run timeline,  │  │
│ Quick chat│                                                              │  │ tool calls,    │  │
│           │  (main canvas for the selected tab)                          │  │ approvals      │  │
│ ⚙ Account │                                                              │  ├────────────────┤  │
│           │                                                              │  │ Inspector      │  │
│           │                                                              │  │ selected node: │  │
│           │                                                              │  │ versions,      │  │
│           │                                                              │  │ provenance,    │  │
│           │                                                              │  │ impact, links  │  │
└───────────┴──────────────────────────────────────────────────────────────┴──┴────────────────┴──┘
```

### Tabs

| Tab | Contents |
|---|---|
| **Overview** | Pipeline map with stage cards (status, next action, open issues), project brief, recent activity, integrity health. |
| **Design** | RQs and objectives. Construct cards (definition + source). Hypotheses list. **Conceptual model canvas**, which evolves from `pls-builder` and the diagram layout: drag constructs, draw paths, mark mediators and moderators, and link hypotheses to paths. Alignment checker. |
| **Literature** | Search (multi-source), library table, **evidence matrix** (Elicit-style columns), gap map, deep-research reports, PDF reader with highlights that turn into evidence or citations. |
| **Instrument** | Questionnaire builder (items per construct, source scales, reverse-coded flag, Arabic/English side by side, back-translation check), codebook, exports (DOCX, Google Forms, KoBo). |
| **Data** | Datasets and version lineage, profiling, cleaning log (each step reversible by creating a new version), column ↔ item binding grid, missingness. |
| **Analysis** | Analysis list per hypothesis, test advisor, SEM/CFA/EFA/PROCESS configuration on the model canvas, results viewers (APA / SmartPLS / AMOS / SPSS-style tables), figures, assumptions, run comparison. |
| **Manuscript** | Outline plus editor with **value chips** (hover shows the run, path and staleness) and **citation chips** (hover shows the source, support status and quote). Track changes, comments, section status, template and journal switch. |
| **Citations** | Bibliography, verification dashboard, import/export (BibTeX/RIS/CSL), style switcher. |
| **Publication** | Journal matching shortlist with rationale, requirements checklist, cover letter, submissions and review rounds, reviewer comment ↔ response matrix with diffs, repro package. |
| **Integrity** | Integrity report, traceability explorer (click any number to see the run, dataset version and spec), graph view (filterable), disclosures. |

### Cross-cutting UI

- **Inbox:** approvals, questions from the agent, completed runs, stale warnings, across all projects.
- **Impact dialog:** appears on any edit to an upstream node and lists the affected nodes, with "Ask agent to update" or "Review each".
- **Library:** user-level sources, datasets and documents; add them to projects.
- **Quick chat:** the current `/chat` experience for non-project questions, with **"Promote to project"**, which creates a project and seeds the graph from the conversation.
- **Shared foundations:**
  - an accessible primitives set (dialog, menu, listbox with focus management);
  - `aria-live` on streams;
  - React Query;
  - one typed SSE client;
  - `loading.tsx` per route;
  - RTL icon flipping;
  - one numeral policy per locale.

---

## L. Migration strategy from the current architecture

### L.1 Principles

1. **Strangler fig.** New subsystems are introduced behind feature flags (`ff.graph`, `ff.agentV2`, `ff.rEngine`, `ff.editorV2`, `ff.workspaceV2`), first for internal accounts, then opt-in beta, then default.
2. **Backfill, don't drop.** Legacy tables stay read-only for two releases after cut-over. Every migration is idempotent and gets a verification query: row counts, checksums.
3. **Adapters.** The existing screens (wizard, tools, `/chat`) keep working against **read and write adapters** that map onto the new model, until their replacements ship.
4. **Parity gates.**
   - The R engine replaces the TS SEM code only after the parity and reference-value suites pass.
   - Agent v2 replaces the router only after a routing and quality eval set scores at least as well.

### L.2 Component mapping

| Current | Action | Target |
|---|---|---|
| Auth, billing, admin, i18n, marketing | **Keep**, harden (P0) | Same, plus RBAC and RLS |
| `research_projects` | **Extend** | + `mode`, `current_stage`, `settings`; the graph root |
| `research_sections` + `section_versions` | **Migrate** | `manuscripts` (thesis/proposal template), `manuscript_sections`, `blocks` (one paragraph block per current section, flagged `untraced` / `legacy`), version history preserved |
| Wizard (13 steps + chapters), `ai/prompts/wizard.ts` | **Adapt** | Becomes the *thesis/proposal template* + Writing skills. The wizard UI keeps working through the adapter until the Manuscript tab ships, then becomes "Guided mode". |
| `title_candidates` | **Keep** | Linked as `idea` nodes (the selected title becomes the project title) |
| `references` (project, LLM-formatted) | **Migrate** | `sources` (parsed to CSL-JSON, marked `unverified`, queued for verification) + bibliography views |
| Agent `Reference[]` in task outputs | **Migrate on read** | `sources` via `lit.add_to_library` |
| `ai_conversations` / `ai_messages` | **Extend** | `threads` (+ `project_id`, `summary`, `focus_node_id`). The AGENT/SECTION/PROJECT modes collapse into one thread type. |
| `datasets` (+ cleaned lineage) | **Migrate** | `datasets` + `dataset_versions` (existing storage keys reused, hashes computed), `dataset_columns`, `column_bindings` (empty; proposed on first use) |
| `analysis_runs` | **Migrate** | `analyses` + `analysis_runs` + `result_values`, backfilled from stored JSON where the shape is known (classical, PLS); otherwise an opaque legacy bundle flagged `untraceable` |
| `tasks` / `task_steps` + executor | **Evolve** | `runs` / `run_steps`. The executor becomes the run engine (keeps the dependency graph, budgets, claims) + leases + an agent-loop step type |
| `agent_tasks`, `analysis_jobs`, deep-research jobs | **Merge and retire** | `runs` (typed by `agent`/pipeline) |
| `handlers.ts` (16 capabilities) | **Split** | Tools (§E.3). Each handler's core logic moves into a domain service; the handler becomes a thin `ToolDef`. |
| `planner.ts` | **Replace** | Supervisor `plan.propose` (LLM with tools). Templates kept as deterministic pipelines. |
| `src/agents/*` (legacy orchestrator), `/api/agent`, `/api/ai/chat`, `chat-panel.tsx`, dead modes in `agent-chat.tsx` | **Retire** (P1) | — |
| `src/agents/keywords.ts`, `intent.ts`, router | **Reduce** | Only a thin fast-path classifier (small talk, quick answers). Everything else goes to the Supervisor. |
| `src/server/context/*` (ContextManager, envelope) | **Evolve** | Context Assembler v2 (turn order fixed, graph slice, token counting). `src/ai/context/*` retired. |
| `src/ai/*` providers, registry, router, resilient | **Evolve** — done in P1-B | Model Gateway (`src/server/ai/gateway/`: native tools, structured output, timeouts, metering, quota reservation, plan-aware failover). Vendor providers and `resilient` removed; `registry`/`model-router` return gateway-backed providers; price table kept. See `docs/phase1/P1B_REPORT.md`. |
| `src/analysis/**` (TS stats) | **Keep + fix** | ts-core engine (bugs fixed in P0). CFA/CB-SEM retired after R parity. TS PLS kept as the fast interactive preview. |
| `pls.service`, `pls-builder.tsx` | **Evolve** | SEM tools + model canvas |
| `src/server/knowledge/*`, `research/pipeline.ts` | **Keep + extend** | Literature service (add S2, PubMed, arXiv, Unpaywall; egress proxy). Deep research becomes a deterministic pipeline run by the Literature agent. |
| `files/extract.ts`, `retrieve.ts` | **Replace** | Ingest worker (GROBID/OCR) + pgvector retrieval |
| `quality/*` (claims, sources, doi) | **Evolve** | Integrity engine rules + citation verification pipeline |
| `citation/styles.ts` | **Replace** | citeproc-js + CSL. `bibliography.ts` (BibTeX/RIS) kept. |
| `generators/*` (docx, pptx, xlsx, csv, md) | **Keep** | Render worker. `pdf` replaced (Chromium/Typst with Arabic); LaTeX added. |
| `diagrams/*` | **Keep** | Model canvas rendering + figure export |
| `survey/generator.ts` + `/api/survey` | **Keep** | Instrument service (the duplicate agent path removed) |
| `/tools` (9 prompt tools) | **Adapt** | Slash-commands / quick actions in the editor and agent panel; outputs saved to the project |
| `artifacts` | **Keep + link** | Outputs linked to graph nodes; versions wired to real producers |
| `agent-chat.tsx`, `task-progress.tsx`, `sidebar.tsx` | **Refactor** | Agent panel + Activity timeline (reusing `task-progress`) + new shell |

### L.3 Data migration sequence

1. **M1 (P0):** security-related columns; `usage_events`; `runs` fields (lease, heartbeat, idempotency); pg-boss schema.
2. **M2 (P1):**
   - Graph core tables.
   - `project_members` (backfill owner = `research_projects.user_id`).
   - RLS policies (enabled in shadow/log mode first, then enforced).
3. **M3 (P1):**
   - `sources`, `chunks`, `citations`, backfilled from `references`.
   - `threads` columns.
   - `memories`, `thread_summaries`.
4. **M4 (P1–P2):**
   - `datasets` → `dataset_versions` / `columns`.
   - `analysis_runs` → `analyses` / `analysis_runs` / `result_values`.
   - `tasks` → `runs`.
   - `agent_tasks` / `analysis_jobs` archived.
5. **M5 (P2):**
   - `research_sections` → `manuscripts` / `sections` / `blocks`.
   - The wizard's write adapter switches to blocks, while the legacy table is kept in sync (dual-write) for one release.
6. **M6 (P2–P3):** publication and repro tables; `organizations`.

**Rollback:** each step keeps the legacy table authoritative until its flag flips. Flipping the flag back restores the old read path.

---

## M. Development roadmap (phased)

| Phase | Weeks (2–3 engineers) | Theme | Exit criteria |
|---|---|---|---|
| **0: Stabilise** | 1–5 | Audit P0: security, statistics correctness, durable jobs (pg-boss + worker), CI, Sentry, broken chat controls | CI green; no 🔴/🟠 security issues open; SEM parity bugs fixed with reference tests; runs survive deploys |
| **1: Foundations** | 6–13 | Graph core + RBAC/RLS · Model Gateway with native tools · Tool Registry · Run engine v2 (agent loop, approvals, outbox events) · Context Assembler v2 · consolidate legacy paths | One agent stack; approvals work end to end; `graph.*` tools live; legacy `/api/agent`, `/api/ai/chat` retired |
| **2: Research design + Literature** | 12–20 | Framing/Theory stages on the graph · Design tab + model canvas · ingest worker (GROBID/OCR/pgvector) · Literature agent (S2/PubMed/arXiv/Unpaywall, snowballing, evidence matrix, gaps) · citation engine (CSL, import/export, verification pipeline) | Idea → RQ → gap → constructs → hypotheses → model, all as graph nodes with sources; impact analysis on construct edits |
| **3: Instrument + Data + Analysis** | 18–28 | Instrument builder · dataset versions/bindings/recoding · **R stats worker** (EFA, CFA, CB-SEM, PLS-SEM full, PROCESS models, extended ANOVA family) · ResultBundle → result nodes · test advisor v2 · figures | Questionnaire → data → EFA/CFA/SEM/mediation/moderation producing traceable result values; parity with lavaan/seminr references |
| **4: Manuscript + Integrity** | 26–36 | Editor v2 (Tiptap, value and citation chips) · Writing agent with validators · Quality agent · Integrity engine rules · Arabic PDF/LaTeX rendering · Workspace v2 IA | A Results section where every number is traced; Integrity Report exported; export blocked on contradicted citations |
| **5: Publication + Reproducibility** | 34–44 | Journal matching + requirements · cover letter · reviewer-response workflow with diffs · repro package + verify | Full pipeline demo from idea to repro package on a real thesis dataset |
| **6: Scale** | 44+ | Collaboration and supervisor mode · organisations/SSO · integrations (Zotero, Overleaf, Word add-in) · similarity check · evaluation harness · survey hosting | University pilot |

---

## N. P0 / P1 / P2 / P3 implementation plan

Each epic lists deliverables, acceptance criteria (AC) and dependencies. Sizes are S ≤3 days, M 1–2 weeks, L 3–5 weeks, XL 6+ weeks.

### P0: Stabilise (from the audit, aligned with the target)

| Epic | Deliverables | Acceptance criteria | Size |
|---|---|---|---|
| P0-A Security fixes | Next and dependency upgrades; `listMessages` scoped by user; email verification; owner via DB role; linking off; token_version + short JWT; login rate limit; trusted IP; Redis limiter; SSRF redirect/IPv6 fixes; decompression caps; health lockdown; CSP without `unsafe-eval` | `npm audit` has no high/critical; route-level IDOR tests; tests for suspension and demotion; SSRF test matrix including `[::ffff:…]` and redirects | M–L |
| P0-B Statistics correctness | `toNumber` + listwise deletion in SEM; exact CFA null model; information-matrix SEs (or CFA hidden behind a "preview" label until the R engine); aligned HTMT/cross-loadings; Q² relabelled "in-sample" until standard Q² exists; honest df; Heywood check | Reference fixtures (lavaan/seminr outputs committed as JSON) pass within tolerance; blank-cell regression test | M |
| P0-C Durable execution | pg-boss; `worker-agent` service; leases and heartbeats; reaper; bootstrap moved to a worker thread; no resume on cold start; `maxDuration` fixes | Kill-worker test resumes without duplicates; the bootstrap does not block `/api/health` | L |
| P0-D AI-layer safety | Timeouts; one metered gateway call path; plan-aware failover; sanitised errors; Anthropic stream errors and stop reason handled; chapters via long-form | Every model call writes `usage_events`; a free-plan user never reaches a premium model in tests | M |
| P0-E Chat and routing fixes | Message IDs in the stream; `modelId`/`roles`/`regeneratedParentId` honoured; reference-conversion bug; `pls` regex; `userAnswers`/`continueFrom`; citation numbering | e2e: regenerate, edit, role picker, model selection; "run a t-test on my data" performs the analysis | M |
| P0-F Hygiene and operations | Delete stray files; GitHub Actions (typecheck, lint, smoke, analysis, integration with Postgres, Playwright smoke); Sentry; S3/R2 required in production; seed only inserts missing rows; DEPLOY.md updated | CI required on `main`; errors visible in Sentry; deploy guide produces a working instance | M |

### P1: Foundations (platform for the traceable research agent)

| Epic | Deliverables | Acceptance criteria | Depends on | Size |
|---|---|---|---|---|
| P1-A Graph core | `graph_nodes`, `node_versions`, `graph_edges`, `stale_marks`; graph service (create/update/link/impact/trace); `project_members` + RLS; `/api/v1` graph routes | Impact on a construct change returns the right hypotheses, items, runs and blocks in fixture projects; RLS blocks cross-project reads in tests | P0-A | L |
| P1-B Model Gateway | Adapters with native tool calling + structured output; token counting; prompt caching; metering; traces. **As built:** `src/server/ai/gateway/`, tables `ai_usage_events`, `ai_quota_reservations`, `ai_tool_calls` (`P1B_REPORT.md`) | Same tool schema works on 2+ providers; cost per run visible | P0-D | L |
| P1-C Tool Registry + policy engine *(re-scoped 2026-09-23: P1-C delivered the deterministic statistics engine, dataset versions and graph integration with the 7 `stats` tools; the general registry and policy engine move to P1-D — see `docs/phase1/P1C_REPORT.md`)* | `ToolDef`, registry, scopes, approval policies, idempotency; first 25 tools (graph, plan, lit.search, retrieve, stats.run (ts-core), results, citation.insert/format) | Policy unit tests; every tool call visible in the activity timeline | P1-A, P1-B | L |
| P1-D Run engine v2 | Agent loop step type, parked waits, approvals API, answers API, outbox events, SSE with resume, sub-runs (`delegate`) | Supervisor completes a multi-tool goal; approval pauses and resumes across worker restarts | P0-C, P1-C | XL |
| P1-E Context and memory | Context Assembler v2, Project State Snapshot, thread summaries, memories (user/project) with UI | Turn order correct; the snapshot is always present; memories editable | P1-A | M |
| P1-F Consolidation | Retire `/api/agent`, `/api/ai/chat`, legacy orchestrator, `chat-panel`, dead modes; merge job tables into `runs`; keyword router reduced to the fast path | No references to the retired modules; e2e green | P1-D | M |
| P1-G Ingest + retrieval | Ingest worker (GROBID, pdf text, OCR ara+eng, DOCX/PPTX), chunks + pgvector + FTS, hybrid search, PDF/DOCX upload in the composer | Arabic PDF extraction eval ≥ target; retrieval eval (recall@10) ≥ target on an Arabic/English set | P0-C | L |
| P1-H Citation engine | `sources` (CSL-JSON), import BibTeX/RIS, citeproc-js styles, verification pipeline (resolve, retraction, venue signals), migration of `references` | Formatted output matches CSL test fixtures; DOI/DataCite resolution; retracted-paper fixture detected | P1-A | L |
| P1-I Workspace v1 | Project workspace shell (pipeline rail, tabs skeleton, agent panel, inspector, inbox); Quick chat with promote; React Query; accessible primitives | Existing features reachable in the new IA; mobile and RTL checks pass | P1-D | L |

### P2: The research pipeline and the moat

| Epic | Deliverables | Depends on | Size |
|---|---|---|---|
| P2-A Design stage | RQ/objective/gap/construct/hypothesis nodes and tools; model canvas; alignment checker; impact UI | P1-A, P1-C | L |
| P2-B Literature agent | S2/PubMed/arXiv/Unpaywall, snowballing, evidence extraction (abstract + OA full text), evidence matrix, gap map, deep research as a pipeline | P1-G, P1-H | L |
| P2-C Instrument | Scale finder, item drafting per construct, translation and back-translation, codebook, exports (DOCX/XLSForm/Forms), merged survey paths | P2-A | M |
| P2-D Data v2 | Dataset versions, bindings grid, recode/reverse-code/compute scores, `.sav`/`.xls` import, missingness report | P1-A | M |
| P2-E R stats worker | Container, plumber API, ResultBundle, parity suite; EFA, CFA/CB-SEM, PLS-SEM (seminr), PROCESS models, extended ANOVA family, figures | P0-C, P2-D | XL |
| P2-F Analysis agent + advisor | Test advisor v2 with rationale and citations, `sem.build_from_graph`, interpretation constrained to value tokens, APA/SmartPLS/AMOS/SPSS table templates | P2-E, P1-D | L |
| P2-G Manuscript engine | Tiptap editor with value/citation chips, templates (thesis per university, IMRaD, journal profiles), Writing agent + validators, render worker (DOCX+, Arabic PDF, LaTeX) | P1-H, P2-F | XL |
| P2-H Quality + Integrity | Quality agent, integrity rules (TRACE/STAT/CITE/DESIGN/HARK/SELECT/AI/LANG), Integrity Report, export policy | P2-G | L |
| P2-I Publication | Journal matching (OpenAlex venues + embeddings), requirements checker, cover letter, reviewer-comment parsing, response matrix with diffs | P2-G | L |
| P2-J Reproducibility | Manifests, package builder, verify job, de-identification helpers | P2-E, P2-G | M |

### P3: Scale and ecosystem

| Epic | Deliverables | Size |
|---|---|---|
| P3-A Collaboration and supervisor mode | Members and roles UI, comments, review requests, supervisor dashboard | L |
| P3-B Institutions | Organisations, SSO (OIDC/SAML), seat billing, institution templates, admin analytics | XL |
| P3-C Integrations | Zotero sync, Overleaf export/sync, Word add-in, Google Docs export, MCP server exposure | L |
| P3-D Data collection | Hosted surveys from the instrument (or connectors to Google Forms/KoBo/Qualtrics), responses straight into dataset versions | L |
| P3-E Similarity and paraphrase integrity | Local similarity against retrieved sources; optional institutional provider integration | L |
| P3-F Evaluation harness | Golden projects; evals for routing, grounding, citation precision, statistics parity, Arabic writing quality; regression dashboards | M |
| P3-G Code sandbox | Isolated Python/R notebook for ad-hoc analyses, outputs as ResultBundles | L |

---

## O. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Scope.** The full pipeline is large. | Phases each ship a usable slice. Phase 2 alone (design + literature on the graph) is already differentiated. |
| **Complexity of the R worker.** | One container, a spec-only interface, parity tests; the TS core remains the fallback for classical tests. |
| **Graph over-engineering.** | Typed tables for the domain; the generic edge table only for relationships; staleness rules are data-driven and unit-tested. |
| **Agent cost.** | Tiered models, prompt caching, deterministic pipelines where possible, per-run budgets and quota reservation. |
| **Arabic quality** (OCR, PDF shaping, embeddings). | Explicit Arabic evaluation sets with bake-off gates before choosing components. |
| **User trust in automation.** | Guided mode by default; approvals on research-design decisions; everything traceable and reversible. |
| **Migration regressions.** | Feature flags, adapters, dual-write windows, legacy tables read-only for 2 releases, e2e suites per phase. |

---

## P. Approval record

- **Approved (2026-09-23):**
  - D3: one Supervisor + four specialists (Literature, Analysis, Writing, independent Quality).
  - D4: PostgreSQL + pgvector as the system of record and the semantic-search layer.
  - D5: pg-boss + separate worker services.
  - A separate R statistics service for EFA, CFA, CB-SEM, PLS-SEM, mediation, moderation and moderated mediation. The TypeScript engine stays for classical statistics.
- **Added as binding requirements:** R1–R10 (Part II below). Where Part II and Part I disagree, Part II wins.
- **Authorised to start:** P0 only (see `docs/p0/P0_PLAN.md`). Phase 1 starts after P0 is completed, tested and documented.

---

# Part II — Binding requirements R1–R10

## R1. Academic AI is a Research Operating System

The product is not "a chat assistant plus academic tools". The **Research Project** is the unit of intelligence, and every capability reads from and writes to its persistent state.

The canonical research chain is stored in the Research Graph (§G):

```
Research Question → Literature → Research Gap → Theory → Constructs → Variables → Hypotheses →
Conceptual Model → Questionnaire → Dataset → Analysis → Results → Manuscript → Citations →
Journal → Submission → Reviewer Comments → Revisions
```

Additions to the graph:

| Chain link | Node types | Key edges |
|---|---|---|
| Theory | ★ `theory` (name, core propositions, sources) | `construct —derived_from→ theory`, `hypothesis —grounded_in→ theory`, `theory —defined_by→ source` |
| Submission | `submission` (journal, date, manuscript@version, status) | `submission —of→ manuscript@v`, `submission —to→ journal_target` |
| Reviewer comments | `reviewer_comment` (round, reviewer, text, category) | `reviewer_comment —about→ block \| analysis \| citation` |
| Revisions | ★ `revision` (a manuscript version created in response to a round) | `revision —addresses→ reviewer_comment`, `revision —changes→ block@v`, `revision —of→ manuscript` |

**Reasoning across the whole state.** Every agent turn gets the Project State Snapshot (§F.3), which covers every link of the chain. The `graph.neighbors`, `graph.trace` and `graph.impact` tools let the agent walk any path. Example: "Why is H3 not supported?" gives Supervisor → `graph.trace(H3)`: hypothesis → model path → analysis run → result values → the dataset version and its cleaning steps → the literature grounding. The answer cites each hop.

**What the project root owns:** the project settings (design, language, autonomy mode, privacy, citation style), members, the stage table, the decision log, the project brief, and the graph. Conversations are views onto a project (threads). They are not containers of state.

## R2. Three autonomy modes

`research_projects.autonomy_mode ∈ {guided, semi_autonomous, autopilot}`. The default is `guided`. It can also be overridden per run: a user can start one run in Autopilot on a Guided project, and the run records the mode it used.

| Mode | Behaviour |
|---|---|
| **Guided** | The agent proposes; the user decides. Every plan and every state-changing tool call needs approval. The agent explains each step. For learners and first projects. |
| **Semi-autonomous** | Reading, searching, computing and drafting run without asking. State changes to *research design*, destructive data operations, first-time inferential specifications and final acceptance of manuscript content need approval. For most researchers. |
| **Autopilot** | Runs whole workflows end to end. It stops only at the **Always** checkpoints, at budget ceilings, and for questions it cannot resolve. For experienced researchers who review at the end. |

**Mechanism.** `Policy.evaluate(tool, args, ctx)` returns `allow | needs_approval | deny` from three things:
1. The tool's `sideEffect` and `approval` class (§E.1).
2. A per-mode matrix (§J.8).
3. **Hard rules that ignore the mode**:
   - hypothesis change after results;
   - destructive data change or dataset activation;
   - raw data to an LLM;
   - budget increase;
   - integrity override;
   - external sharing or submission;
   - deletion;
   - accepting a change with `invalidates` impact.

**Policy and audit.** The policy is data (`policy_rules` table plus code defaults) and is unit-tested per mode. Every automatic decision is logged in `run_steps` with the rule that allowed it, so an Autopilot run stays auditable.

## R3. Multimodal architecture

Multimodality is part of the core design, built on two abstractions.

**1. Assets and representations (ingestion side).** Every upload is an `asset` (original bytes in S3, hash, MIME, owner, project). Ingestion produces typed **representations**, each with provenance: extractor, version, confidence.

| Input | Representations produced |
|---|---|
| PDF (born-digital) | `text` (per page, with layout and reading order), `structure` (GROBID TEI: sections, references, figures, tables), `table` (extracted tables as JSON), `figure` (cropped image + caption) |
| Scanned PDF / image of a page | `ocr_text` (Tesseract ara+eng, per page + confidence), `layout`, `table` (table-structure recognition), `page_image` |
| DOCX | `text` + `structure` (headings, lists, footnotes), `table`, embedded `figure` |
| PPTX | per-slide `text`, `notes`, `slide_image` (rendered), embedded `figure`/`chart` |
| XLSX / CSV / SAV | `dataset` (goes to the data pipeline → `dataset_version`) + `sheet_preview` |
| Image (chart / figure) | `image`, `vision_description`, optional `chart_data` (extracted series, **flagged approximate**) |
| Statistical-output screenshot (SPSS/AMOS/SmartPLS tables) | `ocr_text`, `stat_table` (parsed values), **tagged `transcribed`**: never treated as a computed result; the integrity engine labels it "transcribed from image — verify or re-run" |
| SEM / path diagram (image) | `vision_description`, `model_spec_proposal` (constructs, paths). It becomes **draft** graph nodes that need approval |
| Research figures | `image` + `caption` + `vision_description` |

Retrieval (§J.1) indexes representations, not files, so a table extracted from a scanned page is searchable like any text. All representations share one schema:

```
assets(id, owner, project, sha256, mime, storage_key, pages, status)
asset_representations(id, asset_id, kind, page, bbox, content jsonb|text, extractor, extractor_version,
                      confidence, derived_from_representation_id)
```

A new modality needs only a new extractor and a new `kind`.

**2. Content parts and capabilities (model side).** The Model Gateway message type is a union:

```ts
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: AssetRef | Bytes; mime: string; detail?: 'low' | 'high' }
  | { type: 'document'; source: AssetRef; pages?: [number, number] }   // native PDF input where supported
  | { type: 'table'; data: TableJson; caption?: string }                // structured, provider-agnostic
  | { type: 'tool_result'; ... };
```

Each registered model declares **capabilities**: `{ vision, nativePdf, maxImages, maxImageBytes, toolCalling, structuredOutput, contextTokens, languages }`.

- **Capability routing.** The gateway picks a model that satisfies the request's required capabilities, within the user's plan.
- **Graceful degradation.** If no allowed model has vision, image parts are replaced by their text representations (OCR, description, table JSON), with a notice.
- **Provider mapping.** Adapters convert `ContentPart` to each provider's format. Adding a multimodal model means adding an adapter and a capability declaration. Agents, tools, graph and ingestion do not change.

**Integrity rule for multimodal inputs.** Anything extracted from an image (numbers from a screenshot, series from a chart, a model from a diagram) is an *extracted observation* with a confidence value. It can seed a draft or be compared against computed results. It can never be reported in a manuscript as if the platform had computed it (see R4, TRACE-003).

**Phasing.**
- The P0 gateway refactor keeps the existing text path.
- P1 introduces `ContentPart` and capability declarations.
- P1-G ingests PDF/DOCX/PPTX/scans.
- P2-L adds images, charts, statistical screenshots and SEM diagrams.

## R4. Research Integrity is a first-class subsystem

**What makes it first-class.** Integrity is a **domain service** (`src/server/domain/integrity`) with its own tables:
- `integrity_rules` (versioned);
- `integrity_checks` (a run of rules over a scope);
- `integrity_findings` (with location, severity, status and resolution evidence);
- `integrity_reports`.

It is not a prompt. Every other subsystem emits the facts it needs (provenance, versions, verification results). The integrity engine evaluates them. The Quality agent (R8) consumes its findings and adds judgement-based checks.

| Required coverage | Rule(s) | Mechanism |
|---|---|---|
| Statistical traceability | TRACE-001/002 | `valueRef` inline nodes; validator rejects free-typed statistics in AI text |
| Unsupported numbers | TRACE-001, TRACE-003 | Untraced or image-transcribed numbers flagged; `integrity.trace` proposes links |
| Citation traceability | CITE-000 | Every citation is a `citationRef` → `citation` node → `source` node; the bibliography is generated |
| Source verification | CITE-001 | Resolution against Crossref/DataCite/OpenAlex/S2; metadata consistency |
| DOI verification | CITE-001a | DOI resolves, and the metadata matches |
| Retraction checking | CITE-003 | Crossref update/retraction metadata (Retraction Watch data); scheduled re-checks |
| Claim-to-source support | CITE-002 | Evidence retrieval + rubric judge → supported/partial/contradicted/insufficient + quote |
| Unsupported citations | CITE-002, CITE-004 | `insufficient`/`contradicted`/unverified flagged; blocking policy at export |
| Sample-size consistency | STAT-002 | Reported N == `dataset_version.n_rows` after exclusions used by that run |
| Statistical recalculation | STAT-001, STAT-003 | statcheck-style p recomputation from statistic and df; df plausibility; CI/estimate/SE coherence |
| Hypothesis/result consistency | HYP-001 | The text's "supported/not supported" for each hypothesis must match the decision rule applied to its `tests` result values (p/CI, direction) |
| HARKing detection | HARK-001 | Hypothesis version timestamps vs `first_seen_results_at` |
| Selective reporting | SELECT-001 | Inferential runs with no `reports` edge → disclosure prompt; multiplicity count per hypothesis |
| Data lineage | LINEAGE-001 | Every run's dataset version has a complete `derived_from` chain to an uploaded asset, with a transform log |
| Analysis reproducibility | REPRO-001 | A run has a manifest (engine digest, packages, seed, script); `repro.verify` status |
| AI-generated content disclosure | AI-001 | Block-level `authored_by` + run history → generated disclosure statement; share of AI-drafted text per section |
| Version history | VERSION-001 | `node_versions` / block versions immutable; the Integrity Report lists the version of every reported object |

**Guarantees (enforced in code, tested in CI):**
1. An AI-generated manuscript block cannot be saved with a statistic that is not a `valueRef`, unless the user explicitly marks it (and it stays flagged).
2. An AI-generated citation cannot be saved unless it resolves to a `source` node. Its claim-support status is computed asynchronously and shown.
3. Export checks the project's integrity policy. Blocking findings need an audit-logged override.

## R5. Benchmarking and Evaluation Engine

**Purpose.** Every significant change (architecture, prompt, model, provider, engine) can be regression-tested against fixed, versioned benchmarks, with pass/fail gates.

**Structure:**

```
evals/
  suites/<suite>/suite.yaml         # metadata, metrics, thresholds, tier (fast|nightly|release)
  suites/<suite>/cases/*.json        # inputs + expected outputs / rubrics
  fixtures/datasets/*.csv            # public or synthetic datasets
  fixtures/references/*.json         # engine reference outputs (lavaan, seminr, psych, SciPy)
  rubrics/*.md                       # LLM-judge rubrics with anchored examples (AR + EN)
src/evals/
  runner.ts   metrics/*.ts   judges/*.ts   report.ts
DB: eval_runs(id, suite, git_sha, config{models, prompts_hash, engines}, started, finished)
    eval_results(run_id, case_id, metric, value, passed, artifacts_key)
```

| Metric family | Suite | How it is measured |
|---|---|---|
| Statistical accuracy | `stats-parity` | TS and R engines vs reference outputs within tolerance, per statistic |
| Data-analysis correctness | `analysis-e2e` | Dataset + question → the chosen test family matches expected; the numbers match references; assumptions are reported |
| Citation accuracy | `citations` | Precision of resolution (DOI/title → correct work); fabricated-reference rate; correct CSL formatting against the CSL test suite |
| Source retrieval accuracy | `retrieval-ar-en` | Labelled queries (Arabic, English, cross-lingual) → recall@10, MRR, nDCG |
| Multilingual retrieval | `retrieval-ar-en` (cross-lingual split) | AR query → EN docs and the reverse |
| Hallucination rate | `grounding` | Untraced-number rate, unsupported-claim rate (claim-support judge), invented entities |
| Tool selection accuracy | `agent-tools` | Scripted goals → expected tool sets/orders (partial-order match), unnecessary-call rate |
| Research planning quality | `planning` | Rubric judge: coverage, ordering, feasibility + expected-step recall |
| Literature-review quality | `litreview` | Rubric judge (synthesis vs summary, coverage, gap articulation) + citation support rate |
| Manuscript quality | `manuscript` | Rubric judge per section (APA/JARS adherence, clarity, argument), plus integrity-rule pass rate |
| Arabic academic quality | `lang-ar` | Rubric judge calibrated on human-rated Arabic academic samples; register, terminology, grammar |
| English academic quality | `lang-en` | Same, English |
| Latency | all suites | p50/p95 per step and per run, from traces |
| Token usage / cost per task | all suites | From `usage_events`, per case and suite |
| Agent reliability | `agent-e2e` | Success rate, recovery rate after injected faults (provider 5xx, worker kill), duplicate-execution count (must be 0) |

**LLM judges:**
- use a fixed judge model, versioned rubrics and anchored examples;
- judge-human agreement is measured on a calibration set and must stay ≥ 0.7 (Cohen's κ or Spearman) for a suite to gate;
- judges never evaluate their own outputs (judge model ≠ author model where possible).

**Tiers and gates:**

| Tier | When | Contents |
|---|---|---|
| **Fast** | Every PR | Deterministic suites (stats parity, citations formatting, policy, graph impact); agent suites with recorded model responses (cassettes) |
| **Nightly** | Scheduled | Live models; full suites; trends |
| **Release / model-change** | On demand | Compare against the last accepted baseline; fail on regression beyond thresholds (e.g. stats parity must be 100%; citation precision −1pt; hallucination +0.5pt; cost +15%) |

Every eval run records `git_sha`, provider/model IDs, prompt hashes and engine digests. Results are shown in an admin **Evaluation dashboard**.

**In P0:** the reference-value tests for the statistics fixes (lavaan outputs committed as JSON fixtures) are the first `stats-parity` cases. CI runs them on every PR.

## R6. Research Graph impact analysis

Impact analysis (§G.3) is **automatic on every write** to an upstream node, and available as a **dry run** before the write. Accepting a *major* change (any downstream item with severity `invalidates` or `review`) requires the user to see the **Impact Report** first; the API refuses the write without `impactAcknowledged: <reportHash>`.

| Changed object | Downstream objects flagged (severity) |
|---|---|
| **Construct** (definition, kind, items) | Hypotheses relating it (review), model elements representing it (invalidates if kind/items changed), instrument items measuring it (review), analyses specifying the model (invalidates), their runs and result values (invalidates), manuscript blocks describing it or reporting those values (review/invalidates), citations supporting its definition (review) |
| **Hypothesis** | Model element it posits (review), analyses testing it (invalidates if kind/direction changed), result-to-hypothesis decisions (invalidates), Results/Discussion blocks (review); HARK-001 re-evaluated |
| **Questionnaire item** | Column bindings (review), construct measurement (review), dataset versions collected with the old wording (info: wording drift), analyses using the item (invalidates if reverse-coding/scale changed), codebook, Methods blocks (review) |
| **Dataset column** (binding, type, recode) | Transform steps after it (invalidates), dataset versions derived (invalidates), analyses/runs using it (invalidates), result values and reporting blocks (invalidates) |
| **Dataset version** (new active version) | Every run on the previous version (review: "superseded data"), blocks reporting those runs (review), STAT-002 sample-size checks (re-run) |
| **Statistical model / analysis spec** | Runs of the old spec version (invalidates), result values (invalidates), tables and figures (invalidates), reporting blocks (invalidates), hypothesis decisions (invalidates) |
| **Analysis result** (a new run supersedes an old one) | Blocks reporting old values (review: "newer run exists"), tables/figures (review), Integrity Report (re-run) |
| **Citation** (source changed, retracted, support changed) | Blocks citing it (review; invalidates if retracted or contradicted), hypotheses grounded in it (review), the bibliography (regenerated) |
| **Manuscript section** | Abstract/Conclusion blocks derived from it (review), cross-references (review), submission snapshots (info), response-to-reviewer entries pointing at changed blocks (review) |

**Implementation:**
- Edge semantics are data: `edge_rules(rel, src_type, dst_type, change_kind → severity)`. That keeps the propagation logic generic and testable.
- `change_kind` is computed by a per-type diff function (e.g. `construct.definition` vs `construct.items`), so cosmetic edits (typo fixes) produce `info` only.
- The Impact Report is stored, hashed and linked to the resulting node version for audit.

## R7. Preserve existing functionality

These are non-negotiable through every phase. Each has e2e/integration coverage that must stay green:

authentication · billing · admin · Arabic/English · wizard · chat · dataset upload · classical statistics · PLS · diagrams · exports · deep research.

**Mechanism** (from §L):
- strangler migration and feature flags (`ff.*`, defaulting to the legacy path);
- additive, non-destructive DB migrations only (no drops or renames of live columns while a legacy reader exists);
- legacy tables read-only for ≥2 releases after cut-over;
- per-area rollback by flag.

The P0 plan applies the same rule: every change is additive or a bug fix behind the existing interface.

## R8. Quality agent independence

The Quality agent is a *verifier*, not a second opinion from the same context.

| Property | Design |
|---|---|
| **Read-only** | Its tool allow-list contains only `graph.get*/search/trace`, `retrieve.*`, `citation.resolve`, `integrity.*` (read and compute), `stats.recompute` (deterministic recalculation). Its only write is `findings.create`. This is enforced by the policy engine, and it does not rely on the prompt. |
| **Independent context** | It never receives the author agent's transcript, reasoning or tool outputs. Its context is built fresh from the persisted graph (claims, values, citations, sources) and the artifact under review. |
| **Independent evidence** | Statistics: recomputed from stored result values and the dataset version (statcheck, N, df, direction), never taken from the author's prose. Citations: sources re-retrieved and claim support re-judged. Methodology: checked against the analysis spec and design rules (e.g. measurement quality before structural claims), not against what the author said it did. |
| **Model diversity** | Configurable `quality.model`. It defaults to a different model (and, where available, a different provider family) from the author model. Temperature 0. |
| **Structured output** | Findings `{rule_or_rubric, severity, location, evidence (value IDs, chunk IDs, quotes), suggested_fix}`. A finding without evidence is downgraded to `info`. |
| **Closing the loop** | Authors can't close findings. A finding is resolved only when the verifier re-checks it and it passes, or when the user overrides it (audit-logged). |
| **Scope** | Statistical claims, citations, methodology, internal consistency (RQ ↔ objectives ↔ hypotheses ↔ analyses ↔ conclusions), research design, manuscript claims (over-claiming, causal language), traceability. |

## R9. Model and provider neutrality

- **One gateway interface.** All model access goes through the gateway: `complete`, `stream`, `callWithTools`, `embed`, `judge`. No domain code imports a provider module.
- **Adapters.** Per provider (current: Anthropic, OpenAI, Google), each with a **capability declaration** (R3) and a price table entry.
- **Native tool calling preferred.** Where a model lacks it, the adapter falls back to schema-constrained structured output that produces the same `ToolCall` type.
- **Configuration.** Model choice by *role* (`planner`, `writer`, `extractor`, `judge`, `embedder`, `quality`) in admin configuration, not by provider name in code. Routing respects plan tier, required capabilities, data-residency/privacy settings and health.
- **Testing.** Provider-contract tests per adapter (tool calls, streaming, errors, stop reasons). Eval suites (R5) run per candidate model before a role mapping changes.
- **No provider-specific features in core logic.** Prompt caching and similar optimisations live inside adapters.

## R10. Implementation principle

```
GENERAL AI   = conversation + tools
ACADEMIC AI  = persistent research state + research graph + tools + statistics engines
               + evidence + citations + integrity + reproducibility + autonomous research workflows
```

Every roadmap item is judged by whether it strengthens the right-hand side. Features that only make Academic AI a better general chatbot are lower priority than features that deepen state, traceability, evidence or verified computation.
