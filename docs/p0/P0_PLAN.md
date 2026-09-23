# P0 implementation plan — stabilise security, correctness and reliability

**Scope:** P0.1–P0.13 only (approved 2026-09-23). Phase 1 does not start until every item below is done, tested and reported in `docs/p0/P0_REPORT.md`.

**Branch:** `claude/stoic-wozniak-5l0xmv`.

**Rules for every item:**
- **Additive.** Existing routes, request and response shapes, and UI flows keep working. New fields are optional.
- **Non-destructive database changes only.** Columns are added with defaults. Nothing is dropped, renamed or narrowed.
- **Tests first where possible.** Each fix gets a test that fails before the fix and passes after it.
- **After each item:** `npm run typecheck`, `npm run lint`, `npm run test:smoke`, `npm run test:analysis`, `npm run test:knowledge`. Also `npm run test:integration` against a local PostgreSQL 16 when the item touches the database.
- **One commit per item** (or per tightly coupled group), with the result recorded in the report.

**Migrations:**

| Migration | Contents | Used by |
|---|---|---|
| `0009` | `users.token_version integer NOT NULL DEFAULT 0` | P0.3, P0.4 |
| `0010` | Lease columns on `tasks` and `analysis_jobs` (`lease_owner`, `lease_expires_at`), plus an index | P0.10 |

Both are additive and safe to apply while the old code is running. **Rollback** means redeploying the previous commit: the old code ignores the new columns, so no down-migration is needed.

---

## P0.1 — Next.js and dependency vulnerabilities

| | |
|---|---|
| Problem | `next@16.3.2` has a critical advisory (GHSA-2xp9-vwfh-vxw4, GHSA-p293-qw3h-jr36). Also `sharp <0.35.4` (high), `image-size ≤2.0.2` via pptxgenjs (high), and `uuid <11.1.1` via exceljs (moderate). |
| Change | `next` and `eslint-config-next` → `16.3.6` (latest patch in the same minor). `sharp` comes with Next's patched range. `overrides`: `image-size` → `^2.0.4`, `uuid` → `^11.1.1`. |
| Why the overrides are safe | pptxgenjs lists `image-size` as a dependency but its dist bundle never imports it. exceljs imports `{ v4 }` from `uuid`, which v11 still exports for CommonJS. |
| Files | `package.json`, `package-lock.json` |
| Tests | `npm audit --omit=dev` reports 0 high/critical. `next build` succeeds. The smoke suite's DOCX, XLSX and PPTX generation paths still pass. A new smoke check generates a PPTX and an XLSX with a conditional-format rule, which exercises the `uuid` path. |
| Rollback | Revert the commit, which restores the old lockfile. |

## P0.2 — Cross-user conversation access (IDOR)

| | |
|---|---|
| Problem | `conversationsRepo.listMessages(conversationId)` is called without an ownership check in `src/app/api/chat/route.ts:142`, `src/server/context/sources.ts:129` and `src/server/services/task.service.ts:132`. Another user's messages can reach the prompt. |
| Change | New repository function `listMessagesOwned(conversationId, userId, limit)`, which joins `ai_conversations` on `user_id`. All three call sites switch to it, so a foreign or unknown conversation yields `[]`. Any remaining unscoped callers of `listMessages` are audited and switched as well. |
| Files | `src/server/repositories/conversations.repository.ts`, the three call sites, and any further callers found by grep |
| Tests | Integration: user A's conversation messages are **not** returned for user B, with the same limit semantics for the owner. Smoke: a source-level guard that no module outside the repository calls the unscoped reader. |
| Rollback | Revert the commit. There is no data change. |

## P0.3 — Admin / owner escalation and email verification

