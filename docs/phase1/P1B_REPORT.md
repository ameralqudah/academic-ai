# P1-B report: Production Model Gateway

**Date:** 2026-09-23 · **Plan:** `docs/phase1/P1B_PLAN.md` (audit findings G-1 to G-13) · **Status:** implemented, including the final review decisions in §11; all suites green locally; ready for merge. `FF_GRAPH` stays off in production. P1-C has not been started.

**Goal.** Every model call in Academic AI goes through one controlled path. That path:

- knows which user the call is for, and looks up that user's plan itself;
- never gives a user a model class above their plan, including when it retries or fails over;
- reserves quota before any provider is contacted;
- has a hard timeout and a bounded number of attempts;
- leaves a durable record of every attempt, including failed and cancelled ones.

## 1. What was built

`src/server/ai/gateway/` (server only; a smoke gate fails the build if client code imports it):

| File | Role |
|---|---|
| `contract.ts` | zod schemas for the normalised request, content parts (text, image, tool call, tool result), tools, adapter results, usage, the routing decision, the response and stream events. Every input is parsed at the boundary, and every adapter output is validated before it leaves the adapter. |
| `errors.ts` | `GatewayError` with 15 error classes. Classification uses the status code and the provider's error type (`classifyHttp`, `classifyThrown`). `redact` removes key-shaped strings. `toAppError` maps to the existing public codes (`AI_UNAVAILABLE`, `PLAN_LIMIT`, …) without provider bodies. |
| `policy.ts` | Timeouts per kind, the attempt budget (3), backoff (500 ms / 1,500 ms, ±20 % jitter, `retry-after` honoured up to 10 s), the retry and failover order. The clock is injectable. |
| `routing.ts` | Model classes, the entitlement per tier, and `route()`, which returns an observable `RoutingDecision`. |
| `quota.ts` | `reserve` / `commit` / `release` / `releaseExpired` on the existing plan limits and the existing ledger (`usage_tracking`). |
| `metering.ts` | One `ai_usage_events` row per attempt; cost at the model that served; `recordToolExecution`. |
| `tools.ts` | `defineTool`, `capabilityTool` (a projection of the existing capability registry, not a new registry), permission and argument validation. |
| `gateway.ts` | `createGateway(deps)`: `generate`, `stream`, `generateStructured` (one bounded repair), `toolCall`, `embed`. |
| `compat.ts` | The strangler facade: an `AIProvider` whose `complete` and `stream` go through the gateway. |
| `index.ts` | Production dependencies (adapters built from environment keys, plan lookup, project check via `requireProjectRole(VIEWER)`, notices), `gateway()`, `predictRoute`. |
| `adapters/` | `anthropic`, `openai`, `google` (raw `fetch`, no SDKs; native tools, native structured output, streaming, embeddings for OpenAI and Google) and `fake` (scripted, for tests only; never registered in production). |

**Database:** migration `drizzle/0012_p1b_model_gateway.sql` is additive. It adds three tables, each with status `CHECK` constraints:

- `ai_usage_events`
- `ai_quota_reservations` (idempotency key unique per user)
- `ai_tool_calls`

**Request scope** (`request-scope.ts`) now also carries `projectId`, `taskId`, `jobId` and `runId` (`withCallIds`).

**Removed:**

- `src/ai/providers/{anthropic,openai,google}.ts`, replaced by the adapters;
- `src/server/ai/resilient-provider.ts`;
- `runWithFailover`, `withFailover`, the alternative-provider logic, and the tier logic in `model-requirements` and `model-router`;
- the silent provider substitution in `registry.resolveProvider`.

## 2. Audit findings and how each was fixed

