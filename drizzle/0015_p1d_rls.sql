/* ------------------------------------------------------------------------
 * P1-D: row-level security for the research-run tables.
 *
 * Scope (approved): research_runs, run_steps, run_approvals, run_events, on
 * the run paths. It does NOT protect the rest of the application: the app
 * still connects as the table owner, which bypasses RLS, and every other
 * table keeps its application-level authorisation.
 *
 * How it binds: the run code opens a transaction and runs
 *   SET LOCAL ROLE academic_app;  SELECT set_config('app.user_id', <user>, true);
 * academic_app has NOBYPASSRLS and is not a table owner, so the policies
 * below apply. Both settings are transaction-local (safe behind a
 * transaction-mode pooler).
 *
 * If the role cannot be created here (a managed database whose migration role
 * lacks CREATEROLE), this migration warns instead of failing the deploy, and
 * the run engine refuses to start (src/server/runs/db-scope.ts checks the role
 * and that RLS is enforced before any run). It never falls back to running
 * without the database check.
 * ---------------------------------------------------------------------- */

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'academic_app') THEN
    CREATE ROLE academic_app NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'P1-D: cannot create role academic_app (%); research runs will refuse to start until an administrator creates it (see docs/phase1/P1D_REPORT.md).', SQLERRM;
END $$;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'academic_app') THEN
    EXECUTE 'GRANT academic_app TO ' || quote_ident(current_user);
  END IF;
EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
  RAISE WARNING 'P1-D: cannot grant academic_app to % (%); research runs will refuse to start.', current_user, SQLERRM;
END $$;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'academic_app') THEN
    GRANT USAGE ON SCHEMA public TO academic_app;
    GRANT SELECT, INSERT, UPDATE ON research_runs, run_steps, run_approvals TO academic_app;
    GRANT SELECT, INSERT ON run_events TO academic_app;
    GRANT USAGE, SELECT ON SEQUENCE run_events_id_seq TO academic_app;
  END IF;
END $$;--> statement-breakpoint

/* Who is acting, from the transaction-local setting. Null outside a run scope. */
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS text
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;--> statement-breakpoint

/*
 * The acting user's rank on a project: OWNER 4, EDITOR 3, COMMENTER 2,
 * VIEWER 1, none 0. Mirrors requireProjectRole (membership row, or the
 * project's creator as owner). SECURITY DEFINER with a fixed search_path, so
 * it reads membership without granting academic_app access to it and without
 * recursing into other policies.
 */
CREATE OR REPLACE FUNCTION app_project_rank(p_project text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT GREATEST(
    coalesce((
      SELECT max(CASE m.role::text WHEN 'OWNER' THEN 4 WHEN 'EDITOR' THEN 3 WHEN 'COMMENTER' THEN 2 WHEN 'VIEWER' THEN 1 ELSE 0 END)
      FROM project_members m
      WHERE m.project_id = p_project AND m.user_id = app_current_user_id()
    ), 0),
    CASE WHEN EXISTS (SELECT 1 FROM research_projects p WHERE p.id = p_project AND p.user_id = app_current_user_id()) THEN 4 ELSE 0 END
  )
$$;--> statement-breakpoint

/* The project and the owner of a run, for the policies of its child rows. */
CREATE OR REPLACE FUNCTION app_run_project(p_run text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT r.project_id FROM research_runs r WHERE r.id = p_run $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_run_owner(p_run text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT r.user_id FROM research_runs r WHERE r.id = p_run $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_project_rank(text), app_run_project(text), app_run_owner(text) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'academic_app') THEN
    GRANT EXECUTE ON FUNCTION app_current_user_id(), app_project_rank(text), app_run_project(text), app_run_owner(text) TO academic_app;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE research_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE run_steps ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE run_approvals ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

/* research_runs: members read; editors create their own runs and update (cancel, progress). No delete. */
CREATE POLICY research_runs_read ON research_runs FOR SELECT USING (app_project_rank(project_id) >= 1);--> statement-breakpoint
CREATE POLICY research_runs_create ON research_runs FOR INSERT WITH CHECK (user_id = app_current_user_id() AND app_project_rank(project_id) >= 3);--> statement-breakpoint
CREATE POLICY research_runs_update ON research_runs FOR UPDATE USING (app_project_rank(project_id) >= 3) WITH CHECK (app_project_rank(project_id) >= 3);--> statement-breakpoint

/* run_steps: members of the run's project read; only the run's owner, while still an editor, writes. */
CREATE POLICY run_steps_read ON run_steps FOR SELECT USING (app_project_rank(app_run_project(run_id)) >= 1);--> statement-breakpoint
CREATE POLICY run_steps_create ON run_steps FOR INSERT WITH CHECK (app_run_owner(run_id) = app_current_user_id() AND app_project_rank(app_run_project(run_id)) >= 3);--> statement-breakpoint
CREATE POLICY run_steps_update ON run_steps FOR UPDATE
  USING (app_run_owner(run_id) = app_current_user_id() AND app_project_rank(app_run_project(run_id)) >= 3)
  WITH CHECK (app_run_owner(run_id) = app_current_user_id() AND app_project_rank(app_run_project(run_id)) >= 3);--> statement-breakpoint

/* run_approvals: members read; the run's owner requests and consumes; the owner or a project OWNER decides. */
CREATE POLICY run_approvals_read ON run_approvals FOR SELECT USING (app_project_rank(project_id) >= 1);--> statement-breakpoint
CREATE POLICY run_approvals_create ON run_approvals FOR INSERT WITH CHECK (
  user_id = app_current_user_id() AND app_run_owner(run_id) = app_current_user_id()
  AND app_run_project(run_id) = project_id AND app_project_rank(project_id) >= 3);--> statement-breakpoint
CREATE POLICY run_approvals_update ON run_approvals FOR UPDATE
  USING ((user_id = app_current_user_id() AND app_project_rank(project_id) >= 3) OR app_project_rank(project_id) >= 4)
  WITH CHECK ((user_id = app_current_user_id() AND app_project_rank(project_id) >= 3) OR app_project_rank(project_id) >= 4);--> statement-breakpoint

/* run_events: members read; an editor records events as themself, on a run of that project. */
CREATE POLICY run_events_read ON run_events FOR SELECT USING (app_project_rank(project_id) >= 1);--> statement-breakpoint
CREATE POLICY run_events_create ON run_events FOR INSERT WITH CHECK (
  user_id = app_current_user_id() AND app_run_project(run_id) = project_id AND app_project_rank(project_id) >= 3);
