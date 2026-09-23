# P1-B plan: Production Model Gateway

**Status:** audit complete, plan written; implementation follows this plan. **Base:** `main` at `641d720` (P0, P1.0, P1-A and P1-A.1 merged).
**Governing documents:** `docs/architecture/TARGET_ARCHITECTURE.md` (R2, R8, R9), `docs/phase1/PHASE1_PLAN.md` (P1-B row).

**Goal.** One provider-neutral, domain-neutral gateway becomes the **only** path from Academic AI to a model provider:

`Application → Model Gateway → Provider Adapter → Provider`

Every call through it is:

- authorised against the user's plan;
- reserved against the quota before it runs;
- bounded by timeouts and retries;
- metered durably;
- observable.

---

## 1. Current architecture (audit of `main`)

### 1.1 Layers

| Layer | File | What it does |
|---|---|---|
| Contract | `src/ai/types.ts`, `src/ai/provider.ts` | `AIRequest { task, locale, system, messages[{role,content:string}], maxTokens, temperature, json, cacheSystem, reasoning }` → `AIResult { text, usage, provider, model, stopReason }`. `AIProvider` interface: `complete`, `stream`, `countTokens`, `estimateCostMicroUsd`. Text only; no tools, no multimodal content, no cancellation. |
| Adapters | `src/ai/providers/{anthropic,openai,google}.ts` | Raw `fetch` to each vendor (no SDKs anywhere in the repository). **No timeout and no `AbortSignal`.** Errors become `AIProviderError(provider, rawBody, status)`, and the raw body goes into the message. **Google puts the API key in the URL query string** (`?key=…`). |
| Registry | `src/ai/registry.ts` | `resolveProvider(chosen?)`: the user's choice, then the admin setting (DB, 60 s cache), then `AI_PROVIDER`, then the first provider with a key. **It silently falls back to any configured provider.** |
| Router | `src/server/ai/model-router.ts`, `model-requirements.ts` | `selectModel(requirements)`: plan tier from `currentUserId()` (AsyncLocalStorage), `candidatesFor(tier)` (free → non-premium when possible), a preference order, then `guarded()` = `resilient(tuned(provider))`. Also `withFailover`, `alternativeProvider`. |
| Resilience | `src/server/ai/resilient-provider.ts` | On `shouldFailOver` (status 429/502/503/504 or a message regex): move to the alternative, or retry once after 1.2 s. For streams, only before the first chunk. |
| Scope | `src/server/ai/request-scope.ts` | `runForUser(userId, fn, preferredModel)`, set in `withApi` and in `executeTask`. |
| Metering | `src/server/services/usage.service.ts` | `recordAIUsage` writes `usage_tracking` rows (`AI_REQUEST` +1, `GENERATED_WORD`, tokens, `cost_micro_usd`). `assertCanUseAI(userId, estimatedWords)` compares the month's totals with `plan.maxAiRequests` and `maxGeneratedWords`. |
| Prices | `src/ai/prices.ts` | Dated USD prices per model family; `costFor`, `costMicroUsd`. Correct and reused. |
| Model access | `src/server/services/model-access.service.ts`, `src/agents/modes.ts` | `tierFor(userId)`: free, paid or admin; `modelsFor(tier)`; `resolveRequestedModel(userId, modelId)` checks the user's selection against the plan. |

**Providers and models in use:** Anthropic (`ANTHROPIC_MODEL`, default `claude-sonnet-5`; `PREMIUM`), OpenAI (`OPENAI_MODEL`, default `gpt-4.1`), Google (`GOOGLE_MODEL`, default `gemini-2.5-pro`, with `GOOGLE_FALLBACK_MODEL` `gemini-3.5-flash` as a sibling for overload). There are no embeddings, tool calling or multimodal calls anywhere today.

### 1.2 Every place the application reaches a model

**Direct vendor HTTP:** only `src/ai/providers/*` (confirmed by grep: no other file names a provider host or imports an SDK).

**Provider method calls outside the provider layer:**

- **6 direct `.complete` / `.stream` calls:** `ai.service` ×3, `tool.service`, `intent`, `long-form`.
- **16 `runCompletion` calls** that funnel into one of those: `ai.service` ×13, `planner` ×2, `diagrams/extract` ×1.
- In total, **22 model-calling code paths** across 7 files.