| # | Finding | Fix | Tests |
|---|---|---|---|
| G-1 | No timeout or cancellation | Every attempt runs under `AbortSignal.any([caller, timeout])`. Timeouts: generate 120 s, structured 60 s, tools 90 s, stream 180 s in total with 30 s idle (first event included), long-form round 240 s, embed 30 s. `/api/chat` passes `request.signal`; the legacy section chat aborts on stream `cancel()`. | unit G/H/R, E/O; db E/O |
| G-2 | Premium bypass on failover | Failover candidates are filtered to the entitlement **and** to the class first routed to. When the user chose a model explicitly, the call never fails over to another provider. | unit H/M; db L/M "never fails over to the premium model"; mutation checks |
| G-3 | Premium when the plan is lost | The gateway requires a user in scope and looks the plan up from the user id on every call (30 s cache). No scope: the call is refused. Plan lookup error: the call is refused. The deep-research job now runs in `runForUser(owner)` + `withCallIds({jobId, projectId})`, and tasks run in `withCallIds({taskId, projectId})`. | unit A/T; db L/M (worker with `jobId`, no scope, router and resolver paths) |
| G-4 | Tasks bypass quota | Every call reserves. Long-form rounds, task handlers and the planner are now subject to the plan (§4). | db K/N |
| G-5 | Unmetered calls | Intent classification, planning, long-form rounds, failed calls and streams that fail before the first chunk all write `ai_usage_events` rows. | db I/J |
| G-6 | Check-then-act race | The reservation is taken under a per-user `pg_advisory_xact_lock`, and open reservations count against the plan. | db K/N: 20 concurrent gateway calls with 5 left → exactly 5; 30 concurrent `reserve()` × 5 rounds → never more than 5 |
| G-7 | Stacked retries (up to 5 attempts) | The gateway is the only retry layer: at most 3 attempts (primary → alternative → primary). Only `rate_limit`, `timeout`, `network` and `outage` are retried. | unit G/H/R; integration "no stacked failover in the service" |
| G-8 | Errors classified by regex; raw bodies reach the client | Classification uses status plus provider error type. Provider detail goes only to the server log, redacted and truncated; `AppError.details` carries no provider body. | unit P; analysis classification tests |
| G-9 | Google key in the URL | The key is sent in the `x-goog-api-key` header. | unit B; smoke (Gemini adapter with a fake fetcher) |
| G-10 | Fragile JSON parsing | Intent, planner and diagram extraction use `generateStructured` with zod schemas and native structured output, plus one bounded repair. | unit D; existing intent, planner and diagram suites |
| G-11 | Cost priced at the requested model | Cost is computed per attempt at the model that served. | unit I/J |
| G-12 | Silent provider substitution | Removed. `resolveProvider` returns the gateway facade; a missing choice is an `entitlement` or `not_configured` error, never a quiet swap. | db L/M resolver path; smoke registry tests |
| G-13 | No durable per-call record | `ai_usage_events`: one row per attempt, with `call_id`, scope ids, purpose, kind, provider, model, class, status, error class, finish reason, tokens, cost, latency, retry count, routing decision and reservation. | db I/J |

## 3. Call-site migration (strangler)

All 22 model-calling paths from the audit (§1.2 of the plan) now go through the gateway.

| Path | Now |
|---|---|
| `ai.service.runCompletion` (13 callers: titles, sections, general answer, extraction, sources, deep-research plan, evidence, gaps, synthesis, survey items, summaries) | `provider.complete` on the facade. The per-call `recordAIUsage` and `runWithFailover` were removed. |
| `ai.service.streamGeneralAnswer` (`/api/chat`) | Facade `stream`, with the route's `request.signal`. Its own metering was removed. |
| `ai.service.streamChat` (`/api/ai/chat`) | Facade `stream`. An `AbortController` is aborted on stream `cancel()`; the reply is labelled with the model that actually served. Its own metering was removed. |
| `tool.service.runTool` | The gateway meters it; `recordSimple(TOOL_RUN)` is kept for the tool counter. |
| `agents/intent.classifyIntent` | `gateway().generateStructured(RAW_INTENT)`, internal step. A schema failure gives `unclear`. |
| `server/ai/long-form` | `longForm: true`. Round 1 counts as the request; later rounds are continuations. Every round is metered. |
| `tasks/planner` (2 calls) | `generateStructured(PLAN_SHAPE)`, internal step. The output still goes through `parsePlan`. |
| `diagrams/extract` | `generateStructured(z.record(...))`. |
| `research/pipeline` (deep-research job) | Through `runCompletion`, now inside `runForUser(owner)`. |
| `agents/orchestrator` (legacy `/api/agent`) | Through the ai.service functions above. |

