# P1-D: RLS verification on a Neon branch

**Date:** 2026-09-23 · **Neon project:** `academic-ai-eu` · **Branch:** `p1d-rls-verify` (`br-muddy-breeze-b2yfw4tj`), created from the default branch (`import`). The verification wrote only to this branch; production was neither read nor changed. · **Server:** PostgreSQL 18.6 · **Connected as:** `neondb_owner`

**Status (2026-09-24): P1-D verification is CLOSED for security and deployment, with one explicit gate on `FF_RUNS`.**

| Item | Status |
|---|---|
| Neon RLS: role, 11 policies, project isolation, no rows without a user, rejected cross-project, impersonating and viewer writes (§3) | ✅ Verified |
| Fail-closed behaviour on Neon: RLS disabled, role bypassing, role missing, role not granted → runs refused (§3, 7a–7d) | ✅ Verified |
| Production migrations 0014/0015 applied (deploy of `5f18aaa`) | ✅ Verified (§5) |
| Production read-only RLS probe (`assertRlsEnforced`) | ✅ Passed (§5) |
| Production connection | ✅ Role `neondb_owner` verified (§5); **pooled** Neon host, confirmed by the project owner in the Render dashboard |
| `FF_RUNS` / `FF_GRAPH` in production | ✅ **OFF**: both absent from the Render environment (confirmed by the project owner), so both default to `false` |
| App-level `test:runs:db` on Neon | ⏳ **Gate before `FF_RUNS` is enabled** (§6); not executed |

The remaining gate is functional, not a security gap. The fail-closed probe runs in the same transaction as the run work, so a pooler that mishandled the role switch would make runs refuse (`rls_unavailable`) rather than expose data. The acting user is transaction-local and cannot carry over to another client on a pooled connection.

## 1. How it was run

The sandbox cannot reach Neon over TCP 5432 or through its HTTPS SQL endpoint (both blocked by the network policy). Every statement therefore ran server-side through the Neon connector:

- `run_sql` for single statements;
- `run_sql_transaction` for the rest. Each call is one transaction, so `SET LOCAL ROLE` and `set_config(…, true)` behave exactly as they do inside `withRunScope`.

The steps:

1. **Migrations.** Migration `0014_p1d_runs.sql` was applied as one transaction. Migration `0015_p1d_rls.sql` was applied the same way, except the role creation and grant, which ran one at a time so their effect could be observed.
2. **Fixtures.** Synthetic data was inserted with the prefix `p1dv-`:
   - users Alice and Bob, each the owner of a project (A and B);
   - a viewer of project A;
   - a stranger;
   - one run and one event in each project.
3. **Probe.** The probe queries are copied from `src/server/runs/db-scope.ts` (`assertRlsEnforced`).

## 2. Findings about Neon's roles

| Fact | Value | What it means |
|---|---|---|
| Migrating role `neondb_owner` | not a superuser, has `CREATEROLE`, **has `BYPASSRLS`** | The owner connection bypasses RLS. This is expected and documented: RLS holds only because the run paths switch to `academic_app`. |
| `CREATE ROLE academic_app NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT` | ✅ succeeded | The role can be created on Neon; migration 0015 does not fall into its warning branch. |
| `GRANT academic_app TO neondb_owner` | ✅ succeeded. Membership is ADMIN (automatic for the creator in PostgreSQL 16+), plus SET and INHERIT from the explicit grant. | `SET LOCAL ROLE academic_app` is allowed. |
| `academic_app` attributes | `rolsuper = false`, `rolbypassrls = false`, `rolcanlogin = false` | The role cannot bypass the policies or log in by itself. |

## 3. Checks

