# Phase 1 report

**Plan:** `docs/phase1/PHASE1_PLAN.md` · **Architecture:** `docs/architecture/TARGET_ARCHITECTURE.md` (§C, §G, R1–R10)

Each step gets a section when it is merged.

| Step | Status | PR |
|---|---|---|
| P1.0 Security hardening | ✅ CI green | [#29](https://github.com/ameralqudah/academic-ai/pull/29) |
| P1-A Research Graph core | ✅ tests green locally | follows #29 |

---

## P1.0 Security hardening

The audit's security findings that were not among the 13 P0 items. Details are in the PR description.

- **SSRF** (`src/server/security/net-guard.ts`): every IPv4 and IPv6 notation is classified (including IPv4 embedded in IPv6). Redirects are followed by hand, at most 5, and every hop is checked. Addresses are also checked when the connection is made, which closes DNS rebinding.
- **Compressed uploads** (`src/server/security/archive-guard.ts`): DOCX and XLSX are really decompressed against hard limits before the parsers see them. PDF streams are capped. An oversized declared body is refused before it is read.
- **Configuration:**
  - `/api/health` returns only up/down to the public; the detailed report is for administrators.
  - CSP has no `unsafe-eval` in production.
  - The seed no longer overwrites plans edited in the admin panel.

---

## P1-A Research Graph core

**Goal:** everything later in Phase 1 writes into one graph per project, and a change to an upstream object reports, before it is saved, what downstream work it affects (R6).

### What was built

| Part | Where |
|---|---|
| Tables `project_members`, `graph_nodes`, `node_versions`, `graph_edges`, `stale_marks` | `src/server/db/schema.ts`, migration `drizzle/0011_p1a_research_graph.sql` |
| Node types (35, §G.1), payload schemas, field classes (cosmetic / substantive / structural), change classifier | `src/server/graph/types.ts` |
| Edge rules: 41 relations, each with its allowed types and its severity per kind of change | `src/server/graph/rules.ts` |
| Impact engine: pure and testable; a fixture, the database or a transaction supplies the edges | `src/server/graph/impact.ts` |
| Service: access by project role, create, update (versioned), dry-run impact, link and unlink, supersede, trace, stale list, resolve | `src/server/graph/service.ts` |
| API behind `FF_GRAPH` (off → 404) | `src/app/api/v1/projects/[projectId]/…` |

**API**

| Method and path | Role | Purpose |
|---|---|---|
| `GET/POST …/nodes` | viewer / editor | List (filter by type or status) / create |
| `GET/PATCH …/nodes/:id` | viewer / editor | Read (with open stale marks) / update |
| `GET …/nodes/:id/versions` | viewer | Immutable version history |
| `POST …/nodes/:id/impact` | viewer | **Dry run:** the Impact Report for a proposed payload |
| `GET …/nodes/:id/trace?direction=up\|down` | viewer | Provenance: what a node rests on, or what rests on it |
| `POST …/nodes/:id/supersede` | editor | Replace with a newer node (new dataset version, re-run) |
| `POST …/edges`, `DELETE …/edges/:id` | editor | Link and unlink (validated against the edge rules) |
| `GET …/stale`, `POST …/stale/:id/resolve` | viewer / editor | Open stale marks; accept, regenerate or dismiss |

### How impact works

1. **Direction.** An edge `src —rel→ dst` means *src depends on dst*.
2. **Classification.** An update is classified from the old and new payloads.
   - Structural examples: a construct's measurement kind, an item's reverse coding, a column's recode, an analysis spec, a retraction.
   - Substantive examples: a definition, a wording.
   - Cosmetic examples: a translation, notes.
   - A cosmetic change affects nothing downstream.
3. **Walk.** The walk goes backwards over dependency edges, and each edge rule gives a severity (`info`, `review` or `invalidates`) for the kind of change.
4. **Propagation.** Only `invalidates` propagates: an invalid run makes its results, and the text reporting them, invalid. `review` asks a person to decide about that one object; if they then change it, that change is analysed in turn. This keeps a definition tweak from flagging the whole project. There are two exceptions:
   - **Containers** (a questionnaire and its items, a model and its elements) pass a change through, because a change to a part is a change to the whole.
   - **Supersede** asks for review all the way down. When a newer run exists, every block reporting the old one says so.
5. **Pinning.** Edges are pinned to the version of their target. Once an object is stale, later changes to the same target do not flag it again. **Accepting** a stale mark re-pins it to the current versions.
6. **Acknowledgement (R6).** A change with any `review` or `invalidates` consequence is refused with `428 IMPACT_ACK_REQUIRED`, and the refusal carries the Impact Report. The client re-sends with `impactAcknowledged: <report hash>`. The hash covers the node, the version, the proposed payload and the consequences, so an acknowledgement is valid only for the exact report that was shown. The hash is stored on the new version for audit.
7. **Transaction.** The update, the new version, the stale marks and the status changes are written in one transaction. The node row is locked, and an edit made against an old version is refused with 409.

### R6 coverage: the stale set for each object type

The fixture project (37 nodes, 48 edges) covers design, instrument, data, analysis, literature and manuscript. `npm run test:graph` asserts the exact `invalidates` / `review` / `info` sets:

| Change | Invalidates | Review | Info |
|---|---|---|---|
| Construct measurement kind | model element, model, analysis, run, result value, results table, reporting block | items, hypothesis, citation about it, block describing it, cross-reference | — |
| Construct definition | — | items, model element, hypothesis, citation, describing block | — |
| Hypothesis direction | analysis, run, results, reporting block | model path it posits, describing block, cross-reference | — |
| Hypothesis wording | — | model path, analysis, the value that tests it, describing block | — |
| Item reverse-coded | column, dataset versions, cleaning step, run, results, reporting block | construct measurement, questionnaire, Methods block, cross-reference | — |
| Item wording | — | construct, questionnaire, column binding, Methods block | dataset version (wording drift) |
| Dataset column recode | dataset versions, cleaning step, run, results, reporting block | cross-reference | — |
| Dataset version content | run, results, reporting block | cross-reference | — |
| New dataset version (supersede) | — | runs on the old version, their results, reporting blocks | — |
| Analysis spec | run, results, reporting block | cross-reference | — |
| Result value corrected / newer run | reporting block / — | — / old values, their tables and reporting blocks | — |
| Citation contradicted | citing block | hypothesis grounded in it | — |
| Source retracted | citation, citing block | hypothesis | — |
| Manuscript section | — | abstract, cross-references, reviewer response | submission snapshot |

### Tests

| Suite | Result |
|---|---|
| `npm run test:graph` (new, PostgreSQL, also in CI) | ✅ 103 assertions. Covers the R6 table above, the write path (acknowledgement refused / wrong / for another proposal / accepted; versions immutable; conflict; no-op; cosmetic; invalid payload), marks with their paths, statuses, resolution and audit, version pinning and re-pinning, supersede, trace up and down, edge validation, unlink with acknowledgement, isolation between projects, roles, the feature flag, cycle termination and cascade. **Mutation check:** weakening one rule (`represents`) makes 8 assertions fail. |
| Smoke (pure) | ✅ adds 18 checks: the change classifier, canonical hashing and the consistency of the rule table |
| Playwright `e2e/graph.spec.ts` | Flag off (CI default): the routes 404 and require a session. Flag on: the full flow over HTTP (create, link, invalid link 422, dry run, 428 then acknowledged 200, 409 conflict, stale list, resolve, trace, versions, foreign project 404). ✅ Both ways locally; the full e2e suite with the flag off: 66 passed, 1 skipped. |
| Regression | typecheck, lint, smoke, statistics 1,328, knowledge, integration 807, jobs 22, production build: all ✅ |

### Migration and rollback

- **`0011_p1a_research_graph` is additive only:** five new tables, one enum, indexes. It also backfills an `OWNER` row in `project_members` for every existing project. The backfill is idempotent and was checked on the local database: 10 projects gave 10 members.
- **Project creation** now inserts the owner membership in the same transaction. Access still falls back to `research_projects.user_id`, so projects created any other way stay reachable by their owner.
- **Rollback:** set `FF_GRAPH=false` (the default), or redeploy the previous code. Nothing else reads the new tables.

### Deviations from the architecture, and what is deferred

- **Edge rules live in code, not an `edge_rules` table.** They are still data (one typed table in `rules.ts`), but they are versioned and reviewed with the code that interprets them, and a smoke test checks their consistency. A table can be added if rules ever need to change without a deploy.
- **Two relations point the other way** so that every edge reads "src depends on dst": `produced_by` (result → run) replaces `produces`, and `contains` (model → element) replaces `element_of`. New relations: `has_item`, `includes`, `collected_with`, `applies_to`, `transformed_by`, `about`, `summarizes`, `refers_to`, `snapshot_of`, `interprets`, `version_of`, `supersedes`.
- **Typed detail tables are deferred.** Payloads are validated by zod schemas per type. The detail tables arrive with the steps that own each domain (H for sources and citations, the data and analysis steps for theirs).
- **PostgreSQL RLS is deferred.** Isolation is enforced in the service: every query is scoped by project, and there are 6 isolation tests. RLS needs the project and user set per transaction (`SET LOCAL`), which interacts with the connection poolers used in production. It will be added together with the run engine (P1-D), where every agent write goes through one transaction boundary.
- **The full Impact Report is not stored as a document.** Its hash is stored on the node version, and its items are stored as the stale marks, with their paths.
- **IDs** stay random UUIDs as text, like the rest of the schema (UUIDv7 would sort by time, but it would be the only exception).