**Remaining direct provider calls: none outside `src/server/ai/gateway/adapters/`.** The smoke gate "Model Gateway: no path around it" fails the build on any of the following:

- a provider host outside the adapters;
- any vendor SDK import;
- client code importing the gateway, registry or router;
- any `implements AIProvider` class;
- a direct adapter call from application code;
- a `NEXT_PUBLIC_*KEY/SECRET/TOKEN` variable;
- any caller of `recordAIUsage` (the legacy per-call ledger writer).

The remaining `.complete(` and `.stream(` calls in `ai.service`, `tool.service` and `long-form` are on the gateway facade.

## 4. Quota semantics: what changed

The ledger is still `usage_tracking`, and the plan limits and the admin dashboard read it as before. What changed:

| Situation | Before | Now |
|---|---|---|
| A user-visible generation (chat answer, section, titles, tool, chapter, review, deep-research call) | 1 request plus words, recorded by each call site | The same: 1 `AI_REQUEST` plus `GENERATED_WORD`, written by the gateway only, in one transaction with the reservation settlement |
| Intent classification, task planning | Not counted, not metered | Metered in `ai_usage_events`. **Not counted** as a request (`AI_REQUEST` amount 0, so one message is still one request). **Refused once the plan has no request or word left**, so a used-up plan does not keep paying for a classification of every message. |
| Long-form chapter or review | Not counted, not metered (G-4, G-5) | Round 1 counts as the request and needs headroom. Later rounds are continuations: admitted at the limit, so a chapter is not cut off mid-way. Every round is metered, and all words count. |
| Structured-output repair | n/a | A continuation of the first attempt: metered, not counted. |
| Failed call with no provider usage | Nothing recorded | Failed attempt rows are written; the reservation is **released** (not counted). |
| Stream cut off after text was delivered | Counted only if text was delivered, priced at the requested model | `cancelled` row with estimated usage; delivered text **counts** (1 request plus its words). |
| Concurrent requests near the limit | All could pass the check | Exactly the remaining number succeed. |
| A zero word estimate on a plan whose words are used up | Passed | Refused (at least one word of room is required). |
| Crashed worker | n/a | Its reservation stops counting at 15 minutes; the reaper settles it. |
| No user in scope, or the plan lookup fails | Routed as tier unknown (could reach premium) | Refused. |
| Unknown tier in a routing call | Every provider offered | Routed as `free`. |

`assertCanUseAI` stays in its call sites as an early fast-fail for a better message. The gateway reservation is authoritative.

## 5. Security

- **Keys:**
  - read only by the adapters, from server environment variables;
  - never in a URL (Google uses a header);
  - never in logs, errors, usage rows or tool records;
  - key-shaped strings in provider bodies are redacted before they are logged;
  - no `NEXT_PUBLIC_` variable holds a key (smoke gate).
- **Tool calls:**
  - a call to an undeclared or unpermitted tool is rejected (`tool_validation`) and recorded;
  - arguments are validated with zod; invalid ones are recorded as `raw_arguments` with the reason, and never treated as data or silently repaired;
  - tool results given back to the model are marked in the contract as untrusted data;
  - execution itself stays with the run engine (P1-D).
- **Cross-project:**
  - a `projectId` in scope or per call is checked with the existing `requireProjectRole(VIEWER)` before routing; a project the user cannot see gives `NOT_FOUND`;
  - usage rows carry the right project.
- **Datasets:** the gateway builds no context. The context envelope still sends a dataset's column list and row count, never its rows.
- **Research results:**
  - no gateway tool maps to a Research Graph write of results;
  - computed results stay writable only by `recordRun` with an engine actor (P1-A.1), and the gateway never constructs one;
  - the LLM cannot create or alter a `verified` value.
- **Excessive tokens:**
  - output tokens are capped per plan by the gateway (§11); the contract also caps `maxOutputTokens` (64k), messages (400), system prompt size and parts;
  - a request estimated to exceed the model's context window fails as `context_length` before any provider call.
