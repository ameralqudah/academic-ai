# P1-A Research Graph: formal review

> **Status:** the findings F-1 to F-13, F-16, F-17, F-20 and F-24 were fixed in P1-A.1, and F-11's relations were added; see `docs/phase1/P1A_HARDENING_REPORT.md`. The gap tests described in §7 now live in `test:graph` (in CI), and `scripts/graph-gaps.ts` was removed.

**Date:** 2026-09-23 · **Scope:** commits `4800f33` and `e6ba872` (local branch, **not pushed, not merged**). The code reviewed is `src/server/graph/*`, `src/app/api/v1/projects/[projectId]/*`, migration `0011_p1a_research_graph` and the graph tables in `src/server/db/schema.ts`.
**Measured against:** `docs/architecture/TARGET_ARCHITECTURE.md` §C, §G, R1–R10, and the goal of a research platform whose numbers and claims can be trusted.
**Method:** code reading, then one executable test per suspected gap. `npm run test:graph:gaps` (`scripts/graph-gaps.ts`) asserts the behaviour the platform needs. **All 24 checks fail today, confirming 12 findings (F-1 to F-12).** The script is deliberately not in CI while the gaps are open. As each finding is fixed, its checks move into `test:graph`, which is in CI. Findings F-13 to F-24 are design findings with no test.

**Verdict.** The foundation is sound:

- the tables and their shape;
- versioned nodes and the Impact Report acknowledgement;
- application-level isolation between projects;
- the rule-driven, testable impact engine.

It is **not ready to be switched on**. The most serious problems are these:

- Under ordinary use, an old analysis or manuscript number can **appear current without any warning** (F-1 to F-5).
- Numbers the platform presents as "traced" can be **typed in or edited by hand** (F-6, F-7).

All of these can be fixed cheaply now: migration 0011 has never been deployed, and the graph tables hold no production data. The fixes can go into the P1-A PR itself, **before P1-B**.

---

## 1. Research Graph semantics

### 1.1 Coverage of the nine R6 object types

| R6 object | Node type(s) | Relations that reach it | Assessment |
|---|---|---|---|
| Construct | `construct` | `measures`, `represents`, `relates`, `about`, `describes`, `defined_by` | ✅ Covered. The link to the research question is missing (F-11). |
| Hypothesis | `hypothesis` | `specifies`, `tests`, `describes`, `posits`, `relates`, `grounded_in` | ✅ Covered. The link to the research question is missing (F-11). |
| Questionnaire item | `instrument_item`, `instrument` | `measures`, `has_item`, `binds`, `describes`, `adapted_from` | ✅ Covered. The item → model-element (indicator) link is missing (F-11). |
| Dataset column | `dataset_column`, `transform_step` | `binds`, `includes`, `applies_to` | ⚠️ There is no analysis → column link, so every column change invalidates every run on that version (F-11). |
| Dataset version | `dataset_version` | `uses_data`, `derived_from`, `transformed_by`, `collected_with` | ❌ Content is editable in place (F-6). |
| Statistical model / analysis | `conceptual_model`, `model_element`, `analysis` | `contains`, `represents`, `specifies`, `executes` | ❌ `model_element` has no schema, so structural model changes are classified as substantive (F-9). Paths are not linked to their ends (F-11). |
| Analysis result | `analysis_run`, `result_value`, `result_table`, `figure` | `produced_by`, `tests`, `reports`, `interprets` | ❌ Results can be typed in by hand and edited (F-6). There is no table → value link (F-11). |
| Citation / source | `citation`, `source`, `evidence` | `of_source`, `cites`, `grounded_in`, `about`, `extracted_from` | ✅ Retraction and contradiction behave correctly. |
| Manuscript section | `section`, `block` | `summarizes`, `refers_to`, `changes`, `snapshot_of` | ❌ A change to a block's text never reaches the section, so the abstract is not flagged (F-10). |

### 1.2 Is the propagation rule academically correct?

**The rule.** `invalidates` propagates. `review` and `info` stop at the object they flag. Three exceptions:

- containers (questionnaire → items, model → elements) pass their part's change through;
- `supersede` passes review all the way down;
- `tests` never propagates.

**Invalidation is transitive by derivation: correct.** A coefficient estimated on data that has since been recoded, or from a specification that has since changed, is not a result of the current study. Anything computed from it, or reporting it, inherits that. This matches how reproducibility is judged: an output is valid only if every input it was computed from is the input now claimed.

**Stopping `review` is correct as a decision rule, but incomplete as a display rule.**

- *Why stopping is right:* "review" means a person must judge whether the change matters. A revised construct definition may or may not change content validity. If the judgement is "no change needed", nothing downstream is affected. If the answer is to change the object, that edit runs its own impact analysis. Propagating review would flag entire projects for a wording tweak, and researchers would learn to click through the warnings.
- *What it misses:* while a question is open, everything derived from the object under review is *provisional*. Today nothing expresses that. Worse, a dependent can be **accepted as current while its upstream object is still invalid** (F-2).
- *The fix is a derived state, not more propagation.* An object's **effective status** should be the worst status on its dependency path: `current` < `upstream-under-review` < `upstream-invalid` < `superseded-input`. It is computed on read, and accepting a mark is refused while the effective status is above `upstream-under-review`.

**The container pass-through is correct.**

- A questionnaire with a reworded item *is* a reworded questionnaire.
- A model with a moderated path *is* a different model.
- The same logic is missing for **sections and their blocks** (F-10).

**`tests` does not propagate: correct.** Changing a hypothesis voids the verdict, not the coefficient. The coefficient is still what the run produced.

**Two over-invalidations** (conservative, but noisy enough to erode trust):

- **Hypothesis direction → analysis `invalidates`.** For a two-tailed test the estimate and its p-value do not change; only the verdict does. Recommended:
  - `specifies` from a hypothesis gives `review`, except when the analysis spec encodes the direction (one-tailed test, directional prior), which gives `invalidates`;
  - `tests` stays `invalidates`.
  - (F-22)
- **Column recode → every run on that dataset version is invalidated,** because nothing records which columns an analysis uses. This needs `uses_column` (F-11).

### 1.3 Realistic scenarios

The first seven rows are asserted in `test:graph`; the last three were confirmed by `test:graph:gaps`.

| Scenario | Result today | Correct? |
|---|---|---|
| Construct definition reworded | Items, model element, hypotheses, citations about it and describing text → review | ✅ |
| Construct reflective → formative | Element, model, analysis, run, results, reporting text → invalidated; items and hypotheses → review | ✅ |
| Hypothesis wording changed | Posited path, analysis, testing value, describing text → review | ✅ |
| Hypothesis direction reversed | Analysis, run, results and text invalidated | ⚠️ Over-invalidates (F-22) |
| Item reverse-coded | Column, dataset versions, cleaning step, run, results, text → invalidated; construct and questionnaire → review | ✅ |
| Item reworded | Construct, questionnaire, column binding, Methods text → review; dataset version → info (wording drift) | ✅ |
| New dataset version (supersede) | Runs on the old version, their results and reporting text → review | ✅ |
| Analysis re-run (supersede) | Old values, tables and reporting text → review | ✅ **but** that text can then be accepted as current (F-2) |
| Result value "corrected" | Allowed, and the reporting text is invalidated | ❌ It should be impossible: results are engine output (F-6) |
| Citation contradicted / source retracted | Citing text invalidated; hypothesis grounded in it → review | ✅ |
| Manuscript block edited | Nothing flagged (abstract, cross-references) | ❌ (F-10) |
| Model: direct path → moderation | Analysis → review only | ❌ (F-9) |
| Cosmetic edit, then a real change | **The real change flags nothing** | ❌ (F-1) |

### 1.4 Missing relations and node types (F-11, confirmed)