| | |
|---|---|
| Problem | `OWNER_EMAIL` grants admin and the top plan by email string alone, and sign-up never verifies email. Google sign-in with `allowDangerousEmailAccountLinking: true` can link into an unverified password account. |
| Change 1: owner rights | Owner rights require a **verified** email: `hasAdminAccess(user)` becomes `role === 'ADMIN' \|\| (isOwnerEmail(email) && emailVerified)`. The flag travels in the session (`session.user.emailVerified: boolean`) and is re-validated from the DB (see P0.4). The billing and subscription owner checks read `users.emailVerified` from the DB. |
| Change 2: verification flow | `requestEmailVerification(userId, locale)` and `verifyEmail(uid, token)` reuse the existing hashed single-use token table (`email-verify:` prefix, 24 h TTL). The email is sent on registration and on request (`POST /api/auth/verify-email/resend`, auth-required and rate-limited). `POST /api/auth/verify-email` consumes the token, and a `/[locale]/verify-email` page drives it. A banner in the app shell shows for unverified accounts. **Unverified users can still use the app**; only owner/admin elevation and account linking require verification. |
| Change 3: Google linking | Linking stays allowed only when it is safe. A `signIn` callback denies a Google sign-in that would link into an existing account that is **unverified and has a password**. It also denies Google profiles whose `email_verified` is not true. Otherwise linking continues to work. `events.signIn` marks `emailVerified` for users signing in with a verified Google profile. |
| Change 4: registration | The duplicate-email 409 is kept, because the UI depends on it. Account enumeration is noted as Low for P1. |
| Files | `src/server/auth/{index,owner,guards}.ts`, `src/server/http/api.ts`, `src/server/services/{account,billing,subscription}.service.ts`, `src/server/email/templates.ts`, `src/app/api/auth/verify-email/**`, `src/app/[locale]/(auth)/verify-email/page.tsx`, `src/components/app/*` (banner), `messages/{en,ar}.json` |
| Tests | Unit: `hasAdminAccess` truth table (role × owner × verified). Integration: register → token issued → verify → `emailVerified` set; expired and reused tokens rejected; an unverified user with `OWNER_EMAIL` gets no admin access and no owner plan; a verified one does. Smoke: the Google linking policy function truth table. |
| Rollback | Revert the commit. Additive only: `emailVerified` already exists. |

## P0.4 — Session invalidation

| | |
|---|---|
| Problem | 30-day JWT; suspension, demotion and password reset don't take effect; Google sign-in ignores suspension. |
| Change | Migration `0009` adds `users.token_version`. The `jwt` callback stores `tv` and `checkedAt` at sign-in. On later calls, when `checkedAt` is older than **60 s**, it re-reads `role`, `status`, `locale`, `emailVerified` and `token_version`, using a 30 s per-process cache. It returns `null`, which signs the user out, when the user is missing, `SUSPENDED`, or `token_version` differs. The `signIn` callback rejects suspended users for every provider. `resetPassword` and `changePassword` increment `token_version`. The admin actions that suspend or change a role also increment it. |
| Files | `src/server/db/schema.ts`, `drizzle/0009_*.sql` + meta, `src/server/auth/index.ts`, `src/server/auth/session-check.ts` (new, pure logic), `src/server/services/account.service.ts`, `src/server/services/admin.service.ts` / `src/server/repositories/users.repository.ts` |
| Tests | Unit (pure): `evaluateToken(token, freshUser, now)` returns keep / refresh / revoke for suspension, demotion, version bump and missing user. Integration: `resetPassword` bumps `token_version`; admin suspend and demote bump it. |
| Rollback | Revert the code. The column stays and is harmless. |

## P0.5 — Login rate limiting and trusted client IP

| | |
|---|---|
| Problem | The credentials callback is not rate-limited. `clientKey` trusts the first (client-controlled) `x-forwarded-for` entry. |
| Change | `clientIp(request)` uses the **rightmost** `x-forwarded-for` entry by default. That entry is appended by the nearest trusted proxy and cannot be spoofed on Render or Vercel. `TRUSTED_PROXY_HOPS` (default 1) is configurable, and `x-real-ip` is used only when `TRUST_X_REAL_IP=true`. The `POST` handler of `/api/auth/[...nextauth]` is wrapped: for `callback/credentials` it applies two limits before Auth.js runs — `login-ip` (default 20 per 15 min) and `login-email` (default 10 per 15 min, keyed by the normalised email hash) — and returns a 429 in the shape Auth.js clients handle. The existing limiter store (memory or redis) is reused. |
| Files | `src/server/http/rate-limit.ts`, `src/app/api/auth/[...nextauth]/route.ts`, `src/config/env.ts`, `.env.example` |
| Tests | Unit: IP extraction for single, multiple and spoofed headers. Smoke: the 21st attempt from one IP and the 11th for one email are limited; other emails and IPs are unaffected. |
| Rollback | Revert the commit. |

## P0.6 — PLS-SEM / CB-SEM missing values

| | |
|---|---|
| Problem | `Number(null) === 0`: blank cells become real zeros in `pls.service.ts` (4 sites) and `data-analysis.service.ts` (1 site, also the histograms). `"1,234"` and Arabic-Indic digits become NaN. |
| Change | One helper, `numericColumns(loaded)`, in `src/analysis/numeric-columns.ts`, built on the existing `toNumber` (null, empty or unparseable → `NaN`, which the algorithms already drop by listwise deletion). All 5 sites use it. |
| Tests | Regression: a dataset with blanks gives the same PLS and CFA estimates as the same data with those rows removed, and a different result from zero-filling. Arabic-Indic digits and thousands separators parse. A histogram does not count blanks. |

## P0.7 — CFA standard errors