| # | Check | Result on Neon |
|---|---|---|
| 1 | The fail-closed probe under `SET LOCAL ROLE academic_app` | `role = academic_app`, `bypass = false`, `superuser = false`, `rls = true` (all four tables), `row_security = on`. The probe **passes**, so runs would be allowed to start. |
| 2 | No user context (`app.user_id` unset) | 0 runs and 0 events visible |
| 2b | Empty user context (`app.user_id = ''`) | 0 runs visible |
| 3 | Project isolation | Alice sees only run A; Bob only run B; the viewer of A only run A; the stranger nothing. Events are isolated the same way. |
| 4 | Positive control: Alice creates a run and an event in her own project | ✅ inserted |
| 5a | Cross-project insert: Alice creates a run in Bob's project | ❌ rejected: `new row violates row-level security policy for table "research_runs"` |
| 5b | Impersonation: Alice creates a run in her project in Bob's name | ❌ rejected (same policy error) |
| 5c | Cross-project event: Alice writes an event on Bob's run | ❌ rejected: `… policy for table "run_events"` |
| 5d | A viewer creates a run | ❌ rejected (rank below EDITOR) |
| 6a | Updates by the stranger, by the viewer of A, and by Bob on project A | 0 rows changed each time. Verified afterwards with the owner connection: nothing was changed. |
| 6b | DELETE as `academic_app` | ❌ `permission denied for table research_runs` (no grant, and no policy) |
| 7a | Fail closed: RLS disabled on one run table | Probe returns `rls = false`, so `assertRlsEnforced` refuses (`rls_unavailable`). Re-enabled afterwards. |
| 7b | Fail closed: the role given `BYPASSRLS` | Probe returns `bypass = true`, so it refuses. This scenario also showed what the probe prevents: with bypass, 3 rows were visible with no user set. Reverted to `NOBYPASSRLS`. |
| 7c | Fail closed: the role missing | `SET LOCAL ROLE` fails with `role … does not exist`. The probe's transaction throws, so it refuses. |
| 7d | Fail closed: the role not granted to the connecting role | `SET LOCAL ROLE` fails with `permission denied to set role "academic_app"`, so it refuses. (The revoke rolled back with the failed transaction.) |
| 8 | Final state of the branch | `academic_app` has no bypass; RLS is on for all 4 tables; the owner can take the role; 11 policies are in place. |

The mapping from each failing probe to `503 UNAVAILABLE` (`reason: rls_unavailable`), with no fallback, is the application code in `db-scope.ts`. It is covered by `test:runs:db` ("if the role could bypass RLS, runs refuse to start (no application-only fallback)"). That code was not changed.

## 4. Application-level verification: not executed (still blocking)

The follow-up asked for the application's own run path (`npm run test:runs:db`: `postgres-js` over TCP, `withRunScope`, `assertRlsEnforced`) to be run against this branch. **It could not be executed from this environment, and it is not claimed as passed.**

- **Network.** The session's network policy denies the branch's endpoints, both direct and pooled:
  - `ep-bitter-mouse-b2465kju.c-6.eu-central-1.aws.neon.tech`
  - `ep-bitter-mouse-b2465kju-pooler.c-6.eu-central-1.aws.neon.tech`

  TCP 5432 fails to connect, and HTTPS is refused by the egress proxy (403). No database driver the application uses can reach Neon from here.
- **The application's connection role.** This was confirmed on the branch:
  - `neondb_owner` is the only login role;
  - it owns the application tables (`users`, `research_runs`);
  - it can `SET ROLE academic_app`.

  The fail-closed probe in §3 (checks 1 and 7a–7d) therefore ran through the role the application connects as.

  *Correction (2026-09-24).* This section originally said the probe was not run through the pooled host. During the production audit (§5), the connector's own session appeared in `pg_stat_activity` as `pgbouncer`, which indicates that the connector's SQL, including the `SET LOCAL ROLE` + `set_config(…, true)` transactions in §3, went through Neon's pooler on PostgreSQL 18. This is inferred from the connector's behaviour; it is not a test of the application's own driver (`postgres-js`) through the pooler, which remains the gate in §6.
- **Clean-up.** The branch `p1d-rls-verify` was **deleted** after the verification, as instructed, and Neon listed it as gone. It held a copy of the default branch's data plus synthetic `p1dv-` rows. The project's `import` and `production` branches were not touched.

## 5. Post-merge audit of production (read-only), 2026-09-23 17:33 UTC

This audit ran after #33 was merged (`5f18aaa`) and deployed on Render. Everything ran through the Neon connector as read-only catalog queries and `SELECT`s. No production row, role or setting was changed. No secret, connection string or environment value was read or printed.

**Which database production uses.** It is the default branch `import` (`br-lucky-meadow-b2h0jdhv`) of Neon project `academic-ai-eu`:

- it is the only database with all 16 migrations (0000–0015), the run tables and the `academic_app` role;
- the `production` branch of the same project has no migration table;
- the `academic-ai` project (us-east-1) stops at 9 migrations.

The Render service `academic-ai-app` (auto-deploys `main`; its build runs `npm run db:migrate`) logged `migrations applied successfully` for `5f18aaa` at 17:22 UTC.

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | Neon **direct** `test:runs:db` | **Not executed** | This session's network policy denies `*.neon.tech` (TCP 5432 and HTTPS through the proxy). |
| 2 | Neon **pooled** `test:runs:db` | **Not executed** | Same reason. |
| 3 | Production `DATABASE_URL` role and host | **Verified** | Role from `pg_stat_activity` (below); the host is **pooled**, as confirmed by the project owner in the Render dashboard on 2026-09-24. This corrects the direct-host inference below. The value of `DATABASE_URL` was never read by this verification. |
| 4 | Production read-only RLS probe | **Passed** | See the probe results below. |