| Needed | Proposed relation (src depends on dst) | Why |
|---|---|---|
| RQ ↔ construct | `construct —scoped_by→ research_question` | Changing the research question must reach the constructs chosen for it (review). |
| RQ ↔ hypothesis | `hypothesis —answers→ research_question` | Hypotheses are the operational form of the question. |
| Indicator ↔ latent variable | `model_element —indicated_by→ dataset_column \| instrument_item` | The SEM measurement model. Without it, "which items load on TRUST" is not in the graph. |
| Analysis ↔ columns | `analysis —uses_column→ dataset_column` | Precise invalidation (§1.2) and a codebook. |
| Path ↔ its ends | `model_element(path) —connects→ model_element` (attrs `from`/`to`/`moderator`) | Mediation and moderation structure; hypothesis ↔ path ↔ constructs. |
| Table/figure ↔ values | `result_table \| figure —contains_value→ result_value` | A table is a view of values. Tracing a table cell back to its number. |
| Discussion ↔ interpretation | allow `block —presents→ interpretation` | The Discussion chain: result → interpretation → text. |
| Section ↔ blocks | `section —has_block→ block` (container) | F-10. It replaces the non-dependency `part_of` for blocks. |
| Manuscript claims | A `claim` granularity: either a `claim` node or `block` + a span locator in edge attrs | G.4 and G.5 speak of claims; one block can contain several claims with different evidence. **Decide before P1-H.** |

**The target chain is supported once F-11 is added:**

research question → constructs → hypotheses → items → columns → transformations → analysis → results → tables/figures → text claims → citations/evidence

Today it breaks at three points:

- **RQ → constructs / hypotheses:** no relation;
- **items/columns → model:** no indicator relation;
- **tables → values:** no containment relation.

---

## 2. Traceability

**`trace` today.**

- *Up* (a reported number → its run → data and specification → model and hypotheses → constructs → items) works. This is asserted in `test:graph`.
- *Down* (source → citation → citing text) works.

**Gaps:**

- **F-5 (confirmed).** Removing a `reports` or `cites` edge leaves the text **looking current**, while its number or citation is no longer traced. Unlinking an edge that carries provenance must flag the source node as `untraced`. It must never be silent.
- **F-18. Edges are not versioned.**
  - `node_versions` snapshots nodes, but edges are updated and deleted in place, so the graph *as it was* when a run executed or a manuscript was submitted cannot be reconstructed.
  - This is the main reproducibility gap. The Integrity Report (R4) and the reproducibility package (G.2 `packages`) both need "the graph at time T".
  - **Fix:** edges become append-only, with `valid_from` / `valid_to`, `created_by` / `removed_by` and `removed_reason`. Unlink sets `valid_to` instead of deleting.
- **F-23.** Linking an item to a construct changes the construct's measurement (it is correctly treated as a structural change) but does **not** create a new construct version. "Trust v3" therefore does not say which items it had. **Fix:** an `onLink` change bumps the target's version, with a payload that records the membership change.

---

## 3. Versioning: can an old result silently appear current?

**Yes. There are five confirmed ways (F-1 to F-5):**

**F-1: pin drift.**

- *Rule today:* impact analysis follows an edge only if it is pinned to the version being replaced.
- *How pins go stale:* a pin moves only when a mark is **accepted**. A **cosmetic edit** (it creates a version but no marks), a **dismissed** mark, a **regenerated** mark, or any edge whose rule gave no severity leaves the pin on an old version.
- *Consequence:* **every later change to that target skips the dependent, forever.* Confirmed three ways.
- *Fix:*
  - in the same transaction as the version bump, advance the pin on every edge whose rule produced no mark;
  - re-pin on every resolution, not only `accepted`;
  - still traverse edges pinned to older versions, reporting them as "already stale since vN" rather than skipping them.

**F-2: accept over an invalid input.**

- `resolveStale('accepted')` returns text to *active* while the value it reports is still invalidated, or was produced by a superseded run. Confirmed for both cases.
- *Fix:* refuse `accepted` (409) while the effective status (§1.2) is `upstream-invalid` or `superseded-input`. The Impact Report UI offers "re-point to the new result" instead.

