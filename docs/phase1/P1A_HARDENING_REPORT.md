# P1-A.1 hardening report: Research Graph integrity and result provenance

**Date:** 2026-09-23 · **Input:** `docs/phase1/P1A_REVIEW.md` (findings F-1 to F-24) · **Status:** implemented and fully tested locally; **not pushed, not merged**.

**Goal.** Academic AI must not be able to present an old, replaced, manually altered or provenance-free research result as a current, verified result. The guarantees are enforced in three places:

- the service, which is now the only gate to the graph;
- the database, through foreign keys, check constraints and triggers;
- **currency computed on read**, which cannot drift and cannot be "accepted" away.

## 1. The guarantees, and where each is enforced

| Guarantee | Enforced by |
|---|---|
| A manuscript number references a specific result value from a specific run | `claim/block —reports→ result_value —produced_by→ analysis_run —executes→ analysis@v, —uses_data→ dataset_version@v`. The `produced_by`, `executes` and `uses_data` edges are written only by `recordRun`, pinned to the versions actually used, and can never be removed or re-pinned. |
| A result value references the run that produced it | Computed results exist only through `recordRun`, which writes them together with their `produced_by` edge in one transaction. Nobody else can create `produced_by` (403). |
| Replaced or invalidated runs are not usable as current evidence | Superseding a run or dataset version **invalidates** everything that used it. Currency is computed on read, so anything that rests on it reads as `superseded_input` or `upstream_invalid` and its numbers as `not_current`. Linking new text to it is refused unless it is explicitly marked as a historical reference, and then the text is out of date at once. A new run on replaced data is refused. |
| A traced statistical result cannot be altered by hand | Computed results are immutable in the service (409 `immutable_result`) **and** in the database (trigger `graph_nodes_computed_immutable`). `provenance` can never change, so `manual` cannot become `computed`. |
| A manually entered value is labelled as such | Result, table and figure nodes created by a person get `provenance = 'manual'`. Any text that reports one has `verification = manual`, never `verified`, even when it also reports computed values. |
| No detached dependent silently becomes current | Every dependency edge is followed whatever its pin. Pins advance on changes that do not affect them and on every resolution. Accepting is refused while something upstream is not current, and resolving must name every open mark. |
| Removing a provenance edge invalidates or blocks the claim | A run's record cannot be removed (409 `engine_record`). Removing `reports`, `cites`, `contains_value`, `supported_by`, `of_source` or `extracted_from` marks the source node `untraced`, which counts as invalid, and flags everything downstream. It cannot be accepted until it is re-linked or rewritten. |
| Replacement chains cannot loop | A replaced node cannot be replaced again or used as a replacement, and a recursive history check refuses loops. |
| Model changes invalidate the analyses they touch | Typed schemas for `model_element` (kind, role, measurement, order; all structural) and `conceptual_model` (type). New relations `connects` and `indicated_by` (a structural change when linked or unlinked). Hypothesis kind and direction are structural. |
| Manuscript dependencies are explicit | `section ⊃ block ⊃ claim` are containers (`has_block`, `asserts`), so a changed block reaches its section, and from there the abstract, cross-references, reviewer responses and submission snapshots. `summarizes` and `refers_to` accept blocks and claims. |
| No cross-project edges | Composite foreign keys `(project_id, node_id)` on edges, versions and marks, plus the service checks. |
| Authorisation inside the service | Every exported service function takes an `Actor` and checks the project role itself. Only server code can act as `engine`. |
| Payload limit, rate limits | 256 KB per canonical payload. 120 writes and 600 reads per minute per client on every `/api/v1` route. |
| Optimistic concurrency | `expectedVersion` or `If-Match` on updates; resolve names its marks; `link` locks both ends with `FOR SHARE`. |
| Immutable history | Trigger `node_versions_immutable`: no UPDATE, and no DELETE except the cascade when a node is removed. |

## 2. Every finding and its fix