- **Observability:**
  - `ai.gateway.request`, `.route`, `.attempt`, `.tool` and `.result` log ids and metadata only, never prompts, outputs, dataset contents or keys;
  - the durable counterparts are `ai_usage_events` and `ai_tool_calls`.

## 6. Tests

### 6.1 Results (all on the final head, local PostgreSQL 16)

| Suite | Result |
|---|---|
| Typecheck (src + scripts) | ✅ |
| Lint | ✅ 0 problems |
| `npm audit --omit=dev --audit-level=high` | ✅ 0 vulnerabilities |
| Smoke | ✅ all passed (includes the new gateway gate) |
| Analysis (statistics) | ✅ 1,329 |
| Knowledge providers | ✅ |
| **Gateway unit** (`test:gateway`, new, CI checks job) | ✅ 87 / 87 |
| **Gateway database** (`test:gateway:db`, new, CI database job) | ✅ 37 / 37 |
| Integration | ✅ 801 (was 807: seven assertions on the removed `runWithFailover` were replaced by four gateway assertions and the six-scenario gateway failover section) |
| Jobs | ✅ 22 |
| Research Graph | ✅ 170 |
| Production build | ✅ |
| Browser tests, `FF_GRAPH=false` | ✅ 66 passed, 1 skipped (an earlier run on this branch had 1 flaky test, see below) |
| Browser tests, `FF_GRAPH=true` | ✅ 66 passed, 1 skipped |

**The flaky browser test** is `chat.spec.ts` "an abandoned question can be dismissed from the top of the chat". In one of the five full runs on this branch it failed once and passed on its automatic retry. It is fully stubbed in the browser (`/api/tasks/*`) and touches no model call. It is a race inside the test: the UI removes the task before the stubbed DELETE handler sets its flag, and the test reads the flag once instead of polling. It is not changed in this PR (out of scope). The fix is one line: `await expect.poll(() => cancelled).toBe(true)`.

**Live provider checks** (`test:gateway:live`, new) run only with `GATEWAY_LIVE=1` and real keys. They check text generation, streaming, native structured output and a forced native tool call per configured provider. **They are not in CI**; no CI job depends on a paid API.

### 6.2 Coverage of the test areas A–T

| Area | Where |
|---|---|
| A Contract | unit A/T |
| B Adapters | unit B (request shapes, normalisation, usage, finish reasons, images, Google key header, thinking-rejection retry) |
| C Tool calling | unit C/Q, db C/Q |
| D Structured output | unit D (native, repaired, failed) |
| E Streaming | unit E/O, db E/O |
| F Timeouts | unit G/H/R (hung attempts), E/O (idle timeout) |
| G Retries | unit G/H/R |
| H Failover | unit H/M, G/H/R; integration failover section |
| I Metering | unit I/J, db I/J |
| J Cost | unit I/J; smoke cache economics |
| K Quota | db K/N |
| L Plan propagation | db L/M |
| M Premium protection | unit H/M, db L/M |
| N Concurrency | db K/N |
| O Cancellation | unit E/O, db E/O |
| P Error classification | unit P; analysis |
| Q Malicious tool arguments | unit C/Q, db C/Q |
| R Outage | unit G/H/R |
| S Context length | unit G/H/R |
| T Cross-project | unit A/T, db T |

### 6.3 Mutation checks

Each guard was removed in turn, and the suites were run against the mutant:

| Mutation | Caught by |
|---|---|
| Remove the entitlement filter from routing | 5 unit + 5 db failures |
| Remove the class filter from failover | 1 unit failure |
| Remove the non-retryable guard | 4 unit + 2 db failures |
| Remove the per-user reservation lock | 1 db failure. The first run showed that the gateway-level race alone did not catch it, so a direct `reserve()` race was added (6–7 grants for 5 without the lock). |
| Replace the at-least-one-word check with the raw estimate | 1 db failure |
| Remove the project access check (`prepare` and `embed`) | 2 unit + 3 db failures |
| Put back the premium fallback for a plan with no eligible model | 1 unit + 2 db + 1 smoke failures |
| Remove the output-cap clamp | 3 unit failures |

### 6.4 Test assertions that were replaced

