CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" varchar(16) NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"kind" varchar(24) NOT NULL,
	"content" text NOT NULL,
	"source" varchar(16) DEFAULT 'user' NOT NULL,
	"status" varchar(16) DEFAULT 'confirmed' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"origin" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"summary" text NOT NULL,
	"through_message_id" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"model" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_summaries" ADD CONSTRAINT "thread_summaries_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_summaries" ADD CONSTRAINT "thread_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_user_idx" ON "memories" USING btree ("user_id","scope","status");--> statement-breakpoint
CREATE INDEX "memories_project_idx" ON "memories" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_summaries_version_idx" ON "thread_summaries" USING btree ("conversation_id","version");--> statement-breakpoint
/* ------------------------------------------------------------------------
 * P1-E (PR #1, approved): memories and thread summaries, under row-level
 * security on the same model as the research-run tables (0014–0016).
 *
 * Binding (unchanged from 0015): the memory code opens a transaction and runs
 *   SET LOCAL ROLE academic_app;  SELECT set_config('app.user_id', <user>, true);
 * academic_app has NOBYPASSRLS and owns no table, so the policies below apply;
 * both settings are transaction-local. The owner connection (migrations, the
 * system path) bypasses RLS, as for the run tables. If the role is missing the
 * grants are skipped with a warning and the memory code refuses to start
 * (`server/memory/db-scope.ts` proves RLS before any scope): it never falls
 * back to application checks alone.
 *
 * Who may do what (ranks from app_project_rank: OWNER 4, EDITOR 3,
 * COMMENTER 2, VIEWER 1 — membership, member-scoped, per the WS4 A2 decision):
 *   memories, scope user     its user alone reads, creates, edits, deletes;
 *   memories, scope project  members read; an EDITOR creates as themself;
 *                            the author while still an EDITOR, or a project
 *                            OWNER, edits or deletes;
 *   thread_summaries         the conversation's owner alone reads, appends
 *                            and deletes; no row is ever edited.
 * ---------------------------------------------------------------------- */

ALTER TABLE "memories" ADD CONSTRAINT "memories_scope_check" CHECK (scope IN ('user', 'project'));--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_scope_project_check" CHECK ((scope = 'user' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_kind_check" CHECK (kind IN ('preference', 'fact', 'instruction', 'style', 'decision'));--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_check" CHECK (source IN ('user', 'agent'));--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_status_check" CHECK (status IN ('proposed', 'confirmed', 'archived'));--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_content_check" CHECK (char_length(btrim(content)) BETWEEN 1 AND 2000);--> statement-breakpoint
ALTER TABLE "thread_summaries" ADD CONSTRAINT "thread_summaries_version_check" CHECK (version >= 1);--> statement-breakpoint
ALTER TABLE "thread_summaries" ADD CONSTRAINT "thread_summaries_summary_check" CHECK (char_length(btrim(summary)) BETWEEN 1 AND 20000);--> statement-breakpoint
ALTER TABLE "thread_summaries" ADD CONSTRAINT "thread_summaries_count_check" CHECK (message_count >= 0);--> statement-breakpoint

/*
 * memories: an agent only proposes; the scope, its user and project, the
 * source and the creation time never change (so a memory cannot be moved out
 * of its project's policies); a status moves proposed → confirmed | archived,
 * confirmed ↔ archived; confirming stamps confirmed_at.
 */
CREATE OR REPLACE FUNCTION p1e_memories_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source = 'agent' AND NEW.status <> 'proposed' THEN
      RAISE EXCEPTION 'memories: an agent can only propose a memory';
    END IF;
    IF NEW.status = 'confirmed' AND NEW.confirmed_at IS NULL THEN
      NEW.confirmed_at := now();
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.scope IS DISTINCT FROM OLD.scope OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'memories: scope, user, project, source and creation are immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'proposed' AND NEW.status IN ('confirmed', 'archived'))
    OR (OLD.status = 'confirmed' AND NEW.status = 'archived')
    OR (OLD.status = 'archived' AND NEW.status = 'confirmed')) THEN
    RAISE EXCEPTION 'memories: illegal status transition % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' THEN
    NEW.confirmed_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER memories_guard BEFORE INSERT OR UPDATE ON "memories" FOR EACH ROW EXECUTE FUNCTION p1e_memories_guard();--> statement-breakpoint

/* The owner of a conversation, for the summaries' policies. SECURITY DEFINER, fixed search_path, as app_run_owner. */
CREATE OR REPLACE FUNCTION app_conversation_owner(p_conversation text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT c.user_id FROM ai_conversations c WHERE c.id = p_conversation $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_conversation_owner(text) FROM PUBLIC;--> statement-breakpoint

/* thread_summaries: written by the conversation's owner only, and never edited (a new version is a new row). */
CREATE OR REPLACE FUNCTION p1e_thread_summaries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'thread_summaries: a summary is never edited; append a new version';
  END IF;
  /* Through the SECURITY DEFINER helper: the restricted role cannot read ai_conversations itself. */
  IF app_conversation_owner(NEW.conversation_id) IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'thread_summaries: the user must own the conversation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER thread_summaries_guard BEFORE INSERT OR UPDATE ON "thread_summaries" FOR EACH ROW EXECUTE FUNCTION p1e_thread_summaries_guard();--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'academic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO academic_app;
    GRANT SELECT, INSERT, DELETE ON thread_summaries TO academic_app;
    GRANT EXECUTE ON FUNCTION app_conversation_owner(text) TO academic_app;
  ELSE
    RAISE WARNING 'P1-E: role academic_app is missing; memories and thread summaries will refuse to start until it exists (see docs/phase1/P1E_REPORT.md).';
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "thread_summaries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY memories_read ON memories FOR SELECT USING (
  (scope = 'user' AND user_id = app_current_user_id())
  OR (scope = 'project' AND app_project_rank(project_id) >= 1));--> statement-breakpoint
CREATE POLICY memories_create ON memories FOR INSERT WITH CHECK (
  user_id = app_current_user_id()
  AND ((scope = 'user' AND project_id IS NULL) OR (scope = 'project' AND app_project_rank(project_id) >= 3)));--> statement-breakpoint
CREATE POLICY memories_update ON memories FOR UPDATE
  USING ((scope = 'user' AND user_id = app_current_user_id())
    OR (scope = 'project' AND ((user_id = app_current_user_id() AND app_project_rank(project_id) >= 3) OR app_project_rank(project_id) >= 4)))
  WITH CHECK ((scope = 'user' AND user_id = app_current_user_id())
    OR (scope = 'project' AND ((user_id = app_current_user_id() AND app_project_rank(project_id) >= 3) OR app_project_rank(project_id) >= 4)));--> statement-breakpoint
CREATE POLICY memories_delete ON memories FOR DELETE USING (
  (scope = 'user' AND user_id = app_current_user_id())
  OR (scope = 'project' AND ((user_id = app_current_user_id() AND app_project_rank(project_id) >= 3) OR app_project_rank(project_id) >= 4)));--> statement-breakpoint

CREATE POLICY thread_summaries_read ON thread_summaries FOR SELECT USING (
  user_id = app_current_user_id() AND app_conversation_owner(conversation_id) = app_current_user_id());--> statement-breakpoint
CREATE POLICY thread_summaries_create ON thread_summaries FOR INSERT WITH CHECK (
  user_id = app_current_user_id() AND app_conversation_owner(conversation_id) = app_current_user_id());--> statement-breakpoint
CREATE POLICY thread_summaries_delete ON thread_summaries FOR DELETE USING (
  user_id = app_current_user_id() AND app_conversation_owner(conversation_id) = app_current_user_id());