| | |
|---|---|
| Problem | Loading standard errors are divided by √p (the number of indicators) instead of using the sample size, and the formula is heuristic. Factor-correlation standard errors ignore measurement error. |
| Change | Analytic **expected information matrix** for ML covariance structures: `I_ij = (n−1)/2 · tr(Σ⁻¹ ∂Σ/∂θᵢ Σ⁻¹ ∂Σ/∂θⱼ)`, with closed-form ∂Σ/∂θ for loadings, residual variances and factor (co)variances. `Cov(θ̂) = I⁻¹`. Loading SE, z and p come from its diagonal. Factor-correlation SE comes from the delta method on (φ_ab, φ_aa, φ_bb). The same machinery adds **Fisher-scoring refinement** after the existing pattern search, so estimates reach the ML optimum precisely (step-halving guard; falls back to the pattern-search solution if scoring does not improve the fit). |
| Also fixed | `df` is no longer clamped to ≥1 (just-identified models report df = 0 with a warning, and fit p/RMSEA/TLI are undefined). The Heywood check now detects residual variances at the lower bound. |
| Tests | Reference values from **lavaan 0.6-17** (`likelihood = "wishart"`, `information = "expected"`) for a fixed simulated dataset and the Holzinger–Swineford-style 3-factor model, committed as `evals/fixtures/references/cfa-*.json`. Estimates within 1e-3, SEs within 2%, χ² within 0.5%. The SE scales as 1/√(n−1) when the data is duplicated. |

## P0.8 — CFI / TLI

| | |
|---|---|
| Problem | The null-model χ² is the sum of pairwise −log(1−r²). This inflates CFI and TLI; for example, the correct CFI of 0.940 is reported as 0.982. |
| Change | Exact ML independence model: `χ²_null = (n−1) · (−ln|R|)`, where R is the observed correlation matrix, with `df_null = p(p−1)/2`. |
| Tests | CFI, TLI and RMSEA match lavaan (Wishart) within 1e-3 on the fixtures. The 12-item r = .5 example gives the exact value. |

## P0.9 — HTMT, cross-loadings and outer VIF row alignment

| | |
|---|---|
| Problem | `assessment.ts` uses `data.slice(0, estimate.n)`, the first n raw rows. After listwise deletion these do not match the complete cases behind the construct scores. |
| Change | `PlsEstimate` gains `rows: number[]` (the complete-case row indices, additive). HTMT, cross-loadings and formative VIF select exactly those rows. Formative outer VIF uses the proper **multiple R²** (regressing each indicator on its siblings via the correlation-matrix solve that inner VIF already uses) instead of the largest pairwise r². |
| Tests | With injected missing rows: HTMT equals HTMT computed on the manually filtered complete data, and cross-loadings likewise. VIF equals 1/(1−R²) from an explicit OLS on the fixture. Where seminr is available, the values also match seminr. |

Files for P0.6–P0.9: `src/analysis/numeric-columns.ts` (new), `src/analysis/inference/cbsem/cfa.ts`, `src/analysis/inference/pls/{algorithm,assessment}.ts`, `src/server/services/{pls,data-analysis}.service.ts`, `scripts/analysis.ts`, `evals/fixtures/**`, `scripts/references/*.R` (a generator for the reference fixtures; it is not needed at runtime).

## P0.10 — Durable background jobs