These tests checked the removed implementation, and each was re-pointed at its gateway equivalent (details in the diffs of `scripts/smoke.ts`, `scripts/analysis.ts` and `scripts/integration.ts`):

- Source-text checks on `build(chosen…)`, `runWithFailover`, `resilient` and `error.status === 429` now check the gateway files and the absence of the old paths.
- Failover scenarios now run through a real gateway with `FakeAdapter`.
- The smoke scenario "no known user" now expects routing as `free`. It used to expect every provider to be offered, which is G-3.
- The legacy provider cache-economics and Gemini thinking tests now run against `attemptCost` and `GoogleAdapter`.

## 7. Deviations from the plan

| Plan | As built | Why |
|---|---|---|
| Plan lookup failure → route as `free` | **Refused** | Stricter. Without a plan there is also no quota to reserve against. |
| A premium-only deployment serves free users (`only_model_configured`) | **Refused: no eligible model for this plan** (§11) | It was never an explicit product policy. |
| Separate `context.ts` and `structured.ts` | Folded into `gateway.ts` | Small; one lifecycle. |
| Adapters import `server-only` | Not added; enforced by a smoke gate instead | `server-only` throws under `tsx`, which the test suites and the worker use. The gate fails the build if any client file imports the gateway, the registry or the router. |
| `maxOutputTokens` clamped per purpose and plan | Clamped **per plan** by the gateway (§11); per purpose stays with the call sites, under that cap | A per-purpose table would duplicate what each call site already sets. |
| Stream events `tool_call`, `usage`, `error` | `text_delta`, `notice`, `done` (usage is on `done`; errors are thrown) | No streamed tool use has a caller yet. |
| `continuation` flag | New contract field | Needed so internal steps need headroom while chapters and repairs are not cut off at the limit (§4). |

## 8. Remaining risks

- **Adapter drift against live APIs.** The adapters are verified against recorded response shapes, not live calls in CI. Run `test:gateway:live` with keys before enabling a new model.
- **Per-instance caches.** The plan (30 s) and admin settings are cached per instance, so a plan upgrade or downgrade takes up to 30 s to affect routing.
- **Quota semantics change.** Task-path generations (chapters, reviews) now count against the plan (G-4). Users who relied on the bypass will hit their limit sooner. This is intended, but worth a release note.
- **Word estimates.** A reservation holds `estimatedWords` until it settles. Callers that over-estimate can briefly block a user near the word limit; the reservation is corrected at commit.
- **Premium-only deployments.** A deployment configured with only a premium model now refuses free users (§11). Before switching production to such a configuration, configure a standard or economy model, or accept that free users cannot use AI features.

## 9. Intentionally deferred

- **RLS** on the three new tables: P1-D, with the rest of the schema. The tables carry `user_id` and `project_id` for it.
- **Titles, evidence and extraction parsers** in ai.service still parse text, behind the gateway (limits, metering and timeouts already apply). Moving them to `generateStructured` is follow-up work.
- **Embeddings:** contract, adapters and tests exist, with no call sites until P1-G.
- **Full tool registry, policy engine (autonomy modes), agent loop and approvals:** P1-C and P1-D. P1-B provides the gateway side: validated, permission-checked, recorded tool calls, with `recordToolExecution` for the executor.
- Streamed tool-call events.
- An admin-editable output cap per plan (a `subscription_plans` column). Today the cap is keyed on the plan's tier (§11).
- **Live provider tests in CI:** deliberately never.

## 10. Rollback

- Migration 0012 is additive, and only the gateway reads the new tables.
- Reverting the code returns to the old provider path. The old providers are restored with the revert.
- The ledger format is unchanged, so no data migration is needed either way.

## 11. Final review decisions

### 11.1 Premium model when it is the only one configured: refused

**Finding.** This was **not** an explicit product policy.

- On `main` it existed only as a code comment in `candidatesFor` (`src/server/ai/model-requirements.ts`): "with one usable provider … everyone gets it: refusing to answer a free user is not a pricing strategy".
- The P1-B plan carried it forward as `only_model_configured`.
- No plan setting, admin option, pricing document or user-facing notice ever stated it.
- It was an implementation fallback, so it has been removed.

**Behaviour now.**