**Check 3: the role (verified).** In `pg_stat_activity` on the production branch, every application connection uses `neondb_owner`:

- 5 connections are `postgres.js`, the application;
- 3 are `academic-ai-jobs`, the pg-boss worker (`src/server/jobs/queue.ts`).

`neondb_owner` is the only login role. It owns the run tables, has BYPASSRLS (expected: the owner path is not the RLS path), and can `SET ROLE academic_app`, which is what migration 0015 needs.

**Check 3: the host (inferred, not verified).** The application's connections report their own `application_name`. The connector's own session, which goes through Neon's pooler, shows up as `pgbouncer`. This suggests the application uses the **direct** (non-pooler) host. The URL itself was not read, so this is an inference. *Superseded (2026-09-24): the project owner checked the Render dashboard and confirmed that production uses the **pooled** host. The inference above was wrong; the application name alone does not identify the host.*

**Check 4: the probe (passed).** It ran on the production branch in one transaction with `SET LOCAL ROLE academic_app`, using the same probe query as `assertRlsEnforced`:

| Item | Result |
|---|---|
| Probe | `role = academic_app`, `bypass = false`, `superuser = false`, `rls = true` (all 4 tables), `row_security = on` |
| Policies | 11 in place; RLS is on for all four tables |
| No user context | 0 runs and 0 events visible |
| Grants | `academic_app` has no DELETE or TRUNCATE on `research_runs` and cannot read `users` |
| Production data | 0 runs, steps, approvals and events. No run has ever been created there, which is consistent with `FF_RUNS` being off. |

**What the probe does not show.** Production has no run rows, so "0 visible with no user" does not demonstrate isolation there by itself. Isolation, rejected cross-project inserts and fail-closed behaviour were shown with synthetic data on the verification branch (§3), because writing test rows to production is not allowed.

## 6. Closure and the remaining gate on `FF_RUNS`

**Closed (2026-09-24).** The P1-D verification is closed for security and deployment:

- The RLS design and its fail-closed behaviour are verified on Neon PostgreSQL 18.6 (§2–§3).
- Production has migrations 0014/0015 applied, and the read-only RLS probe passes there (§5).
- Production connects as `neondb_owner` through the pooled host.
- `FF_RUNS` and `FF_GRAPH` are absent from the production environment, so both default to `false`. Research runs are unreachable in production (their routes return 404).

**The one remaining gate: app-level `test:runs:db` on a Neon branch before `FF_RUNS` is enabled.**

- **What it covers.** It runs the application's own run path against Neon's **pooled** host on **PostgreSQL 18**: the `postgres-js` driver (`prepare: false`), `withRunScope`'s transaction-local `SET LOCAL ROLE academic_app` + `set_config('app.user_id', …, true)`, and `assertRlsEnforced`. That is the combination production uses. The same suite (74 checks) already passes on PostgreSQL 16 locally and in CI. The database-level SQL was verified on PostgreSQL 18, most likely through the pooler (§4, correction).
- **Why it is a gate and not a blocker for closure.** A failure there would be functional (runs refused or failing), not a data exposure. The probe runs in the same transaction as the work and refuses the run if the role or policies are not in force.
- **How to satisfy it.** Create a temporary branch of `academic-ai-eu` with an empty `p1d_verify` database. Run `npm run db:migrate`, `db:seed` and `test:runs:db` against its direct string, then run `test:runs:db` against its `-pooler` string. Both runs must end `74 passed, 0 failed` with exit code 0. Then delete the branch.
  - Run it from a machine that can reach `*.neon.tech`.
  - Obtain the connection strings with `neonctl connection-string … [--pooled]` straight into variables, so no credential is copied by hand.
  - Never run it against the production connection string: the suite briefly gives `academic_app` BYPASSRLS on the branch it runs on.
- **Until the gate is met, `FF_RUNS` stays off.** Enabling it also requires `FF_GRAPH` and a queue-backed `JOB_RUNNER`. Production already uses `JOB_RUNNER=inline` per `render.yaml`.

**What this does not claim.** It does not claim general "Neon support", nor that the whole application is RLS-protected (RLS covers only the four run tables and the run paths). It does not claim that the app-level Neon test has passed: it has not been executed.
