# WS2 report: numeric integrity of the legacy paths

**Date:** 2026-09-26 · **Branch:** `claude/stoic-wozniak-5l0xmv` · **Final `main`:** `276939f` (merge of [#43](https://github.com/ameralqudah/academic-ai/pull/43)) · **Status:** closed. Every WS2 finding is closed or explicitly handed to WS3 (§6). `FF_RUNS` and `FF_GRAPH` remain off. The guard version is `ws2-2`, and the latest migration is `0017_ws2_section_integrity.sql`.

This report is the canonical record of WS2 and of its closure (Workstream C). WS1, the run-engine hardening, is in `P1D_REPORT.md` §12–§13.

**Naming.**
- **Findings.** WS2 findings are named N1–N11, from the post-P1-D readiness audit. They are not the P1-C audit's N-1 to N-10 in `P1C_REPORT.md` §2.
- **Decisions.** WS2 decisions are named WS2-D1 to WS2-D5, to keep them apart from the architecture decisions D1… in `TARGET_ARCHITECTURE.md`. Code comments call them "WS2 D1" to "WS2 D5".
- **Review findings.** M2, M3 and M5 below are WS2 review findings, not the migration phases M1–M6 of the architecture plan.

## 1. Scope, and the relationship to WS3

**What WS2 was.** WS2 made every number that reaches a researcher's text, chat, task output or export on the legacy paths traceable. Legacy means outside the P1-C statistics engine.

**How it enforced this, by who wrote the text:**
- A number the model wrote that traces to no stored analysis result, or to the researcher's own words, is replaced by a visible marker before the text is stored.
- A number a person wrote is never changed. It is recorded and flagged.

**Terminology.** Legacy results are labelled *computed*, with a tier; they are never called *verified*. Only a succeeded, pinned P1-C run produces a verified number.

**What WS2 did not do:**
- change the P1-C engine (`ENGINE`, `stat_runs`) or `src/server/context/sources.ts`;
- enable a feature flag;
- change the UI.

**WS3** (graph provenance) takes the claim findings: N5, N6, and the claim-to-section linking part of N7. They sit behind `FF_GRAPH`, which is off, so those routes return 404 in production (§14).

## 2. Decisions

| Decision | Approved rule | Where it applies |
|---|---|---|
| **WS2-D1** Quarantine, not refusal | An untraced research number in model text is replaced with the marker `⟦unverified value⟧` (`⟦قيمة غير موثّقة⟧` in Arabic text), never silently dropped. The rest of the prose is kept, and the save still succeeds. | A4, B4 |
| **WS2-D2** A record with each version | Nullable `section_versions.integrity jsonb` (additive migration `0017`, no data change) stores the guard's result with each section version: mode, guard version, counts, the runs used and excluded with their tiers, and the first findings. | B1, read by B3 and B5 |
| **WS2-D2b** Immutable results (**declined**) | A database trigger making `analysis_runs.result` and `spec` unchangeable was optional and was **not** implemented. The application-level rules are relied on. | — |
| **WS2-D3** Windowed runs excluded | A legacy run computed on only the first rows of a file never supplies allowed numbers and can't be attached (409 `windowed_run`). Unpinned runs from before P1-C remain allowed as *unpinned*. | A3, A5, B2, B4, B5 |
| **WS2-D4** An edit revokes approval | Editing an approved section returns it to an unapproved state. Saving the same text is not an edit. | A2 |
| **WS2-D5** Planner tables dropped | A table the planner writes into a step input is not a source for an export. XLSX and CSV hold eligible computed results only. | B4 |

## 3. Delivery history

Dates are UTC.

| Part | Items | Commits | PR, merge commit, merged |
|---|---|---|---|
| Group 1 | Canonical numeric guard (N8); review follow-up H1, H2, H3, M1, M4 | `2c6f78d`, `4bb55a1` | [#36](https://github.com/ameralqudah/academic-ai/pull/36), `16db123`, 2026-09-25 00:05 |
| Workstream A | A1 guard prerequisites (M5, M3, M2) and the shared legacy helper; A2 N3 / WS2-D4; A3 N2 / WS2-D3; A4 N1 / WS2-D1; A5 N11 | `0919883`, `f96fe25`, `2f1477c`, `2836522`, `f0e9255` | [#37](https://github.com/ameralqudah/academic-ai/pull/37), `812fd2f`, 2026-09-25 15:34 |
| B1 | WS2-D2: the record with each section version; migration `0017` | `ce80b40`; `5e57d3a` from the gate branch `ws2-b1-gate` | [#38](https://github.com/ameralqudah/academic-ai/pull/38), `05f92c7`, 2026-09-25 23:01; [#39](https://github.com/ameralqudah/academic-ai/pull/39), `39da1f6`, 2026-09-25 23:18 |
| B2 | N10: legacy engine stamp, PLS/CB-SEM provenance | `924db45` | [#40](https://github.com/ameralqudah/academic-ai/pull/40), `a1ecf40`, 2026-09-26 08:34 |
| B3 | N9: deletion protection for cited analyses | `9313389` | [#41](https://github.com/ameralqudah/academic-ai/pull/41), `1f24021`, 2026-09-26 09:54 |
| B4 | N4 / WS2-D5: task writing and XLSX/CSV | `3c6a6c7` | [#42](https://github.com/ameralqudah/academic-ai/pull/42), `d15024c`, 2026-09-26 11:18 |
| B5 | N7, export part: Word integrity and provenance appendix | `ec24049` | [#43](https://github.com/ameralqudah/academic-ai/pull/43), `276939f`, 2026-09-26 12:49 |

**Group 1 and Workstream A.**
- **Group 1** made `src/server/integrity/numbers.ts` the one guard for every number in text (§4).
- **Workstream A** then applied it:
  - **A1:** the prerequisites the quarantine depends on. M2 traces a value only within its field type, M3 narrows what counts as the user's context, and M5 makes the quarantine a single deterministic pass.
  - **A2 (N3):** the section edit endpoint accepts only DRAFT or USER_EDITED, records the origin as USER whatever the client sends, and revokes approval on an edit (WS2-D4).
  - **A3 (N2):** legacy results are introduced to the model as "COMPUTED ANALYSIS RESULTS (legacy engine, not independently verified)", with a tier line per run, and windowed runs can't be attached.
  - **A4 (N1):** generated sections are quarantined before they are saved.
  - **A5 (N11):** chat replies are checked on every chat path and flagged, never rewritten.

## 4. The numeric guard, and where it is enforced

**The guard (`src/server/integrity/numbers.ts`, `NUMERIC_GUARD_VERSION = 'ws2-2'`)**
- **Detection.** It uses the P1-C detector (`@/lib/statistics-text`), which covers statistic assignments, decimals and percentages, Arabic-Indic and Persian digits, and comma and Arabic decimal marks.
- **Not findings.** Ordinary numbers (citation years, dates, counts in prose, labels, headings, versions) and stated criteria ("set at α = .05") are ignored.
- **Modes:**
  - `strict`: P1-C model text. Every digit outside a declared `{{value:key}}` token is a finding.
  - `model`: model text on a legacy path. Research numbers must be in the allowed set, or in the user's own context; the rest are findings.
  - `person`: a person's text. The same detection, reported as manual numbers and never altered.
- **Deterministic.** The same text and options always give the same findings and the same quarantined text.

**Where it is enforced**

| Surface | Mode, and what happens | Delivered in |
|---|---|---|
| Generated section (`generateSection`) | Model mode; quarantined before `saveSection`; the record is stored with the version | A4, B1 |
| A person's section edit (`saveUserEdit`) | Person mode; the text is kept as written; the manual count is stored with the version | A2, B1 |
| Chat (`streamChat`, the `/api/chat` fast and streamed paths, the orchestrator's `respond`) | Flags only (`checkChatReply`), stored on the assistant message; never rewritten | A5, B2 |
| Legacy results given to the model | Labelled computed, with a tier; windowed runs excluded | A3 |
| Attaching a run | A windowed run is refused (409 `windowed_run`) | A3 |
| Deleting a run or a dataset | Refused while attached or cited (409 `run_attached`, `run_cited`, `dataset_runs_in_use`) | B3 |
| Task writing (`document.write`) | Model mode; finished and unfinished paths quarantined; `prose.v1.integrity`; warning `write.quarantined` | B4 |
| Task XLSX/CSV | Built from eligible results only; failures `export.noAnalysis` and `export.windowedOnly` | B4 |
| Thesis Word export and task Word file | Integrity and Provenance Appendix, always included; windowed tables left out of the task Word file | B5 |

## 5. Marker, tiers and allowed numbers

**Quarantine marker.**
- The markers are `⟦unverified value⟧` (English) and `⟦قيمة غير موثّقة⟧` (Arabic). They carry no digit, so a quarantined text checks clean under the same options.
- The marker applies only to model text; a person's text is never rewritten.
- Only new generations are guarded. Text saved earlier is never rewritten.

**Result tiers (`legacyResultTier`).** None of these is "verified".
- *pinned*: dataset version, content hash and engine recorded, whole file.
- *windowed*: computed on the first rows only (`spec.truncatedTo`).
- *unpinned*: the exact data is not recorded.

**Allowed numbers (`allowedFromLegacyResults`).**
- Each stored value is kept within its class (p, n, df, estimate), so "N = 250" doesn't allow "t = 250".
- Windowed results contribute nothing (WS2-D3).
- Results stored without provenance count as unpinned (A5).
- **The researcher's own words:**
  - *Section writing:* the current instruction.
  - *Chat:* the current message.
  - *Task writing:* only the request and the researcher's answers. The planner's step input and earlier generated prose authorize nothing.

**Engine stamp (B2).** New legacy runs record `engine_version = academic-ai-legacy-analysis@1`. PLS, CB-SEM and the PLS bootstrap store their provenance: dataset version, content hash, engine and row window.

## 6. N1–N11: closure and hand-off

| # | Finding (severity) | Status | Closed by |
|---|---|---|---|
| **N1** | Model-written statistics saved into sections (Critical) | **Closed** | A4 (#37): quarantine before saving (WS2-D1); B1 record |
| **N2** | Legacy runs labelled "VERIFIED" (Critical) | **Closed** | A3 (#37): *computed* label with a tier; windowed runs excluded (WS2-D3); B2 engine stamp |
| **N3** | Client PATCH can set content, status and origin (High) | **Closed** | A2 (#37): DRAFT/USER_EDITED only, origin USER, an edit revokes approval (WS2-D4) |
| **N4** | Task long-form output and XLSX/CSV carry unchecked numbers (High) | **Closed** | B4 (#42): `document.write` quarantine; XLSX/CSV from eligible results only (WS2-D5) |
| **N5** | Hand-made claims can look traced (High) | **Handed to WS3** | Behind `FF_GRAPH` (off) |
| **N6** | Claim text editable after approval (High) | **Handed to WS3** | Behind `FF_GRAPH` (off) |
| **N7** | Export has no provenance (High, split) | **Export part closed**; claim-to-section linking **handed to WS3** | B5 (#43): Word integrity and provenance appendix |
| **N8** | Weak number detection (Medium) | **Closed** | Group 1 (#36): the canonical guard on the P1-C detector; guard version `ws2-2` |
| **N9** | Legacy runs can be deleted or re-attached (Medium) | **Closed** | B3 (#41): deletion refused while attached or cited, inside one locked transaction; A3 (#37): windowed runs can't be attached |
| **N10** | PLS/CB-SEM jobs lack provenance (Medium) | **Closed** | B2 (#40): legacy engine stamp and provenance on PLS, CB-SEM and the bootstrap |
| **N11** | Chat restates numbers (Medium, flag only) | **Closed** | A5 (#37): flags on every chat path, never rewritten |

## 7. B1–B5 in brief

- **B1 (WS2-D2).**
  - Adds `section_versions.integrity`, and `sectionIntegrity()` in `src/server/integrity/section.ts`.
  - `generateSection` stores its model-mode result; `saveUserEdit` stores a person-mode scan against the section's attached analyses.
- **B2 (N10).**
  - `src/server/stats/legacy-provenance.ts` (`LEGACY_ENGINE`, `legacyProvenance`, `readProvenance`, `asLegacyResult`).
  - `runAnalysis` stamps the legacy engine. PLS, CB-SEM and the bootstrap job store provenance, and chat tiers stored results by it.
- **B3 (N9).**
  - `deleteRun` and "delete everything" for a dataset run in one transaction with the rows locked.
  - A run attached to a section, or cited by any stored record's sources, can't be deleted; nothing is removed.
  - "Delete file only" is unchanged. A run listed only as excluded does not block deletion.
- **B4 (N4).**
  - `src/server/tasks/task-integrity.ts` collects and tiers a task's results.
  - `document.write` is quarantined; `data.analyse` outputs record the provenance of the data read.
  - XLSX sheets and a Provenance sheet are built from eligible results. CSV is one long table (`source | table | row | column | value`) with a byte-order mark and CRLF line endings.
  - With no eligible result there is no file.
- **B5 (N7, export part).**
  - `src/server/integrity/appendix.ts` builds a bilingual appendix, deterministic for identical inputs.
  - Its parts:
    - a statement and marker legend;
    - a sections table (written by, approved, check, traced, replaced by marker, untraced, record);
    - untraced numbers as written, for text kept as written only;
    - an analyses table (tier, engine, dataset version, content hash; status used, excluded (windowed) or no longer available);
    - a list of text the guard did not check.
  - **Thesis export:** the appendix comes after the references, on a new page. A section with no stored record is scanned in person mode at export, labelled *checked at export*, and the result is not stored.
  - **Task Word file:** windowed tables are left out, and the appendix is at the very end, after the References, on a new page.
  - Exporting never rewrites text, blocks the export, changes an approval or writes a version.

## 8. Migration 0017 and the Neon gate

**Migration.**
- `drizzle/0017_ws2_section_integrity.sql`: `ALTER TABLE "section_versions" ADD COLUMN "integrity" jsonb;`. It is additive and nullable, with no data change.
- It is the only WS2 migration and the latest migration on `main`. B2–B5 add none.

**Neon gate (B1, before #38 was merged).**
- Run on a temporary branch of the production Neon project, `ws2-b1-gate`.
- **Connections:** passed on both the direct and the pooled connection.
- **Suites:** the integration suite (878 assertions) and the runs-db suite (174).
- **Data:** row counts and fingerprints were unchanged.
- **SQL review:** a final check of the migration on the gate branch.
- **Migration hash:** the hash of `0017` recorded on the gate branch differs from the repository's only because of CRLF line endings, which came from a Windows checkout.

**Production.** The migration reaches production only through the normal build step (`db:migrate` in the Render build command). No manual database change was made. The B3, B4 and B5 production builds each report the migration step as successful (§10). No direct production query of `section_versions.integrity` is recorded.

## 9. Tests and CI

**Integration suite (`scripts/integration.ts`):**
- 878 assertions on the B1 Neon gate;
- 911 at B3 (20 new checks, including three rounds of concurrent attach and delete);
- 932 at B4 (37 new checks on the real handlers);
- 958 at B5 (26 new checks: thesis and task Word files, markers, manual numbers, missing records, pinned, windowed and no-longer-available runs, Arabic and English, identical `document.xml` text across exports, approved sections, no "verified" label, free-plan refusal, valid DOCX, appendix after the References).

**Full local regression (23 steps), all green at B4 and at B5:**
- tsc, lint, `git diff --check`, production audit (0 vulnerabilities);
- smoke; gateway 87; stats 361; runs 99; analysis 1329; knowledge;
- migrate and seed;
- integration; jobs 22; tasks-db 39; runs-db 174; graph 170; gateway-db 37; stats-db 105;
- build 88/88 pages;
- e2e 69/69 with flags off and 69/69 with flags on.

**GitHub CI on #42 and #43:** all six check runs succeeded on each PR head (two workflow runs, each with the type/lint/audit/unit/statistics, integration/jobs and build/browser jobs). #43 was reported mergeable (`clean`) before it was merged.

## 10. Production checks after merging

All checks were read-only, on Render service `academic-ai-app` (auto-deploys `main`). No redeploy, configuration, environment or database change was made. No secrets were read.

| Merge | Deploy | Result |
|---|---|---|
| #37 (A) | — | Post-merge health check: healthy |
| #40 (B2) | — | Live on `academic-ai-app` |
| #41 (B3) | `dep-darpcirncjis73ds8olg`, commit `1f24021` | Live 09:56:59 UTC. Build succeeded; migration step successful. Startup: queue, 12 handlers, workers. No errors, crashes or restarts. |
| #42 (B4) | `dep-darqjtgu01pc73edral0`, commit `d15024c` | Live 11:20:37 UTC. Build succeeded; migration step successful; seed complete. Ready in 417 ms; queue, 12 handlers, workers started. No errors, crashes or restarts. |
| #43 (B5) | `dep-darrugivcj2c73a96o0g`, commit `276939f` (tree identical to `ec24049`) | Live 12:51:40 UTC. Build succeeded; migration step successful with no new migration (`drizzle/` unchanged, latest `0017`); seed complete. Ready in 395 ms; queue, 12 handlers, workers started. No errors, crashes or restarts. |

**Details of the B4 and B5 checks:**
- **Trigger.** Each deploy was started by the new commit on `main` (not manual, no environment change). The previous deploy then became `deactivated`.
- **Events.** The only Render events were deploy/build started and ended, both successful. There were no `server_failed` or `server_restarted` events.
- **Warnings.** The only warning was the usual `pg` notice that some SSL modes are treated as `verify-full`, logged once at migration and once at startup.
- **Traffic.** No request logs appeared after go-live, and the service could not be reached from the check environment. So the new code had not yet handled production traffic, and none was sent to it.

## 11. Known limitations (carried forward)

1. **False quarantine of lowercase "section 3.4".** A lowercase section reference with a decimal can be quarantined. Deferred; it lives in `numbers.ts`.
2. **Sections with markers can still be approved.** This is by design: WS2 flags and quarantines, it does not block.
3. **Some prose is not checked.** Literature reviews, general answers, web-search answers, deep research, survey text and `summariseLiterature` are not guarded; their numbers are mostly other studies' findings cited by source. The task Word appendix lists such text as *not checked*. Task PDF, Markdown, TXT and PowerPoint files include it unchecked.
4. **The `/api/chat` route handler** is not directly tested; its chat-integrity logic is tested through the services.
5. **The UI shows none of it.** Integrity notices, chat flags and section records are stored, but the UI does not display them.
6. **Task prose citations don't protect runs.** Deletion protection reads only `section_versions.integrity`, so a run cited only in task prose (`prose.v1.integrity`) does not block deletion.
7. **Non-analysis tables** (a questionnaire, a list) can no longer be exported as XLSX/CSV through a task.
8. **Windowed tables in other task formats.** Task PDF, Markdown, TXT and PowerPoint files still include windowed result tables. B5 is Word only.
9. **DOCX bytes differ between exports**, because the library writes timestamps. Only the text of `word/document.xml` is deterministic.
10. **Provenance gaps.**
    - The PLS job report (`/api/pls/jobs/[id]/export`) keeps its fixed method note and has no B2 provenance line.
    - Content sent to `/api/artifacts` is the caller's own and is not checked.
11. **WS2-D2b was declined.** There is no database trigger making run results unchangeable.
12. **`src/server/context/sources.ts` tier labels** are unchanged.
13. **English-only headers.** XLSX/CSV headers are English, whatever the researcher's language.
14. **Other Render service.** `academic-ai` (`academic-ai-s1me`) deploys manually and is on `39da1f6`, without B2–B5.
15. **Temporary Neon branches.** `ws2-b1-gate`, `p1d-ws1-gate` and `p1d-ws1-m1m2-gate` still exist (cleanup is the owner's decision), and the GitHub branch `ws2-b1-gate` may too.

## 12. Carried outside WS2

- **WS3:** N5, N6 and N7 claim-to-section linking (§14).
- **Before `FF_RUNS` is enabled:** the app-level `test:runs:db` on a Neon branch (`P1D_REPORT.md` §11.1). WS2 did not change this gate.
- **A P1-D limitation:** a retry can bill a model call inside a tool twice (`P1D_REPORT.md` §11).
- **Assignment to confirm:** `P1D_REPORT.md` §12 groups `projectId` checks and metering with WS2/WS3. Which workstream owns them needs confirming when WS3 is planned.

## 13. Final WS2 status

- **Findings.** N1, N2, N3, N4, N8, N9, N10, N11 and the export part of N7 are **closed**. N5, N6 and N7's claim-to-section linking are **handed to WS3**.
- **Decisions.** WS2-D1, D2, D3, D4 and D5 are implemented; WS2-D2b was **declined**.
- **Flags.** `FF_RUNS` and `FF_GRAPH` remain **off**. WS2 changed no flag and no production configuration.
- **Guard and migration.** The guard version is **`ws2-2`**. The latest migration is **`0017_ws2_section_integrity.sql`**, the only one WS2 added.
- **`main`.** `276939f`, merge of #43, live on `academic-ai-app`.

## 14. Handover to WS3

**Items.**
- **N5:** a user can create claim nodes with any text and link them to computed values, so a hand-typed claim can look traced.
- **N6:** only `dataset_version` is immutable, so claim text can be edited after approval with no number check.
- **N7, claim part:** linking claims to manuscript sections.

**Where they are.** All three are behind `FF_GRAPH` (off); those routes return 404 in production.

**What WS3 can reuse:**
- the guard and its modes (§4);
- the tiers and allowed-number rules (§5);
- the section records (WS2-D2);
- the deletion protection (B3);
- the appendix builder (B5).
