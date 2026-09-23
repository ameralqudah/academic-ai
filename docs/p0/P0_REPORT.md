# P0 report — security, correctness and reliability

**Branch:** `claude/stoic-wozniak-5l0xmv`
**Plan:** `docs/p0/P0_PLAN.md` · **Architecture:** `docs/architecture/TARGET_ARCHITECTURE.md` (approved, with R1–R10)
**Status:** all thirteen P0 items are implemented, tested and committed. Phase 1 has **not** been started.

## Test results at the end of P0

Run locally against PostgreSQL 16 and a production build.

| Suite | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ |
| Lint | `npm run lint` | ✅ |
| Dependency audit | `npm audit --omit=dev` | ✅ 0 vulnerabilities (was 1 critical, 3 high, 2 moderate) |
| Smoke (pure logic) | `npm run test:smoke` | ✅ 1,906 checks |
| Statistics | `npm run test:analysis` | ✅ 1,328 assertions (was 1,221/1,222) |
| Knowledge providers | `npm run test:knowledge` | ✅ |
| Integration (PostgreSQL) | `npm run test:integration` | ✅ 807 assertions (was 769) |
| Durable jobs (PostgreSQL) | `npm run test:jobs` | ✅ 22 assertions (new suite) |
| Browser (Playwright) | `npm run test:e2e` | ✅ 63 passed, 1 skipped (desktop and mobile; the first run of this suite in the project) |
| Production build | `npm run build` | ✅ |

**Live checks** against `next start` (production build) with PostgreSQL:
- P0.3: registration, email verification, and reuse of the link refused.
- P0.4: a suspended user's session is ended.
- P0.5: the 11th wrong password is refused with 429.
- P0.10: the inline workers pick up a queued task after a restart, and `npm run worker` consumes a task on its own.

## Item by item