| # | Finding | Fix | Tests (`test:graph` unless noted) |
|---|---|---|---|
| F-1 | Pin drift hid dependents from later changes | Impact follows every dependency edge. Edges pinned to an older version are flagged `alreadyStale` instead of being skipped. Pins advance on changes that do not affect them (`unaffectedEdges`) and on **every** resolution. Run records never move. | Cosmetic edit, then a real change; accepted, then changed; dismissed, then changed; already-stale labelling; the run keeps its executed version. Mutation (restore the skip): caught. |
| F-2 | Accepting over an invalid or replaced input | New `currency.ts`: an object's own state plus the worst state upstream (`provisional`, `upstream_invalid`, `superseded_input`), computed on read. `accepted` and `regenerated` are refused while upstream is not current. An invalidated run can only be re-run, never accepted. | Resolution rules; scenarios A, B, C. Mutation (drop the guard): 4 failures. |
| F-3 | Linking to a replaced or stale target was silent | Refused (409 `stale_target`), unless `allowStaleTarget` is given; then the new dependent gets a `stale_input` mark (invalidates) at once. | Scenario C. |
| F-4 | Replaced nodes editable; supersede loops | Replaced nodes are read-only and cannot gain links. Supersede refuses an already-replaced node, a replaced replacement, a type change, and a loop in the history (recursive check). | Scenarios B and I, including the check that fires on its own. |
| F-5 | Removing a provenance edge left text looking current | Removing a run record is refused. Removing another provenance link marks the source node `untraced` (invalid) and flags its dependents; this needs acknowledgement. `untraced` can only be resolved as `regenerated` after re-linking or rewriting. | Scenario D. |
| F-6 | Results typed in or edited; dataset content editable | Runs only through `recordRun` (engine). Computed outputs are immutable. Values created by people are `manual`. Dataset `contentHash`, `rows` and `storageKey` are immutable. The data a run used, and its lineage (derived versions, columns, cleaning steps), is **frozen**: only cosmetic edits remain. | Scenario H; frozen-data checks; the R6 checks refusing edits to results and dataset versions. |
| F-7 | Versions immutable only by convention | Database trigger refusing UPDATE, and DELETE outside a cascade. | Scenario G (update and delete refused); cascade from deleting a project still works. |
| F-8 | Unbounded payloads; no write rate limit | `MAX_PAYLOAD_BYTES` = 256 KB, checked before parsing. `GRAPH_WRITE_LIMIT` and `GRAPH_READ_LIMIT` on every route. | Oversized payload refused; the smoke suite checks that every `/api/v1` handler is flagged and rate-limited. |
| F-9 | Structural model changes classified as substantive | Schemas for `model_element` and `conceptual_model` with structural fields. | R6: path direct → moderation, latent reflective → formative; scenario E (moderation, a mediator added, an indicator dropped, a hypothesis made a mediation). |
| F-10 | Block edits did not reach section or abstract | `has_block` (section → block) and `asserts` (block → claim) are containers; `part_of` is kept only for section → manuscript. | R6: "results text edited". |
| F-11 | Broken traceability chain | New relations: `scoped_by`, `answers`, `indicated_by`, `connects`, `uses_column`, `contains_value`, `presents`, `supported_by`, `has_block`, `asserts`. New node type `claim`. `reports` and `cites` accept claims. | End-to-end trace from a reported number to the research question; claim → citation → evidence → source; source → every claim resting on it; the smoke check of the chain. |
| F-12 | The database accepted cross-project edges | Unique `(project_id, id)` on nodes, and composite foreign keys on edges (both ends), versions and marks (node and cause). | Scenario F (edge and version refused by PostgreSQL). |
| F-13 | Resolve cleared marks the caller never saw | `resolveStale` takes the list of marks; if it differs from the open set, 409 `marks_changed` returns the current marks. `dismissed` is limited to `info` marks. | Resolution rules; e2e (an empty list is refused). |
| F-16 | Flag-off routes answered 401 | `flagged()` wraps every handler and answers 404 before authentication. | e2e with the flag off (404) and on (401 without a session). |
| F-17 | `link` read the target's version unlocked | Both ends are loaded `FOR SHARE`. | (concurrency; by construction) |
| F-20 | `node_versions` and `stale_marks` had no `project_id` | Added, with composite foreign keys. RLS-ready. | Scenario F (version). |
| F-24 | Authorisation only in the routes | Every service function authorises the `Actor` itself; routes pass the session user. Only server code can set `origin: 'engine'`. | A stranger through the service: read, list, trace, assess, create, update, and the engine acting for them, all 404; viewer and editor roles. |
| F-22 | Hypothesis direction over-invalidates | **Kept conservative, on purpose.** The brief asks that design changes invalidate the analyses whose assumptions they change. The direction is part of the hypothesis an analysis specifies. | R6: hypothesis direction. |