- **Where it is enforced:** `route()` in `src/server/ai/gateway/routing.ts`. When no configured model is inside the plan's entitlement, it throws `GatewayError('entitlement', 'No eligible model for this plan.', { detail: 'no_eligible_model' })`. It never falls back to a model the plan does not include. There is no other route to a model: the smoke gate fails the build on any path around the gateway.
- **Nothing is spent:** the refusal happens in `prepare`, before any quota is reserved and before any provider is contacted. No usage row is written and nothing counts against the plan.
- **It is observable:** it is logged as `ai.gateway.route.refused` with the tier, the error class and the reason.
- **How the user is informed:**
  - `toAppError` returns `PLAN_LIMIT` (the code the UI already treats as an upgrade prompt), with `details.reason = 'no_eligible_model'`;
  - English: "No AI model is available on your plan. Upgrade to Pro, or ask the administrator to configure a model your plan includes.";
  - Arabic: "لا يتوفر نموذج ذكاء اصطناعي ضمن خطتك. ارتقِ إلى Pro، أو اطلب من المسؤول إعداد نموذج مشمول في خطتك."
- **Paid and admin users** on the same deployment are served as before.
- **Unchanged:** a free user who explicitly requests the premium model is still refused with `FORBIDDEN` ("That model is not included in your plan.").

**Tests:**

- unit: routing refuses the free user, with the reason, and still serves a paid user;
- database: a free user on a premium-only deployment is refused; nothing is sent, reserved, metered or counted; the bilingual `PLAN_LIMIT` message is shown; a paid user is served;
- smoke: the legacy-routing scenario now expects the refusal;
- mutation: putting the fallback back fails 1 unit, 2 database and 1 smoke check.

### 11.2 Per-plan output-length cap: implemented in the gateway

- **Rule:** `OUTPUT_TOKEN_CAP` in `src/server/ai/gateway/policy.ts`. The cap is keyed on the plan's tier:

  | Tier | Cap (output tokens per call) |
  |---|---|
  | free | 8,192 |
  | paid | 32,768 |
  | admin | 64,000 |

- **Where it is enforced:** the gateway's `prepare`, on every call kind (generate, stream, structured, tool calls, structured repair), after the plan is resolved and before the context-window check and any provider call.
  - A larger request is lowered to the cap. It is not refused, because the output is only bounded, and callers already handle a `length` finish.
  - Call sites do not enforce it and cannot bypass it.
- **It is observable:**
  - logged as `ai.gateway.output.capped`;
  - recorded on the routing decision as `output: { cap, requested, capped }`, both in the `ai.gateway.route` log and on every `ai_usage_events.routing` row.
- **No existing feature is affected.** The free cap sits above every current call site's request. The largest is 8,000 (a generated section); long-form rounds ask for up to 3,500. A new smoke gate scans every call site's `maxTokens`, `maxOutputTokens` and `tokensPerRound` values and fails if any exceeds the free cap. It was checked against a mutant that raised one call site to 9,000.
- **Cost exposure:** per call, output is at most 8,192 tokens on free, 32,768 on paid and 64,000 on admin. Per month, spend is still bounded by the request and word limits, which are enforced by the reservation.

**Tests:**

- unit (section S): a free call over the cap is lowered before the provider sees it; 8,000 is untouched on free; paid has its higher cap and is capped too; streams follow the same rule;
- smoke: the call-site gate;
- mutation: removing the clamp fails 3 unit checks.

**Deferred:** an admin-editable cap per plan (a nullable `subscription_plans` column that overrides the tier default). It needs a schema change and an admin UI field, and the tier-keyed cap already bounds cost centrally.

### 11.3 Final regression (head after these changes)

typecheck ✅ · lint ✅ · audit ✅ 0 vulnerabilities · smoke ✅ · statistics ✅ 1,329 · gateway unit ✅ 87/87 · gateway database ✅ 37/37 · integration ✅ 801 · jobs ✅ 22 · Research Graph ✅ 170 · production build ✅ · browser tests `FF_GRAPH=false` ✅ 66 passed, 1 skipped · browser tests `FF_GRAPH=true` ✅ 66 passed, 1 skipped.

