# P1-D: RLS verification on a Neon branch

**Date:** 2026-09-23 · **Neon project:** `academic-ai-eu` · **Branch:** `p1d-rls-verify` (`br-muddy-breeze-b2yfw4tj`), created from the default branch (`import`). The verification wrote only to this branch; production was neither read nor changed. · **Server:** PostgreSQL 18.6 · **Connected as:** `neondb_owner`

**Result.** The RLS design of migrations 0014 and 0015 works on Neon, with the roles Neon provides. All checks below passed. `FF_RUNS` stays **off**: this verifies the database layer, and the remaining pre-production items in §4 are still open.

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

## 4. Still open before `FF_RUNS` is enabled anywhere real (blocking)

1. **Application connection.** Run the application's own run path (`postgres-js` over TCP, `withRunScope`) against a Neon branch. The simplest way is `npm run test:runs:db`, from a machine or CI job that can reach Neon. This session could not: TCP to Neon is blocked. The SQL it would issue was verified above, statement by statement.
2. **Pooler.** Confirm the production `DATABASE_URL`:
   - If it uses Neon's pooled (PgBouncer, transaction mode) host, the transaction-local `SET LOCAL ROLE` and `set_config(…, true)` are the correct pattern. Check 1 of item 1 above should still be run through the pooled URL.
   - If the application connects as a role other than `neondb_owner`, that role must be the one migration 0015 grants `academic_app` to (the migration grants it to `current_user`). Re-run check 1 as that role.
3. **Deploy order.** Apply migrations 0014 and 0015 to production through the normal migration step, with `FF_RUNS` **off**. Then run the probe (check 1) against production, read-only, before any flag change.
4. **Clean-up.** The branch `p1d-rls-verify` holds a copy of the default branch's data plus the synthetic `p1dv-` rows. Delete it when this verification is no longer needed. It was not deleted automatically: deleting a branch is irreversible, so it waits for the owner's decision.

**What this does not claim.** It does not claim general "Neon support", nor that the whole application is RLS-protected. It shows that, on Neon PostgreSQL 18.6 with the `neondb_owner` role:

- migrations 0014 and 0015 apply;
- the restricted role can be created and used;
- the P1-D policies isolate projects;
- the fail-closed probe detects every way enforcement can be lost.