Not in scope for P1-A.1, and listed in §8: F-14, F-15, F-18, F-19, F-21, F-23, RLS.

## 3. Schema changes: migration 0011, edited in place

Migration 0011 has never been deployed, and no production graph data exists, so it was regenerated rather than followed by a 0012. Everything in it is still additive: five new tables, one enum, and a backfill of `project_members`.

| Table | Change against the original 0011 |
|---|---|
| `graph_nodes` | New columns `provenance` (`computed` \| `manual` \| null, CHECK) and `frozen_at`. `UNIQUE (project_id, id)`, created before the foreign keys that reference it. CHECK on `status`. Trigger `graph_nodes_computed_immutable`: `provenance` can never change; a computed node's `data` and `current_version` can never change. |
| `node_versions` | New `project_id NOT NULL`; composite foreign key `(project_id, node_id)` → `graph_nodes`, ON DELETE CASCADE. Trigger `node_versions_immutable`. |
| `graph_edges` | Composite foreign keys `(project_id, src_id)` and `(project_id, dst_id)` → `graph_nodes`, replacing the single-column ones. New `origin` column (`engine` for run records). |
| `stale_marks` | New `project_id NOT NULL`; `kind` (`stale` \| `untraced` \| `stale_input`, CHECK); `node_version` (the flagged node's version when marked). Composite foreign keys for the node and the cause. `kind` added to the primary key. CHECK on `severity`. Index `(project_id, resolved_at)`. |
| `project_members` | Unchanged; the owner backfill is unchanged. |

**Local database:** the old 0011 was dropped, its migration record removed, and the new 0011 applied cleanly (11 → 12 migrations). The backfill created 35 memberships for 35 projects.
**Rollback:** `FF_GRAPH=false` (the default), or redeploy the previous code. Nothing outside the graph reads these tables.

## 4. API changes (`/api/v1/projects/:projectId/…`)

| Change | Detail |
|---|---|
| Flag first | Every handler is wrapped in `flagged()`: flag off → 404 before authentication. |
| Rate limits | Writes: 120 per minute per client (`graph-write`). Reads: 600 per minute (`graph-read`). |
| `GET …/nodes/:id` | Adds `currency` (`effective`, `upstream`, `verification`, `reasons`) and `provenance`; sets `ETag: "<version>"`. |
| **New** `GET …/nodes/:id/currency` | Whether the object can be shown as current, and what its numbers are worth: `verified`, `provisional`, `manual`, `not_current`, `untraced` or `none`. |
| `POST …/nodes` | `analysis_run` → 403 `engine_only`. `result_value`, `result_table` and `figure` are created as `manual`. `claim` is a new type. Payloads over 256 KB → 422. |
| `PATCH …/nodes/:id` | New 409 reasons: `superseded`, `immutable_result`, `immutable_field`, `frozen`, and `version_conflict` (previously undifferentiated). |
| `POST …/edges` | New `allowStaleTarget`. 409 reasons: `stale_target`, `superseded`, `immutable_node`, `duplicate_edge`. Run-record relations → 403 `engine_only`; `supersedes` → 422. |
| `DELETE …/edges/:id` | Run record → 409 `engine_record`. A provenance link → 428 with a report whose first item is the `untraced` mark. |
| `POST …/stale/:id/resolve` | **Breaking:** the body needs `marks: [{causeNodeId, causeVersion, kind}]`. New 409 reasons: `marks_changed`, `upstream_not_current`, `rerun_required`, `provenance_required`, `not_regenerated`, `dismiss_not_allowed`. The response includes `currency`. |
| `POST …/nodes/:id/supersede` | Now **invalidates** what used the old node. 409 reasons: `already_superseded`, `superseded`, `supersede_cycle`. Runs → 403 (re-run instead). |
| Every refusal | 409 responses carry `details.reason`, so a client can tell a version conflict from a duplicate or a provenance refusal. |

There is **no HTTP route for `recordRun`**. It is the engine's write path and will be called by `stats.run` in P1-C.

## 5. Security implications

- **One gate.** Tools (P1-C) and agents (P1-D) will call the service, and the service authorises every call; there is no path around it. Test: a stranger gets 404 for 7 operations called directly on the service, including the engine acting on a stranger's behalf.
- **The engine as a trust boundary.** `origin: 'engine'` can only be set by server code, never from a request. Anything that can construct it can write computed results. **This is the one place where review discipline replaces enforcement:** only the statistics engine's write path (P1-C `stats.run`) may construct an engine actor. P1-D should make this a separate database role (§8).
- **Defence in depth in PostgreSQL.** Cross-project rows, rewriting versions, editing computed results and relabelling provenance are refused by the database itself, so a future bug in the service cannot do them either. Each is tested by writing to the database directly.
- **Nothing is revealed while the flag is off:** 404 before authentication.
- **Unchanged:** sessions, CSRF, CSP, SSRF and upload guards, and the other routes. The full browser suite passes with the flag on and off.

## 6. Traceability implications

The chain the brief requires is now expressible and traced end to end (asserted in `test:graph`):

```
research question ← scoped_by ← construct ← relates ← hypothesis —answers→ research question
construct ← measures ← item ← binds ← column ← includes ← dataset version ← derived_from / transformed_by ← transform step → applies_to → column
model ⊃ element —represents→ construct, —indicated_by→ item/column; path —connects→ elements
analysis —specifies→ model/hypothesis, —uses_column→ column
run —executes→ analysis@v, —uses_data→ dataset version@v   (engine only, pinned, permanent)
value —produced_by→ run; table/figure —contains_value→ value
section ⊃ block ⊃ claim —reports→ value, —cites→ citation —of_source→ source; claim —supported_by→ evidence —extracted_from→ source
```

`trace(up)` from a results block reaches, among others, the research question and the gap. Evidence traces to its source, and a source traces forward to every claim resting on it.

**Verification is explicit and honest:**

- a claim is `verified` only if every value it reports was computed and is current;
- `provisional` if something upstream is under review;
- `manual` if any value was typed in;
- `not_current` or `untraced` otherwise.

**Limit:** a number written into text *without* a `reports` link is simply `none`, which is not verified, but it is not flagged as an untraced number either. Detecting such numbers is the G.4 writing validator, a later step.

## 7. Tests

### Added or changed

| Suite | What |
|---|---|
| `test:graph` (PostgreSQL, **in CI**), rewritten | **170 assertions.** A fresh fixture per scenario covers the whole chain (37 nodes created by hand, plus a run, a value and a table recorded by the engine; 59 links created by hand, plus 5 run-record edges). It covers: the R6 table for 17 kinds of change; the data lineage of unfrozen data; the write path; resolution rules; pinning (5 cases); scenarios **A–I**; the end-to-end trace; edge rules; authorisation inside the service; roles; the flag; cycle termination; cascade. **All 24 former gap checks are in it.** `scripts/graph-gaps.ts` and `npm run test:graph:gaps` were removed, so no known correctness test lives outside CI. |
| Smoke (pure), extended | Rule-table invariants: the run record is exactly 3 engine-only provenance relations; no relation both carries provenance and changes its target on link; the whole F-11 chain exists. Model roles are structural; dataset content is immutable. Pure currency logic: verified, replaced → not current, manual, a verdict does not make a value non-current. **Every `/api/v1` handler is flagged and rate-limited** (checked from the source). |
| e2e `graph.spec.ts` | Flag off: 404 even without a session. Flag on: 401 without a session. Resolve with an empty `marks` list gets 409 `marks_changed`. A typed-in value is `manual`, and a claim reporting it reads `manual` through `/currency`. Creating `analysis_run` gets 403. |

**Assertions that changed meaning** (corrections, not weakening):

- **"A run pinned to the old spec is not flagged again"** asserted F-1's bug. It now asserts the opposite: the run is flagged, labelled `alreadyStale`.
- **Supersede expectations** changed from `review` to `invalidates`, as the brief requires.
- **"Result value corrected"** and **"dataset content changed"** were allowed before and are now refused.

**Mutation checks:**

- removing the currency guard on resolve: 4 failures;
- restoring the pin skip: 2 failures.

### Complete results (local: PostgreSQL 16, production build)

RESULTS_TABLE

## 8. Remaining risks, and what is intentionally deferred to P1-D

**Remaining risks:**

1. **Engine trust (§5).** Any server code can construct an engine actor. Mitigation today: a single write path and review. P1-D: a separate database role for the engine, and a lint rule forbidding `origin: 'engine'` outside the statistics engine.
2. **The engine is not connected yet.** `recordRun` is ready, but the existing statistics features (classical statistics, PLS, CB-SEM) do not write to the graph yet; that is P1-C `stats.run`. Until then, "verified" can only come from `recordRun` in tests.
3. **Numbers without links are `none`, not flagged** (§6): this needs the G.4 writing validator.
4. **Rate limits are per instance** unless `RATE_LIMIT_STORE=redis`; this is unchanged from P0.5.
5. **Cost of currency.** It is computed on read by walking upstream (bounded at 5,000 nodes). Per node that is cheap; it is deliberately not included in `listNodes`. A cached, event-invalidated projection may be needed at scale.
6. **Races are backstopped, not prevented.** A concurrent supersede of something *upstream* of a link target is not locked by `link`. The new edge may then miss its `stale_input` mark, but currency is computed on read, so the dependent still reads as `superseded_input` and `not_current`. It is never presented as current.

**Deferred to P1-D:**

- **RLS**, with `withProjectScope` (`set_config('app.user_id', …, true)` per transaction). `project_id` is now on every graph table (F-20), so the policies are uniform.
- **A separate database role for the engine and the agents**, read-only for the Quality agent (R8).
- **Idempotency keys (F-14):** agents retry tool calls.
- **Edge history (F-18)** (`valid_from`/`valid_to` instead of delete) for the reproducibility package and the Integrity Report. Today a removed provenance edge leaves an `untraced` mark recording the path; a removed non-provenance edge leaves no trace.

**Deferred elsewhere:**

| Item | Until |
|---|---|
| Cursor pagination (F-15) | P1-I |
| Ownership's two sources of truth (F-19) | Before project sharing |
| `data` versus version consistency check (F-21) | The evaluation suite, P1-J |
| `onLink` changes creating a version of the target (F-23) | — |
| Typed detail tables (review §5) | Each in its owning step |

## 9. Is P1-A safe to expose behind the feature flag?

**Yes, for evaluation with `FF_GRAPH=true` in a staging or internal environment.** Within the graph, the platform can no longer present an old, replaced, manually altered or provenance-free result as current and verified: every path to that state is refused, flagged, or computed as not current on read, and is tested.

**Not yet for researchers in production.** The graph is still an API with no user interface (P1-I). No real statistics write to it yet (P1-C). RLS and the engine's database role (P1-D) are still to come. The flag should stay **off** in production until at least P1-C connects `stats.run` through `recordRun`.
