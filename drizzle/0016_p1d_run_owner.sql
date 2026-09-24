/* ------------------------------------------------------------------------
 * P1-D WS1 (item 9, approved): a run can be updated (and so cancelled) only
 * by its owner, while still an EDITOR of the project, or by a project OWNER.
 *
 * Replaces the one policy `research_runs_update` from 0015, which allowed any
 * EDITOR of the project to update any run. Same helpers and rank semantics as
 * 0015 (app_current_user_id, app_project_rank: OWNER 4, EDITOR 3), and the
 * same shape as `run_approvals_update`. Nothing else changes: no DELETE policy
 * (and no DELETE grant), the TRUNCATE and delete guards from 0014, RLS on all
 * four run tables, and every other policy stay as they are. No data changes.
 *
 * Rollback: re-create the 0015 policy
 *   USING (app_project_rank(project_id) >= 3) WITH CHECK (app_project_rank(project_id) >= 3).
 * ---------------------------------------------------------------------- */
DROP POLICY IF EXISTS research_runs_update ON research_runs;--> statement-breakpoint
CREATE POLICY research_runs_update ON research_runs FOR UPDATE
  USING ((user_id = app_current_user_id() AND app_project_rank(project_id) >= 3) OR app_project_rank(project_id) >= 4)
  WITH CHECK ((user_id = app_current_user_id() AND app_project_rank(project_id) >= 3) OR app_project_rank(project_id) >= 4);