| # | Item | Result | Commit | Tests added |
|---|---|---|---|---|
| P0.1 | Next.js vulnerability | ✅ `next` 16.3.2 → 16.3.6 (critical RCE fixed; sharp 0.35.4). `image-size` and `uuid` pinned to patched majors via `overrides` (both checked to be safe for how pptxgenjs and exceljs use them). | `6bbfc12` | Smoke: PPTX, XLSX and the exceljs data-bar path. The stale router source-text test was replaced by a behavioural one. |
| P0.2 | Cross-user conversation access | ✅ `listMessagesOwned(conversationId, userId)` joins on the owner. All 5 callers use it. `/api/chat` rejects a foreign or unknown conversation id with the same 404. | `265d3a9` | Integration: the owner reads, another user reads nothing, the limit works, both refusals. Smoke: a guard against the unscoped reader. |
| P0.3 | Admin / email verification | ✅ Owner rights need a **verified** address. Verification flow: hashed single-use 24 h token, email on registration, API routes, page, and a Settings card. Google linking policy: provider-verified email required; no linking into an unverified password account; suspended accounts refused. Names escaped in emails. | `4f419be` | Smoke: truth tables for admin access and linking; escaping. Integration: the whole flow; unverified owner gets nothing and a verified one gets full access. Live check. |
| P0.4 | Session invalidation | ✅ `users.token_version` (migration 0009). The JWT is re-validated against the database at most once a minute (role, status, verification, version). Password change or reset, suspension and demotion end all sessions. Existing sessions survive the deploy. | `22fb4db` | Smoke: decision table. Integration: each account change bumps the version; the suspended re-check. Live: session ended within the window, API returns 401. |
| P0.5 | Login rate limiting | ✅ Failed password sign-ins limited to 10 per account and 50 per IP per 15 minutes (failures only, so a campus network isn't blocked). The client IP is the proxy-added `X-Forwarded-For` entry, which fixes the spoofing for **all** limits. | `c5b26bc` | Smoke: IP extraction, both windows, failure detection. Live: the 11th attempt gets 429, even with the correct password. |
| P0.6 | PLS-SEM / CB-SEM missing values | ✅ `numericColumns()` (via `toNumber`) replaces `Number(value)`: blanks are missing, not 0. Arabic-Indic digits and thousands separators now parse. | `5dc5ee5` | CFA and PLS n equal the complete cases; PLS with blanks equals PLS on hand-filtered data and differs from zero-filling. Reference fixtures added. |
| P0.7 | CFA standard errors | ✅ Standard errors from the analytic expected information matrix (Wishart). Factor-correlation SEs by the delta method. Fisher-scoring refinement brings estimates to the ML optimum; a 30-indicator model takes 0.75 s instead of 2.1 s. Reference loadings report no SE (as AMOS and lavaan do). | `a08ae22` | **Parity with lavaan 0.6-17 to about 1e-8** on Holzinger–Swineford and a simulated survey: loadings, SEs, residuals, factor correlations and their SEs. SE scaling with 1/√(n−1). |
| P0.8 | CFI/TLI | ✅ Exact null model: χ²₀ = (n−1)(Σ ln sᵢᵢ − ln\|S\|). CFI on Holzinger–Swineford goes from **0.953 (wrong) to 0.931 (lavaan: 0.931)**. df is no longer clamped (just-identified models are reported as such). The Heywood check now works. | `a08ae22` | χ², CFI, TLI, RMSEA and SRMR against lavaan; independent recomputation of CFI/TLI; just-identified model; constructed Heywood case. |
| P0.9 | HTMT | ✅ `PlsEstimate.rows` records the complete-case rows; HTMT, cross-loadings and formative VIF use exactly those. VIF uses the multiple R². | `c5d06a4` | HTMT against semTools (1e-10); VIF against R `lm()` (1e-9); 40 leading blank rows change nothing. **Shown to fail on the old code** (5 failures). |
| P0.10 | Durable background jobs | ✅ A pg-boss queue on the existing PostgreSQL. Leases on each task or job row with a heartbeat, so a job can never run twice. A reaper replaces resume-on-cold-start. `JOB_RUNNER` = `inline` (default, single service), `worker` (`npm run worker`) or `direct` (the old behaviour, the default on Vercel, and the rollback switch). If the queue is down, the job runs in-process under its lease. The bootstrap no longer blocks the event loop, and cancel works. | `a1ce9d9` | New `test:jobs` suite (22): leases; queued execution; 3 racing workers give 1 run; crash recovery; a live lease is respected; orphaned-job policy; direct path. Async bootstrap identical to the sync one, responsive and stoppable. Live checks for inline and worker modes. |
| P0.11 | CI and regression testing | ✅ `.github/workflows/ci.yml`: checks (types, lint, audit, smoke, statistics with lavaan parity, knowledge), database (PostgreSQL 16: migrate, seed, integration, jobs), and build plus e2e (Playwright). | `8636eb4` | **First CI run: all 3 jobs green** ([run 35832395418](https://github.com/ameralqudah/academic-ai/actions/runs/35832395418)): checks, database suites, and production build with browser tests. |
| P0.12 | Broken chat controls | ✅ `/api/chat` accepts `modelId` (checked against the plan), `roles` and `replyToMessageId`, and returns the stored message ids. The client passes its options through and swaps temporary ids for stored ones. Regenerate and edit no longer duplicate the question; the role picker and the model selector now take effect, including inside tasks via the request scope. | `f1e364a` | Integration: question stored once with two answers; edit; refusals; roles and model reach the task. Playwright: regenerate uses the stored ids and `replyToMessageId`; roles sent only when chosen. |
| P0.13 | Dead code | ✅ The 8 stale files in `src/server/context/` removed, after confirming there are no references, that they were never compiled, that each is an older copy of a live file, and that the build is green. Legacy code paths deliberately kept for the P1 consolidation. | `b6db7dc` | typecheck, lint, suites, build. |

## Database migrations (both additive and non-destructive)

| Migration | Change | Rollback |
|---|---|---|
| `0009_p0_token_version` | `users.token_version integer NOT NULL DEFAULT 0` | Redeploy the previous code; the column is ignored. |
| `0010_p0_job_leases` | `tasks.lease_owner`, `tasks.lease_expires_at`; `analysis_jobs.lease_owner`, `lease_expires_at`, `attempts integer NOT NULL DEFAULT 0`; two indexes | Redeploy the previous code, or set `JOB_RUNNER=direct` without a redeploy of code. |

pg-boss creates its own `pgboss` schema on first start. It is separate from the application tables.

## Deployment notes and actions for you

1. **Node ≥ 22.12** is now required (pg-boss 12). Render is configured for Node 22 already.
2. **Background jobs.** Nothing to do for a single Render web service: `JOB_RUNNER=inline` is the default and was added to `render.yaml`. A dedicated worker is an opt-in, commented block in `render.yaml` (it adds a billed service). **On Vercel** the default stays `direct` (the old behaviour); durable jobs there need `JOB_RUNNER=worker` plus `npm run worker` on a long-lived host. This is documented in `DEPLOY.md`.
3. **Check for leftover admin rights.** Before P0.3, a sign-in with the `OWNER_EMAIL` address wrote `role = 'ADMIN'` into the database whether or not the address was verified. Run `SELECT email, email_verified FROM users WHERE role = 'ADMIN';` in production and demote any account you don't recognise. Demotion now also ends that account's sessions.
4. **Existing users are unverified** (only the seeded admin is verified). Nothing is blocked. The owner must verify their address from Settings before owner rights apply, and password users who want to add Google sign-in must verify first.
5. **Rate limiting across instances** still uses the per-instance memory store unless `RATE_LIMIT_STORE=redis` with Upstash is configured. The IP fix applies either way.
6. **Branch protection.** Consider making the CI checks required on `main`.

## Deliberately not in this P0 scope (from the audit; candidates for the next phase)

These were in the audit but were not among the thirteen approved P0 items:
- **SSRF:** redirect and IPv6 hardening in `fetch-content.ts`.
- **Upload hardening:** zip bombs and decompression caps.
- **Production configuration:** `/api/health` information leak, CSP `unsafe-eval`, seed overwriting admin plan edits, object-storage setup.
- **AI layer:** fetch timeouts, metering of long-form and intent calls, plan-aware failover, sanitising provider errors, Anthropic stream error handling, silent chapter truncation.
- **Routing:** the resolved-reference → conversion bug, the `pls` keyword, `continueFrom` and `userAnswers` in most handlers.
- **Citations:** `[n]` in-text numbers vs. the alphabetical APA list.
- **PLS blindfolding Q²:** still non-standard (close to in-sample R²). It should be reimplemented, or relabelled until then.
- **Observability:** Sentry and tracing.

Several of these are security issues (SSRF, uploads, health endpoint) and are worth scheduling as the first step of the next phase.