**F-3: new links to old results.**

- New text can be linked, with `reports`, to a value from a superseded run and shows as current.
- *Fix:* linking to a superseded, stale or archived target either:
  - creates the matching mark immediately, or
  - is refused, unless `acceptStaleTarget: true` is given.

**F-4: superseded nodes stay editable, and supersede cycles are possible.**

- A superseded node can still be edited.
- A superseded node can supersede its own successor, which leaves *no* current node.
- *Fix:* superseded nodes are read-only, and `supersede` refuses a replacement that is itself superseded or that would form a cycle.

**F-5:** see §2.

**What is correct today:**

- **Immutable version rows:** by convention only; see F-7.
- **Optimistic concurrency** on node updates: row lock plus `expectedVersion`, 409 on mismatch.
- **Acknowledgement hash:** it covers the node, the version, the proposal and the consequences, so a report goes stale when the graph changes between the preview and the save.
- **Pinning to the version at link time.**
- **Supersede excludes the replacement from its own report.**

**Also risky:**

- **F-7. Versions are immutable only by convention.** A direct `UPDATE node_versions` succeeds (confirmed). **Fix:** a trigger that refuses UPDATE, and allows DELETE only when it cascades from deleting a node.
- **F-13. `resolveStale` resolves *all* open marks on a node,** including ones created after the user looked. Someone reviewing the effect of a definition change can, by accident, accept an invalidation that arrived a second earlier. **Fix:** the request names the marks it resolves (`[{causeNodeId, causeVersion}]`) and gets 409 if other open marks exist.
- **F-17. `link` reads the target's version without a lock.** A link made concurrently with an update to its target can be pinned to the version being replaced, and then misses that update. **Fix:** `SELECT … FOR SHARE` on the target in `link`.
- **F-21. `graph_nodes.data` duplicates the payload of the current version.** Nothing checks that the two agree. **Fix:** write both in one statement path (already true); add an integrity query to the evaluation suite; later, derive `data` from the typed tables.

**Reproducibility.** Node history is complete; graph history is not (F-18). A run's inputs are pinned by its edges, but the pins are set when the edge is created, not when the run executes. Runs therefore need to be created **by the engine, atomically with their edges** (F-6), so that the pins are the versions actually used.

---

## 4. Security

**The application-level isolation is correct for every code path in P1-A.**

- Every query is scoped by `project_id`, or runs after `loadNode(projectId, nodeId)` has confirmed ownership. I checked: `getNode`, `listVersions`, `resolveStale`, the re-pin SQL, `applyReport` (its ids come from project-scoped edges) and `unlink`.
- A project the caller cannot see answers 404, exactly like a project that does not exist.
- `test:graph` covers reads, links, updates and impact across projects.

**Risks:**

- **F-12. The database would accept an edge between two projects** (confirmed). Only the service prevents it. **Fix (schema):** `UNIQUE (project_id, id)` on `graph_nodes`, and composite foreign keys `(project_id, src_id)` and `(project_id, dst_id)` → `graph_nodes (project_id, id)`.
- **F-24. The access check sits in the route handlers, not in the service.** The service trusts the `projectId` it is given. P1-C tools and P1-D agents will call the service directly. **Fix:** every service function takes an `Actor` and checks the project role itself, so there is one gate with no bypass.
- **F-19. Ownership has two sources of truth.**
  - `project_members` is one; `research_projects.user_id` is the other, used as a fallback in `requireProjectRole`.
  - The fallback means an owner can never be removed.
  - The legacy `/api/projects/*` routes ignore `project_members` entirely.
  - Acceptable while membership is owner-only. It must be settled before sharing ships.
- **F-8. Payload size is unbounded for types without a schema** (a 3 MB node was accepted, confirmed), and the graph routes have no rate limit. **Fix:** a size cap of about 256 KB on the canonical payload, plus a per-user write limit through `withApi({ rateLimit })`.
- **F-16 (low).**
  - With the flag off, an unauthenticated request gets 401 rather than 404, which reveals that the route exists.
  - The `COMMENTER` role exists but no permission uses it.