| | |
|---|---|
| Problem | Agent tasks, deep research and PLS bootstrap run as `void promise` in the web process. They are lost on restart, frozen on serverless, and duplicated across instances (`resumeInterrupted` on every cold start). The bootstrap blocks the event loop, so cancellation cannot run. |
| Queue | **pg-boss** on the existing Postgres, with queues `task.run` and `analysis-job.run`. Enqueue uses a `singletonKey` = entity id, so a task can't be queued twice. |
| Leases | Migration `0010`. A worker must claim `tasks`/`analysis_jobs` with an atomic `UPDATE … SET lease_owner, lease_expires_at = now()+120s WHERE id=? AND (lease_expires_at IS NULL OR lease_expires_at < now())`, then heartbeat every 30 s. No lease means no execution, which eliminates duplicate runs. |
| Reaper | A pg-boss scheduled job (every minute) replaces cold-start resumption. It re-enqueues tasks in `QUEUED/PLANNING/RUNNING/REPLANNING` whose lease has expired (or that were never leased and are older than 2 min), after `recoverStranded`. It re-queues `analysis_jobs` with expired leases once and fails them on the second expiry (`jobs.orphaned`). `resumeInterrupted` and `failStale` are no longer called on the request path. |
| Runners | `JOB_RUNNER=inline` (default, preserves today's single-service deploy): the web process also consumes the queues, started from `src/instrumentation.ts` in the Node.js runtime. `JOB_RUNNER=worker`: web only enqueues, and `npm run worker` (`src/worker/main.ts`) consumes; a Render background worker is added to `render.yaml`. **Fallback:** if pg-boss cannot start (e.g. missing schema privileges), enqueue falls back to today's in-process execution with an error log, so functionality is never lost. |
| Bootstrap | `bootstrapPlsAsync` yields to the event loop every N resamples, so progress writes and the cancellation check actually run. Results are identical to the synchronous version for the same seed (tested). |
| Files | `package.json` (+`pg-boss`), `src/server/jobs/{queue,leases,reaper,runner}.ts` (new), `src/instrumentation.ts` (new), `src/worker/main.ts` (new), `src/server/services/{task,deep-research,pls,startup}.service.ts`, `src/server/repositories/{tasks,analysis-jobs}.repository.ts`, `src/analysis/inference/pls/bootstrap.ts`, `src/server/db/schema.ts`, `drizzle/0010_*`, `next.config.ts` (`serverExternalPackages`), `render.yaml`, `DEPLOY.md`, `.env.example` |
| Tests | Integration (local Postgres): (1) enqueue → worker completes the task; (2) two workers racing on one task, only one claims it, 0 duplicate step executions; (3) killed worker (lease expires) → reaper re-enqueues → completes; (4) analysis job orphaned twice → FAILED with a reason; (5) fallback path when the queue is unavailable. Unit: async bootstrap equals sync bootstrap for the same seed; `shouldStop` honoured mid-run. |
| Rollback | `JOB_RUNNER=direct` restores the old `void promise` execution without a redeploy of code. Reverting the commit is also safe, because the lease columns are ignored by the old code. |

## P0.11 — CI and automated regression tests

| | |
|---|---|
| Change | `.github/workflows/ci.yml`, run on every push and PR: `npm ci`; typecheck; lint; `npm audit --omit=dev --audit-level=high`; smoke; analysis (includes the stats reference fixtures); knowledge; integration against a `postgres:16` service (migrate + seed); `next build`. Playwright e2e runs as a separate job on `main` and on manual dispatch, because it needs a built app and browsers. |
| Tests | The workflow itself. It runs green on the branch before merge. |
| Note | Pushing workflow files requires the GitHub token to have `workflow` scope. If the push is refused, the file is kept in `docs/p0/ci.yml` with instructions. |

## P0.12 — Broken chat controls

| | |
|---|---|
| Problem | In the routed (`/api/chat`) path: (1) Regenerate re-sends the question as a new user message; (2) the role picker's roles are dropped; (3) the model selector is never sent; (4) messages sent in this session have client-only ids, so edit and regenerate on them fail until reload. Edit also records the question twice. |
| Change | `/api/chat` accepts optional `modelId`, `roles` and `replyToMessageId`. With `replyToMessageId` (regenerate/edit), only the assistant reply is recorded, under that existing user message (via the existing regenerated-answer service). `roles` are passed to the task context (`analysisHints.roles`) and read by the `data.analyse` handler. `modelId` is honoured through the existing model-access check (plan-restricted) on both the fast path and task creation. The response and stream now return `{ userMessageId, assistantMessageId }` (JSON field or `ids` SSE event), and the client replaces its temporary ids. The client's `send()` passes its options into `runRouted`; `regenerate` and `editMessage` pass `replyToMessageId`. |
| Files | `src/app/api/chat/route.ts`, `src/server/services/chat.service.ts`, `src/components/agent/agent-chat.tsx`, `src/server/tasks/handlers.ts` (roles), `src/server/services/task.service.ts` (hints) |
| Tests | Integration: a regenerate request records exactly one new assistant message whose parent is the original question, and no new user message. `roles` reach the task context. Smoke: schema accepts the new fields; the client no longer drops `send` options (source guard). |
| Rollback | Revert the commit. All new request fields are optional. |

## P0.13 — Remove dead code only after confirming it is unused

| | |
|---|---|
| Candidates | `src/server/context/{Ai.service · TS, Analysis, Analysis · TS, Handlers · TS, Language · TS, Long form · TS, Smoke · TS, language.ts.txt}` |
| Confirmation | (1) No import or `require` anywhere references them (grep for each basename). (2) None has a `.ts`/`.tsx` extension, so none is compiled. (3) Each is a strictly older copy of a live file (diffed). (4) typecheck, lint, build and all suites pass after removal. |
| Kept | Everything else. Unreachable UI and legacy API code (`/api/agent`, dead modes in `agent-chat.tsx`) is **not** removed in P0; it goes in P1-F consolidation behind flags. |
| Rollback | Revert the commit. The files are recoverable from git history. |

---

## Order of work

P0.1 → P0.2 → P0.3 + P0.4 (shared auth callback, one commit each) → P0.5 → P0.6–P0.9 (stats, one commit each) → P0.10 → P0.12 → P0.13 → P0.11 (CI last, so it runs the complete suite) → `P0_REPORT.md`.