| # | Call site | Kind | Purpose | Quota check | Metered |
|---|---|---|---|---|---|
| 1 | `ai.service.runCompletion` (used by 12 functions: `generateTitles`, `improveTitle`, `compareTitles`, `generateSection`, `answerGeneralQuestion`, `extractModelStructure`, `answerFromSources`, `planResearch`, `extractEvidence`, `identifyGaps`, `synthesiseReport`, `generateSurveyItems`, `summariseSources`) | complete | wizard, titles, deep research, extraction | ✅ `assertCanUseAI` in each caller | ✅ `recordAIUsage` |
| 2 | `ai.service.streamGeneralAnswer` | stream | chat answer (`/api/chat`) | ✅ | ⚠️ only `if (content)`; a failure before the first chunk is unmetered; the provider name is wrong after a failover |
| 3 | `ai.service.streamChat` | stream | legacy section chat (`/api/ai/chat`) | ✅ (via `prepare`) | ⚠️ cost priced at the requested model, not the one that served |
| 4 | `tool.service.runTool` | complete | writing tools | ✅ | ⚠️ cost priced at the requested model |
| 5 | `agents/intent.classifyIntent` | complete, `json: true` | classifies **every** chat message | ❌ | ❌ **not metered** |
| 6 | `server/ai/long-form.generateLongForm` (called by `handlers.ts` for `literature.review` and `document.write`) | complete, multi-round | the most expensive calls in the product | ❌ | ❌ **not metered** |
| 7 | `tasks/planner.ts` (2 calls through `runCompletion`) | complete, JSON | task planning | ❌ (inside tasks) | ✅ |
| 8 | `diagrams/extract.ts` (through `runCompletion`) | complete, JSON | diagram structure | ✅ | ✅ |
| 9 | `research/pipeline.ts` through ai.service (`planResearch`, `extractEvidence`, `identifyGaps`, `synthesiseReport`) | complete | deep research **background job** | ✅ per call | ✅ |
| 10 | `agents/orchestrator.ts` (legacy `/api/agent`) | uses the ai.service functions | legacy agent | as above | as above |

**Model-selection paths:**

- `selectModel`, the preferred path (routed);
- `resolveProvider()` with no requirements, used by `prepare()` and the health report;
- `withFailover`;
- `runWithFailover`.

**Fallback paths (four, stacked):**

1. `resolveProvider` falls back to any configured provider.
2. `resilient()` inside `selectModel`: an alternative, or a retry once.
3. `runCompletion.runWithFailover`, on top of (2).
4. `withFailover`.

**Background-job AI calls:**

- **Tasks:** `executeTask`, which runs inside `runForUser` with the chosen model.
- **Deep research:** `runResearchJob`, which does **not** use `runForUser`.
- **PLS bootstrap:** no AI calls.

**Structured output and JSON parsing:**

- `json: true` plus a hand-rolled parse in `intent.ts` (`parseJsonOutput`), `planner.ts` (`JSON.parse(candidate.slice(start, end+1))`), `diagrams/extract.ts`, `ai.service` titles and extraction (7 sites), and `survey/generator.ts`.
- Anthropic has no JSON mode, so it relies on the prompt alone.

**Tool calling:** none.

- The "tool registry" that exists is the **capability registry** (`src/server/tasks/capabilities.ts`: 16 typed capabilities, each with a timeout, an estimated number of model calls and a retry policy).
- The planner asks the model for JSON naming capabilities.

**Context:**

- `src/server/context/envelope.ts` builds per-purpose envelopes with authority levels.
- `sources.ts` sends a dataset's **column list and row count, never its rows**. That rule is kept.

### 1.3 Problems found (each is fixed or explicitly deferred below)