**Where RLS must go.** Not implemented; no current issue requires it.

1. **Tables:**
   - `graph_nodes`, `graph_edges`, `node_versions`, `stale_marks`, `project_members`;
   - later every typed detail table, `runs`, `approvals`, `tool_calls` and `run_events`.
   - Each needs `project_id`. **`node_versions` and `stale_marks` do not have it yet** (F-20): add it, denormalised, with a composite foreign key.
2. **Policy:**
   - `USING (project_id IN (SELECT project_id FROM project_members WHERE user_id = current_setting('app.user_id')::text))`;
   - the same for `WITH CHECK`, plus a role condition for writes (`role IN ('OWNER','EDITOR')`).
3. **Session context:**
   - one helper, `withProjectScope(actor, fn)`, opens a transaction and runs `select set_config('app.user_id', $1, true)`;
   - every graph service function runs inside it;
   - today the reads (`getNode`, `listNodes`, `listVersions`, `trace`, `listStale`, `previewUpdate`, `requireProjectRole`) run outside a transaction, so this is a change to the service, not to the routes;
   - `set_config(…, true)` is transaction-local, so it works behind transaction-mode poolers (Neon `-pooler`, Supabase 6543), where `SET` on a session would leak between users.
4. **Roles:**
   - the application connects as a role **without** `BYPASSRLS`;
   - migrations run as the owner role;
   - workers (engine, agents) use the same application role with `app.user_id` set to the run's actor. The Quality agent (R8) gets a read-only role.
5. **When:** together with F-24 (the service is the gate), in the first PR in which the service runs inside `withProjectScope`. That is P1-D at the latest, and before any agent writes to the graph.

---

## 5. Data model: JSON payloads versus typed tables

The JSON payloads, validated by a zod schema per type, were the right choice for P1-A: the shape is still moving, and no production data exists yet.

**Types that should get typed tables, keyed 1:1 by `node_id`.** The current version is projected into the typed row in the same transaction; `node_versions.payload` stays the immutable history.

| Type | Why typed | When |
|---|---|---|
| `result_value`, `analysis_run`, `result_table`, `figure` | Numeric queries (G.4 `integrity.trace` matches a displayed number to candidate values by statistic and precision), a run foreign key, engine version and seed, input hashes for reproducibility, immutability enforced by the database | With the engine write path (P1-C `stats.run`) |
| `dataset_version`, `dataset_column`, `transform_step` | A unique column name per version, position, type, value labels and missing codes; a frozen flag enforced by the database; storage key and content hash | Before data ingestion writes to the graph |
| `source`, `citation`, `evidence` | Unique DOI per project, retraction status joins, CSL-JSON, verification status, chunk ids (pgvector) | P1-H (citation engine) |
| `construct`, `hypothesis`, `instrument_item`, `model_element` | Unique codes (`H1`, `TR1`) per project or instrument; foreign keys from path elements to their ends; scale bounds and reverse coding as checked columns | P1-I, or before the wizard writes to the graph |
| `block`, `section` | ProseMirror JSON, plain text, word counts; migration of `research_sections` | Manuscript migration |
| **Keep as JSON:** `idea`, `gap`, `objective`, `research_question`, `note`, `decision`, `interpretation`, `journal_target`, `submission`, `reviewer_comment`, `response` | Mostly free text, with no relational queries or constraints needed | — |

**Also:** give `model_element` and `conceptual_model` zod schemas *now*: `kind`, `role`, `from`, `to`, `moderator`, with `kind`, `role` and the endpoints structural. This is the fix for F-9, and it needs no table.

---

## 6. API (`/api/v1/projects/:projectId/…`)

| Aspect | State | Finding |
|---|---|---|
| Authorisation | Session required; flag checked, then project role; 404 when the caller has no access | ✅ One issue: the gate is in the route handlers, not the service (F-24) |
| Project roles | VIEWER reads; EDITOR writes; OWNER unused; COMMENTER unused | ⚠️ Membership management does not exist yet (fine for now); the fallback in F-19 |
| Idempotency | `PATCH` with `expectedVersion` is safe but ambiguous on retry (a retried success returns 409). A retried `POST /nodes` creates a duplicate. `POST /edges` returns 409 on a duplicate | ❌ **F-14:** an `Idempotency-Key` header, stored for 24 h per user and route with the request hash and the response; a retry replays the response. Needed before agents (P1-D) retry tool calls |
| Optimistic concurrency | Nodes: `expectedVersion` or `If-Match` | ⚠️ Resolve (F-13) and link (F-17) have no equivalent; supersede locks the old node only |
| Error semantics | 401, 403, 404, 409 (version conflict **and** duplicate edge), 422, 428 carrying the report | ⚠️ Distinguish the two 409s by a `details.reason`; expose `ETag: <version>` on GET |
| Feature flag | Off → 404 | ⚠️ Unauthenticated requests get 401 before the flag is checked (F-16) |
| Pagination | `listNodes`: `limit` ≤ 1000, no cursor. `listStale`: silently capped at 1000. `trace` and `versions`: unbounded | ❌ **F-15:** keyset cursors (`updated_at, id`); a `truncated` flag; a node budget for `trace` |
| Validation | Types, payload schemas, relation types and edge endpoints, label length, the hash format | ⚠️ Payload size (F-8); types without a schema accept any fields |

---

## 7. Tests added in this review

`scripts/graph-gaps.ts` (`npm run test:graph:gaps`): 24 checks, one or more per finding. All of them fail today. No existing test was changed, and no application code was changed. `test:graph` (103), smoke, statistics, integration, jobs and e2e are unaffected.

No tests were added for F-13 to F-24: they are API-design or concurrency findings, and a test would restate the finding rather than expose new behaviour.

---

## 8. Summary

### What is correct

- **Schema:** the five tables, additive migration, backfill of project owners.
- **Versioning:** immutable-by-design versions with payload hashes, and optimistic concurrency with a row lock.
- **Impact engine:** rule-driven, pure and cycle-safe. Its tests pin 16 realistic scenarios exactly (the R6 table).
- **Acknowledgement:** the Impact Report hash binds the node, the version, the proposal and the consequences.
- **Propagation principle:** invalidation is transitive and review is a decision point (§1.2).
- **Isolation between projects** at the application level, with tests.
- **Feature flag** off by default; no effect on existing features (e2e 66 passed, 1 skipped).

### What is incomplete

- Missing relations: F-11.
- Section/block containment: F-10.
- Schemas for the model types: F-9.
- Edge history: F-18.
- Membership changes version the target: F-23.
- Derived effective status: §1.2.
- Idempotency: F-14.
- Pagination: F-15.
- Typed tables: §5.
- RLS: §4.

### What is risky

- **Silent-current results:** F-1, F-2, F-3, F-4, F-5.
- **Fabricated or editable "traced" numbers:** F-6.
- **Mutable history:** F-7.
- **Unbounded payloads with no write rate limit:** F-8.
- **Cross-project edges not refused by the database:** F-12.
- **Resolving marks the user never saw:** F-13.
- **An access gate the future agents could bypass:** F-24.

### What must change before production

Here "production" means before `FF_GRAPH` is turned on anywhere, or before any tool or agent writes to the graph.

1. **F-1:** advance pins on every version bump and every resolution; never skip an old-pinned edge silently.
2. **F-2:** derived effective status; refuse `accepted` over an upstream that is invalid or superseded.
3. **F-3, F-4, F-5:**
   - links to stale or superseded targets are flagged;
   - superseded nodes are read-only and supersede cycles are refused;
   - unlinking a provenance edge flags the source node.
4. **F-6:**
   - `analysis_run`, `result_*` and `figure` are created only by the engine (`origin = 'engine'`) and are never updated, only superseded;
   - a `dataset_version` becomes frozen once anything uses it.