| ID | Problem | Severity |
|---|---|---|
| G-1 | **No timeout, no cancellation** on any provider call. A hung provider holds a request (or a worker lease) indefinitely; a disconnected chat client keeps the stream running. | High |
| G-2 | **Premium bypass on failover.** `runWithFailover` calls `alternativeProvider(name)` without the plan's `allowed` list, so a free user's failed call can be retried on the premium model. | High |
| G-3 | **Premium on lost plan.** `currentTier()` returns `undefined` when no user is in scope or the plan lookup fails. `candidatesFor(undefined)` then offers every provider, and the `needsReasoning` preference puts Anthropic (premium) first. The deep-research job runs **without** `runForUser`, so every deep-research model call is routed as tier unknown. | High |
| G-4 | **Quota bypass through tasks.** The intent classifier, the planner and the task handlers (including long-form chapters and literature reviews) never call `assertCanUseAI`. A free account that has used its quota can still produce chapters through the task path. | High |
| G-5 | **Unmetered calls.** Intent classification and long-form generation record no usage at all. Streams that fail before the first chunk record nothing. | High |
| G-6 | **Check-then-act quota race.** `assertCanUseAI` reads totals and the call runs later, so concurrent requests all pass the same check. There is no reservation. | Medium |
| G-7 | **Stacked retries.** A `resilient` provider inside `runWithFailover` means one logical call can reach up to 5 provider attempts, with no cap and no backoff policy. | Medium |
| G-8 | **Error classification by regex** over raw provider bodies. Auth, invalid request, context length and refusal are not distinguished. Raw provider bodies (up to 400 characters) are placed in `AppError.details`, which reaches the client. | Medium |
| G-9 | **Google API key in the URL.** Any logged URL or error containing it leaks the key. | Medium |
| G-10 | **Fragile JSON parsing** for intent and plans (substring between the first `{` and the last `}`). | Medium |
| G-11 | **Cost computed at the requested model**, not the serving one (tool service, legacy chat). | Low |
| G-12 | **Silent provider substitution** in `resolveProvider` (the user's chosen provider missing → default, with only a log line). | Low |
| G-13 | **No durable per-call record**: `usage_tracking` has no status, latency, retry count, run or task id, or error class. Failed calls leave no trace. | Medium |

---

## 2. Target architecture

```
src/server/ai/gateway/              (server-only; nothing here is importable from client code)
  contract.ts     zod schemas: GatewayRequest, ContentPart, GatewayTool, GatewayResponse, StreamEvent, Usage
  context.ts      CallContext (userId, projectId?, taskId?, jobId?, runId?, purpose); resolved from the request scope; fail-closed
  errors.ts       GatewayError { class, retryable, provider?, status? }, classify(), safe public messages
  policy.ts       timeouts per request kind, retry and backoff (deterministic, injectable clock/jitter), attempt budget
  routing.ts      Entitlement (tier → allowed model classes), candidates, RoutingDecision (observable, persisted on the usage row)
  quota.ts        reserve → commit / release (idempotent, concurrency-safe), on the existing plan limits
  metering.ts     durable ai_usage_events rows per attempt; commit to usage_tracking (the existing quota ledger)
  tools.ts        tool specs (zod → JSON Schema), permission check, argument validation, ai_tool_calls records
  structured.ts   generateStructured: native structured output, validation, one bounded repair
  gateway.ts      generate(), stream(), generateStructured(), toolCall(), embed()
  compat.ts       legacy AIProvider facade over the gateway (strangler)
  adapters/
    types.ts      ProviderAdapter { name, capabilities(model), send(req, signal), stream(req, signal), embed?() }
    anthropic.ts  Messages API: tools / tool_use, structured output via a forced tool, cache_control, image parts
    openai.ts     Chat Completions: tools / tool_calls, json_schema strict, image_url parts, embeddings
    google.ts     generateContent: functionDeclarations / functionCall, responseSchema, inline_data, embedContent; key in a header
    fake.ts       deterministic scripted adapter for tests (never registered in production)
```

### 2.1 Normalised contract

- **Request:**
  - `kind`: generate, stream, structured, tools or embed;
  - `purpose`: the existing `AITask` or capability id;
  - `system`, and `messages[]` with `content: string | ContentPart[]`, where `ContentPart` is `{type:'text'}`, `{type:'image', mediaType, data(base64)}`, `{type:'tool_call'}` or `{type:'tool_result'}`;
  - `maxOutputTokens`, `temperature`, `reasoning`, `cacheSystem`;
  - `tools?`, `toolChoice?`, `responseSchema?`;
  - `requested?: {provider, model}` (the user's choice, already checked);
  - `timeoutMs?` (clamped to the policy's maximum), `signal?: AbortSignal`, `metadata` (ids only).
- **Response:**
  - `text`, `toolCalls[]` (`{id, name, arguments (validated), rawArguments?}`), `structured?`;
  - `finishReason`: stop, length, tool_calls, content_filter or error;
  - `usage { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, estimated }`;
  - `provider`, `model`, `latencyMs`, `attempts`, `routing` (the decision), `usageEventIds`.
- **Stream events:** `text_delta`, `tool_call`, `notice` (retry or failover, for the existing "one moment" UI), `usage`, `done`, `error`.
- **Every input is parsed by zod at the gateway boundary**, and every adapter output is validated against the normalised schema before it leaves the adapter.

### 2.2 Call context and entitlement (G-3)

- The gateway **requires a user**. `CallContext` comes from the request scope, which is extended to carry `projectId`, `taskId`, `jobId` and `runId`. **No user in scope → `GatewayError('internal', 'no_call_context')`; the call is refused, never routed as anonymous.**
- **Entitlement is resolved inside the gateway from the user id on every call** (cache 30 s). It is never taken from job payloads or request bodies. A worker cannot "lose" a plan, because it never carried one: it carries the user id, and the gateway looks the plan up.
- **Plan lookup failure → treated as `free` (fail closed).** It is never unknown or permissive.
- `projectId`, when given, is checked with the existing `requireProjectRole(projectId, userId, 'VIEWER')` (the P1-A.1 gate). No second authorisation system is added.

### 2.3 Routing (G-2, G-12)

- **Model classes:** `premium`, `standard` and `economy`. A class comes from a provider/model table in one file (defaults: Anthropic `premium`; OpenAI `standard`; Google Pro `standard`; Google Flash `economy`).
- **Entitlement per tier:**
  - `free` → `standard` and `economy`;
  - `paid` and `admin` → all classes.
- **Superseded in the final review (`P1B_REPORT.md` §11.1): a free user on a premium-only deployment is now refused with "no eligible model for this plan".** Original plan text: *The existing single-provider rule is kept and made explicit:* when the only configured model is premium, a free user is served by it, with routing reason `only_model_configured`. This is a deployment fact rather than a fallback, and it is observable and tested. It never happens when a non-premium model is configured.
- **Candidate order:**
  - the user's explicit choice (validated against the entitlement again inside the gateway: defence in depth over `resolveRequestedModel`);
  - otherwise the existing preference order (context size, reasoning, latency) within the entitlement.
- **Failover:**
  - **never to a class above the entitlement**, and never to a class above the one first routed to;
  - **no cross-provider failover when the user explicitly chose a model**: same-model retries only, and a notice is shown;
  - the Google sibling model (same provider, economy class) is allowed.
- **Every decision** (`{tier, requested, candidates, chosen, reason, failoverChain}`) is logged as `ai.gateway.route` and stored on the usage row.
- **`resolveProvider`'s silent substitution is removed from the call path.** The registry keeps only the admin model override lookup and the health report.

### 2.4 Timeouts, retries, failover (G-1, G-7, G-8)

- **Timeouts per kind:**

  | Kind | Timeout |
  |---|---|
  | Generate | 120 s |
  | Structured | 60 s |
  | Stream | 30 s to the first event, 30 s idle between events, 180 s in total |
  | Long-form round | 240 s |
  | Embed | 30 s |

  Callers may lower a timeout, never raise it. Each timeout is implemented with `AbortSignal.any([callerSignal, AbortSignal.timeout(t)])` passed to `fetch`.
- **Error classes:**

  | Class | Retryable |
  |---|---|
  | `auth` | no |
  | `rate_limit` | yes, honouring `retry-after` up to 10 s |
  | `timeout` | yes |
  | `network` | yes |
  | `outage` (5xx or overloaded) | yes |
  | `invalid_request` | no |
  | `context_length` | no |
  | `refusal` (content or policy) | no |
  | `tool_validation` | no |
  | `schema_validation` | no (except the one repair in §2.7) |
  | `cancelled` | no |
  | `quota` | no |
  | `entitlement` | no |
  | `not_configured` | no |
  | `internal` | no |

  Classification is by status code **and** provider error type fields, not message regex.
- **Attempt budget:** at most **3 provider attempts per logical call**.
  - Order: primary; then an eligible alternative (if any); then the primary once more.
  - Backoff: 500 ms and then 1,500 ms, with ±20 % jitter from an injectable random source, so tests are deterministic.
  - Non-retryable errors are never retried.
  - Streams are retried only before the first event.
  - All the existing stacked layers (`resilient`, `runWithFailover`, `withFailover`) are removed; the gateway is the only retry layer.
- **Public errors:** the client sees a stable code (`AI_UNAVAILABLE`, `PLAN_LIMIT`, `AI_QUOTA`) and a bilingual message. **Raw provider bodies are never placed in `AppError.details`**; they go only to the server log, truncated, after key redaction.

### 2.5 Metering (G-5, G-11, G-13)

New additive table **`ai_usage_events`**, one row per provider attempt:

| Field | Content |
|---|---|
| Identity | `id`, `call_id` (groups the attempts of one logical call), `attempt` |
| Scope | `user_id`, `project_id`, `task_id`, `job_id`, `run_id` |
| Request | `purpose`, `kind`, `provider`, `model`, `model_class` |
| Outcome | `status` (`succeeded`, `failed` or `cancelled`), `error_class`, `finish_reason` |
| Usage | `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, `usage_estimated` |
| Cost | `cost_micro_usd`, `currency` (`USD`) |
| Timing | `latency_ms`, `retry_count` |
| Routing | `routing jsonb` |
| Quota | `reservation_id` |
| Time | `created_at` |

- The row is written **in `finally`**: after success, after failure, after cancellation. When the provider reported usage before failing (or a stream was cut), the usage is recorded. When it did not, the input is estimated and `usage_estimated = true` is set.
- **Cost is computed at the model that served**, with `prices.ts`.
- **The quota ledger stays `usage_tracking`** (no second quota system). When a logical call commits, the gateway writes `AI_REQUEST` (+1, only for calls that count as a request, §2.6) and `GENERATED_WORD` (words in the output), with the tokens and cost summed over the attempts. **Call sites stop calling `recordAIUsage` themselves**, so nothing can be counted twice or forgotten.

### 2.6 Quota reservation (G-4, G-6)

New additive table **`ai_quota_reservations`**:

- `id`, `user_id`, `period_key`, `idempotency_key` (unique per user), `requests`, `words`;
- `status` (`reserved`, `committed` or `released`), `expires_at`, `created_at`, `settled_at`.

The flow, inside the gateway, for every call:

1. **Resolve** the user, then the project (access check), the plan and the entitlement.
2. **Reserve**, in one transaction under `pg_advisory_xact_lock(hashtext('ai-quota:' || user_id))`:
   - compute used = committed usage this period + open, unexpired reservations;
   - if used + this request exceeds `maxAiRequests` or `maxGeneratedWords`, refuse with `PLAN_LIMIT`;
   - otherwise insert the reservation.
   - The **idempotency key** is `callId`, or one supplied by the caller (a task step and attempt, for example), so a retried job step does not reserve twice.
3. **Execute** within the attempt budget.
4. **Commit** the actual usage (§2.5) and mark the reservation `committed`, or **release** it when no provider usage happened. Expired reservations (15 min, a crashed worker) stop counting and are swept by the existing reaper.

**What counts as a request.** A user-visible generation (a chat answer, a section, titles, a tool, a chapter or review, a deep-research synthesis) reserves 1 request plus its estimated words.

Internal steps are different: intent classification, task planning, and long-form continuation rounds. They reserve **0 requests** and share the parent's word budget, but they still require the plan to have remaining quota and are fully metered in `ai_usage_events`.

This keeps a user's visible quota meaning what it means today: one message is one request, not three. It also closes G-4: task-path generation is now counted and blocked at the limit. The rule is one table in `quota.ts`, and it is tested.

`assertCanUseAI` stays where it is, as an early fast-fail for a better message. The gateway reservation is authoritative, and no endpoint can bypass it, because every endpoint's model call passes through it.

### 2.7 Structured output and tool calling (G-10)

- **`generateStructured({schema: zod, …})`:**
  - native structured output where supported: OpenAI `response_format: json_schema` (strict); Gemini `responseSchema`; Anthropic a forced single tool whose input schema is the target.
  - The result is **validated with zod**. On failure there is **one bounded repair attempt**: the validation errors are sent back once, metered as its own attempt. Otherwise `GatewayError('schema_validation')`.
  - **Prose is never parsed as data.**
- **`toolCall({tools, permittedTools, …})`:**
  - Tools are declared once as `GatewayTool { name, description, schema (zod) }`, converted to JSON Schema per provider.
  - **P1-B does not create a tool registry.** Tool specs are built from the existing capability registry (`capabilities.ts`) by a small projection (`capabilityTool(id, argsSchema)`), and the full registry and policy engine remain P1-C.
  - **Permissions:** the gateway receives the tools and the permission set of the run. A tool call whose name is not both declared and permitted is **rejected** (`tool_validation`, recorded), never executed. Arguments are validated with zod; invalid ones are rejected safely and recorded with the validation error. They are never repaired silently.
  - **Durable record:** new additive table **`ai_tool_calls`**:

    | Field | Content |
    |---|---|
    | Identity | `id`, `call_id`, `tool_call_id` (provider id) |
    | Tool | `tool_name`, `arguments jsonb` (validated) or `raw_arguments` (rejected) |
    | Outcome | `status` (`validated`, `rejected`, `succeeded` or `failed`), `error`, `result_summary jsonb`, `latency_ms` |
    | Provenance | `provider`, `model`, `user_id`, `project_id`, `run_id`, `task_id`, `created_at` |

    Execution itself belongs to the run engine (P1-D). The gateway provides `recordToolExecution()` so an executor fills in the result, success, failure and latency.
  - **The LLM cannot touch research results:** no gateway tool maps to a Research Graph write of results. Computed results remain writable only by `recordRun` with an engine actor (P1-A.1), and the gateway never constructs an engine actor.
- **Migration of fragile parsers:**
  - intent classification → `generateStructured` (intent schema);
  - task planning → `generateStructured` (plan schema: capability ids constrained to the registry's enum);
  - diagram extraction → `generateStructured`.
  - Titles, evidence and extraction in ai.service keep their tolerant parsers **behind** the gateway in P1-B (they are behaviour-sensitive and well tested). Moving them to `generateStructured` is listed as follow-up work.

### 2.8 Streaming (G-1)

- `gateway.stream()` yields normalised events.
- **Cancellation:** the caller's `AbortSignal` (the route's `request.signal`) aborts the provider fetch.
- A disconnected client aborts the stream; the usage row is written with `status = cancelled` and the usage so far.
- Idle and total timeouts end a stalled stream.
- `/api/chat` and `/api/ai/chat` pass `request.signal`.
- The existing retry and failover notices keep working through the `notice` event (the `notices.ts` scope is kept).

### 2.9 Security

- **API keys:**
  - read only in `adapters/*`, which import `server-only`;
  - never in a URL (Google moves to the `x-goog-api-key` header);
  - never in a log line, error message, usage row or tool output;
  - redaction of any 20+ character key-shaped substring in provider error bodies before logging;
  - a smoke test asserts that no client bundle imports the gateway and that no `NEXT_PUBLIC_` variable holds a key.
- **Excessive tokens:**
  - `maxOutputTokens` is clamped per purpose and plan;
  - input is estimated before the call, and a request over the model's context window fails fast as `context_length` without calling the provider.
- **Context leakage:**
  - the gateway does not build context; call sites keep using the context envelope (authority levels, datasets as schema only);
  - the gateway checks project access for `projectId`, and usage rows are scoped to user and project.
- **Model-generated URLs and tool arguments** are validated data. Nothing the model returns is fetched except through the existing `guardedFetch` (P1.0).
- **Prompt injection:** tool permission sets and schema validation limit what an injected instruction can do; the gateway never widens permissions from model output.

### 2.10 Observability

Structured `logger` events with ids and metadata only, never prompts, outputs, dataset contents or keys:

| Event | Fields (besides `callId`) |
|---|---|
| `ai.gateway.request` | `purpose`, `kind`, `userId`, `projectId`, `taskId` |
| `ai.gateway.route` | the decision |
| `ai.gateway.attempt` | `provider`, `model`, `attempt`, `status`, `errorClass`, `latencyMs`, tokens |
| `ai.gateway.retry`, `ai.gateway.failover` | — |
| `ai.gateway.tool` | `name`, `status` |
| `ai.gateway.result` | — |

The durable counterpart is `ai_usage_events` and `ai_tool_calls`.

---

## 3. Migration sequence (strangler; each step keeps every suite green)

| Step | Change | Call sites moved |
|---|---|---|
| B1 | Gateway core: contract, errors, policy, routing, adapters (text, tools, structured, stream, embed), fake adapter. Unit tests with mocked `fetch`. No call site changes. | — |
| B2 | Migration `0012_p1b_model_gateway` (3 additive tables); metering and quota reservation; integration tests. | — |
| B3 | Request scope carries `projectId`, `taskId` and `jobId`; `runResearchJob` runs inside `runForUser(job.userId)` (G-3). | — |
| B4 | **Compatibility facade:** `selectModel` returns a gateway-backed `AIProvider`, so every `.complete` and `.stream` goes through the gateway (timeouts, retries, routing, reservation, metering). Remove `recordAIUsage` from call sites; remove `resilient`, `runWithFailover` and `withFailover`. | all 22 paths (6 direct calls) |
| B5 | Native paths: intent → `generateStructured`; planner → `generateStructured`; diagram extraction → `generateStructured`; streams pass `request.signal`. | 4 |
| B6 | Delete `src/ai/providers/*` (replaced by the adapters); `registry.ts` keeps only the admin override lookup and health. Add a **CI gate** (smoke) failing on any vendor host, SDK import or `.complete(` / `.stream(` call outside `src/server/ai/gateway/`. | — |

**Compatibility:**

- the `AIProvider` interface and `selectModel` signature are unchanged for callers during B4;
- chat streaming, notices, the model selector, the plan-aware model list and the health report behave as before;
- `usage_tracking` keeps its meaning, so the admin dashboard and the plan limits are unchanged;
- quota counting changes only where calls were previously uncounted (G-4 and G-5), as described in §2.6.

**Rollback:** each step is its own commit. Migration 0012 is additive (nothing reads the new tables except the gateway), and a revert of the code returns to the old path.

---

## 4. Test strategy

**Unit tests (`scripts/gateway.ts`, new, in the CI checks job; deterministic):**

- `fetch` is mocked per adapter with recorded response shapes; the clock and jitter are injected.
- Areas covered: gateway contract (A); every adapter's normalisation of text, tool calls, structured output, usage, finish reasons, errors and image parts (B); tool calling with an unknown or unpermitted tool and invalid arguments (C, Q); structured output with a valid result, a repaired one, and a failure (D); streaming events, idle and total timeout, cancellation mid-stream (E, F, O); retry policy, backoff, attempt cap, and non-retryable classes never retried (G); failover never above the entitlement, and no cross-provider failover on an explicit user choice (H, M); cost calculation (J); error classification table (P); outage (R); context length pre-check and provider 400 (S).
- **Mutation checks:** removing the entitlement filter from failover, or the non-retryable guard, makes named tests fail.

**Integration tests (`scripts/gateway-integration.ts`, new, in the CI database job; PostgreSQL, fake adapter):**

- durable usage rows on success, failure and cancellation, with retries recorded (I);
- the quota reservation: 20 concurrent calls against a plan with 5 remaining requests produce exactly 5 successes (K, N);
- idempotent re-reservation;
- expiry;
- plan propagation: a task and a deep-research job run in a worker route a free user to non-premium, and a missing scope is refused (L, M);
- the premium bypass through each alternate entry point (chat, tools, tasks, jobs) is closed;
- cross-project: a `projectId` the user cannot see is refused, and usage rows carry the right project (T);
- no double count for one logical call.

**Existing suites** must stay green, unchanged: smoke, analysis (1,328), integration (807), jobs (22), graph (170), e2e (66 + 1 skipped), build. Browser tests keep using the existing stubbed provider mode.

**Live provider tests** (`scripts/gateway-live.ts`) run only with `GATEWAY_LIVE=1` and real keys. They are **never in CI**.

---

## 5. Risks and deferred items

| Item | Handling |
|---|---|
| Quota semantics change (G-4 fix counts task-path generations; internal steps are metered but not counted as requests) | Documented in §2.6 and the report; one table, tested. |
| Single premium model serving free users when it is the only model configured | Kept (current product rule), made explicit and observable. If you want free users refused instead, it is a one-line policy change. |
| Adapter drift against live APIs (shapes verified against recorded fixtures, not live calls in CI) | `gateway-live.ts` for manual verification with keys. |
| Titles, evidence and extraction parsers not moved to `generateStructured` | Follow-up; they already run through the gateway (limits, metering, timeouts). |
| Tool registry and policy engine (autonomy modes R2), agent loop, approvals | P1-C / P1-D. P1-B provides the gateway side: validated, permission-checked, recorded tool calls. |
| RLS on the new tables | P1-D, with the rest (the tables carry `user_id` / `project_id` for it). |
| Embeddings | Contract and adapters (OpenAI, Google) with tests; no call sites until P1-G. |
| Per-instance caches (tier, admin settings) | Unchanged (30 s / 60 s). |

**Out of scope:** billing UI, P1-C, enabling `FF_GRAPH`.