5. **F-7:** database trigger making `node_versions` immutable.
6. **F-8:** payload cap and a write rate limit.
7. **F-12:** composite foreign keys keeping edges inside one project.
8. **F-13:** resolve names the marks it resolves.
9. **F-24:** the access check moves into the service (an `Actor` on every call).
10. **F-9, F-10:** model schemas; sections contain their blocks.

### What can safely wait

| Item | Until |
|---|---|
| RLS | P1-D, with F-24 and F-20 |
| Typed tables | In each owning step (§5) |
| Edge history (F-18) | Before the reproducibility package and the Integrity Report (R4) |
| Idempotency keys (F-14) | Before agents retry tool calls (P1-D) |
| Cursor pagination (F-15) | Before the workspace UI (P1-I) |
| Hypothesis-direction tuning (F-22) | — |
| `onLink` version bump (F-23) | — |
| The two sources of truth for ownership (F-19) | Before project sharing |
| Flag-off 401 (F-16) | — |
| The `claim` granularity decision | Before P1-H |

### Recommended changes, in order

1. **P1-A.1 "graph integrity" (in the same PR as P1-A, before anything is pushed):** F-1, F-2, F-3, F-4, F-5, F-6, F-7, F-8, F-9, F-10, F-12, F-13, F-24, plus the F-11 relations. Each finding's checks move from `test:graph:gaps` into `test:graph`; P1-A is not merged until `test:graph:gaps` is empty.
2. Record F-14, F-15, F-18, F-20 and RLS as entry criteria of P1-D and P1-I in `PHASE1_PLAN.md`.
3. Decide the manuscript `claim` granularity (§1.4) before P1-H.

### Exact migration implications

- **Migration 0011 has not been applied anywhere but a local test database, and the graph tables hold no production data.** It can therefore be **edited in place** in the P1-A PR instead of adding 0012. This is the cheapest moment the schema will ever have; after the first deploy, every change below becomes an additional, backfilled migration.
- **Changes to 0011** (all additive in effect; no existing table is touched except `research_projects` → `project_members`, which is unchanged):

| Change | Finding |
|---|---|
| `graph_nodes`: `UNIQUE (project_id, id)`; `frozen_at timestamptz` | F-12; F-6 |
| `graph_edges`: composite foreign keys `(project_id, src_id)` and `(project_id, dst_id)` → `graph_nodes (project_id, id)` | F-12 |
| `graph_edges`: `valid_from`, `valid_to`, `removed_by_user_id`; unique index made partial `WHERE valid_to IS NULL` | F-18, if it is taken now; otherwise a later additive migration |
| `node_versions` and `stale_marks`: `project_id text NOT NULL`, with composite foreign keys | F-20 |
| `stale_marks`: a `kind` column (`stale` \| `untraced`) | F-5 |
| Trigger `node_versions_immutable`: `BEFORE UPDATE` → raise; `BEFORE DELETE` → raise unless `pg_trigger_depth() > 1`, i.e. a cascade from deleting a node | F-7 |

- **Later, additive migrations:**
  - `idempotency_keys (user_id, key, route, request_hash, response jsonb, created_at)`: F-14;
  - typed detail tables (§5), each 1:1 with `graph_nodes(id)` and backfilled from `graph_nodes.data`;
  - RLS policies plus an application database role without `BYPASSRLS` (§4).
- **Rollback** stays as it is: `FF_GRAPH=false`, or redeploy. Nothing outside the graph reads these tables.

### Recommended next step

Do **not** start P1-B. Implement **P1-A.1** as listed above, on top of the current local P1-A commits:

1. amend migration 0011;
2. fix F-1 to F-13 and F-24, and add the F-11 relations;
3. move each finding's checks from `test:graph:gaps` into `test:graph`;
4. re-run every suite, including e2e with the flag both off and on.

Then report again, and push P1-A and P1-A.1 as a single PR after [#29](https://github.com/ameralqudah/academic-ai/pull/29) is merged.
