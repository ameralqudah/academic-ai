CREATE TABLE "dataset_transformations" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text,
	"user_id" text NOT NULL,
	"project_id" text,
	"input_version_id" text,
	"output_version_id" text NOT NULL,
	"operation" varchar(32) NOT NULL,
	"parameters" jsonb NOT NULL,
	"report" jsonb NOT NULL,
	"engine_version" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text,
	"user_id" text NOT NULL,
	"project_id" text,
	"version_no" integer NOT NULL,
	"parent_version_id" text,
	"content_hash" varchar(64) NOT NULL,
	"schema_hash" varchar(64) NOT NULL,
	"file_checksum" varchar(64) NOT NULL,
	"storage_key" text NOT NULL,
	"row_count" integer NOT NULL,
	"column_count" integer NOT NULL,
	"columns" jsonb NOT NULL,
	"graph_node_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stat_estimates" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"key" varchar(1000) NOT NULL,
	"label" varchar(1000) NOT NULL,
	"family" varchar(40) NOT NULL,
	"term" varchar(1000),
	"stat" varchar(40) NOT NULL,
	"estimate" double precision NOT NULL,
	"se" double precision,
	"statistic" double precision,
	"statistic_name" varchar(16),
	"df" double precision,
	"df2" double precision,
	"p" double precision,
	"ci_low" double precision,
	"ci_high" double precision,
	"ci_level" double precision,
	"ci_method" varchar(32),
	"n" integer,
	"graph_node_id" text
);
--> statement-breakpoint
CREATE TABLE "stat_figures" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" varchar(40) NOT NULL,
	"title" varchar(300) NOT NULL,
	"svg" text NOT NULL,
	"keys" jsonb NOT NULL,
	"graph_node_id" text
);
--> statement-breakpoint
CREATE TABLE "stat_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"spec_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"dataset_version_id" text NOT NULL,
	"dataset_content_hash" varchar(64) NOT NULL,
	"spec_hash" varchar(64) NOT NULL,
	"analysis_type" varchar(32) NOT NULL,
	"engine" varchar(64) NOT NULL,
	"engine_version" varchar(32) NOT NULL,
	"runtime" varchar(64) NOT NULL,
	"status" varchar(16) NOT NULL,
	"method" varchar(100),
	"seed" integer,
	"parameters" jsonb,
	"missing_strategy" varchar(16),
	"n_supplied" integer,
	"n_used" integer,
	"n_excluded" integer,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" jsonb,
	"assumptions" jsonb,
	"payload" jsonb,
	"result_hash" varchar(64),
	"supersedes_run_id" text,
	"impact_acknowledged" varchar(128),
	"idempotency_key" varchar(200),
	"job_id" text,
	"graph_run_node_id" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stat_specs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"dataset_version_id" text NOT NULL,
	"analysis_type" varchar(32) NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_hash" varchar(64) NOT NULL,
	"label" varchar(200),
	"hypothesis_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"construct_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" varchar(16) DEFAULT 'user' NOT NULL,
	"graph_node_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stat_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" varchar(40) NOT NULL,
	"title" varchar(300) NOT NULL,
	"content" jsonb NOT NULL,
	"keys" jsonb NOT NULL,
	"graph_node_id" text
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "dataset_version_id" text;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "dataset_content_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "engine_version" varchar(64);--> statement-breakpoint
ALTER TABLE "dataset_transformations" ADD CONSTRAINT "dataset_transformations_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_transformations" ADD CONSTRAINT "dataset_transformations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_transformations" ADD CONSTRAINT "dataset_transformations_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_transformations" ADD CONSTRAINT "dataset_transformations_input_version_id_dataset_versions_id_fk" FOREIGN KEY ("input_version_id") REFERENCES "public"."dataset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_transformations" ADD CONSTRAINT "dataset_transformations_output_version_id_dataset_versions_id_fk" FOREIGN KEY ("output_version_id") REFERENCES "public"."dataset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_parent_version_id_dataset_versions_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."dataset_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_estimates" ADD CONSTRAINT "stat_estimates_run_id_stat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."stat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_figures" ADD CONSTRAINT "stat_figures_run_id_stat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."stat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_runs" ADD CONSTRAINT "stat_runs_spec_id_stat_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."stat_specs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_runs" ADD CONSTRAINT "stat_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_runs" ADD CONSTRAINT "stat_runs_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_runs" ADD CONSTRAINT "stat_runs_dataset_version_id_dataset_versions_id_fk" FOREIGN KEY ("dataset_version_id") REFERENCES "public"."dataset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_runs" ADD CONSTRAINT "stat_runs_supersedes_run_id_stat_runs_id_fk" FOREIGN KEY ("supersedes_run_id") REFERENCES "public"."stat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_specs" ADD CONSTRAINT "stat_specs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_specs" ADD CONSTRAINT "stat_specs_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_specs" ADD CONSTRAINT "stat_specs_dataset_version_id_dataset_versions_id_fk" FOREIGN KEY ("dataset_version_id") REFERENCES "public"."dataset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_tables" ADD CONSTRAINT "stat_tables_run_id_stat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."stat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_transformations_output_idx" ON "dataset_transformations" USING btree ("output_version_id");--> statement-breakpoint
CREATE INDEX "dataset_transformations_input_idx" ON "dataset_transformations" USING btree ("input_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_versions_dataset_no_idx" ON "dataset_versions" USING btree ("dataset_id","version_no");--> statement-breakpoint
CREATE INDEX "dataset_versions_project_idx" ON "dataset_versions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "dataset_versions_user_idx" ON "dataset_versions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stat_estimates_run_key_idx" ON "stat_estimates" USING btree ("run_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "stat_figures_run_position_idx" ON "stat_figures" USING btree ("run_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "stat_runs_idempotency_idx" ON "stat_runs" USING btree ("spec_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "stat_runs_project_idx" ON "stat_runs" USING btree ("project_id","queued_at");--> statement-breakpoint
CREATE INDEX "stat_runs_spec_idx" ON "stat_runs" USING btree ("spec_id");--> statement-breakpoint
CREATE INDEX "stat_specs_project_idx" ON "stat_specs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "stat_specs_version_idx" ON "stat_specs" USING btree ("dataset_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stat_tables_run_position_idx" ON "stat_tables" USING btree ("run_id","position");--> statement-breakpoint
-- P1-C immutability. A direct DELETE is refused; rows go only when a project or account is deleted (a cascade runs at trigger depth > 1).
ALTER TABLE "stat_runs" ADD CONSTRAINT "stat_runs_status_check" CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'refused', 'cancelled'));--> statement-breakpoint
ALTER TABLE "dataset_transformations" ADD CONSTRAINT "dataset_transformations_operation_check" CHECK ("operation" IN ('import', 'clean', 'set-schema'));--> statement-breakpoint
ALTER TABLE "stat_specs" ADD CONSTRAINT "stat_specs_origin_check" CHECK ("origin" IN ('user', 'assistant'));--> statement-breakpoint
CREATE FUNCTION "p1c_no_direct_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are part of the provenance record and cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;--> statement-breakpoint
-- Versions, transformations and specifications never change; only a graph node id may be filled in once,
-- and foreign keys may be cleared by their own ON DELETE SET NULL.
CREATE FUNCTION "p1c_write_once"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
  k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(old_row) LOOP
    CONTINUE WHEN old_row -> k IS NOT DISTINCT FROM new_row -> k;
    CONTINUE WHEN k IN ('graph_node_id', 'graph_run_node_id') AND old_row -> k = 'null'::jsonb;
    CONTINUE WHEN k IN ('dataset_id', 'parent_version_id', 'supersedes_run_id') AND new_row -> k = 'null'::jsonb AND pg_trigger_depth() > 1;
    RAISE EXCEPTION '%.% is immutable', TG_TABLE_NAME, k USING ERRCODE = 'integrity_constraint_violation';
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "dataset_versions_write_once" BEFORE UPDATE ON "dataset_versions" FOR EACH ROW EXECUTE FUNCTION "p1c_write_once"();--> statement-breakpoint
CREATE TRIGGER "dataset_versions_no_delete" BEFORE DELETE ON "dataset_versions" FOR EACH ROW EXECUTE FUNCTION "p1c_no_direct_delete"();--> statement-breakpoint
CREATE TRIGGER "dataset_transformations_write_once" BEFORE UPDATE ON "dataset_transformations" FOR EACH ROW EXECUTE FUNCTION "p1c_write_once"();--> statement-breakpoint
CREATE TRIGGER "dataset_transformations_no_delete" BEFORE DELETE ON "dataset_transformations" FOR EACH ROW EXECUTE FUNCTION "p1c_no_direct_delete"();--> statement-breakpoint
CREATE TRIGGER "stat_specs_write_once" BEFORE UPDATE ON "stat_specs" FOR EACH ROW EXECUTE FUNCTION "p1c_write_once"();--> statement-breakpoint
CREATE TRIGGER "stat_specs_no_delete" BEFORE DELETE ON "stat_specs" FOR EACH ROW EXECUTE FUNCTION "p1c_no_direct_delete"();--> statement-breakpoint
-- A run's inputs never change. Its outcome is written once, by a legal status transition; after that only
-- the graph run node id may be filled in.
CREATE FUNCTION "stat_runs_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  terminal text[] := ARRAY['succeeded', 'failed', 'refused', 'cancelled'];
  identity text[] := ARRAY['id', 'spec_id', 'user_id', 'project_id', 'dataset_version_id', 'dataset_content_hash', 'spec_hash', 'impact_acknowledged',
                           'analysis_type', 'engine', 'engine_version', 'runtime', 'idempotency_key', 'queued_at'];
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
  k text;
BEGIN
  IF OLD.status = ANY (terminal) THEN
    FOR k IN SELECT jsonb_object_keys(old_row) LOOP
      CONTINUE WHEN old_row -> k IS NOT DISTINCT FROM new_row -> k;
      CONTINUE WHEN k = 'graph_run_node_id' AND old_row -> k = 'null'::jsonb;
      CONTINUE WHEN k IN ('supersedes_run_id', 'project_id') AND new_row -> k = 'null'::jsonb AND pg_trigger_depth() > 1;
      RAISE EXCEPTION 'stat_runs: a finished run is immutable (%)', k USING ERRCODE = 'integrity_constraint_violation';
    END LOOP;
    RETURN NEW;
  END IF;
  FOREACH k IN ARRAY identity LOOP
    IF old_row -> k IS DISTINCT FROM new_row -> k AND NOT (k = 'project_id' AND pg_trigger_depth() > 1) THEN
      RAISE EXCEPTION 'stat_runs.% is immutable', k USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END LOOP;
  IF NOT ((OLD.status = NEW.status)
       OR (OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'refused', 'cancelled'))
       OR (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'refused', 'cancelled'))) THEN
    RAISE EXCEPTION 'stat_runs: illegal status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'succeeded' AND (NEW.result_hash IS NULL OR NEW.finished_at IS NULL) THEN
    RAISE EXCEPTION 'stat_runs: a succeeded run needs its result hash' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "stat_runs_guard" BEFORE UPDATE ON "stat_runs" FOR EACH ROW EXECUTE FUNCTION "stat_runs_guard"();--> statement-breakpoint
CREATE TRIGGER "stat_runs_no_delete" BEFORE DELETE ON "stat_runs" FOR EACH ROW EXECUTE FUNCTION "p1c_no_direct_delete"();--> statement-breakpoint
-- Estimates, tables and figures are written only by the engine, while it completes a running run:
-- never added to a finished run, never edited afterwards.
CREATE FUNCTION "p1c_result_insert_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "stat_runs" WHERE "id" = NEW.run_id AND "status" = 'running') THEN
    RAISE EXCEPTION '%: results can be written only while their run is running', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "stat_estimates_insert_guard" BEFORE INSERT ON "stat_estimates" FOR EACH ROW EXECUTE FUNCTION "p1c_result_insert_guard"();--> statement-breakpoint
CREATE TRIGGER "stat_estimates_write_once" BEFORE UPDATE ON "stat_estimates" FOR EACH ROW EXECUTE FUNCTION "p1c_write_once"();--> statement-breakpoint
CREATE TRIGGER "stat_estimates_no_delete" BEFORE DELETE ON "stat_estimates" FOR EACH ROW EXECUTE FUNCTION "p1c_no_direct_delete"();--> statement-breakpoint
CREATE TRIGGER "stat_tables_insert_guard" BEFORE INSERT ON "stat_tables" FOR EACH ROW EXECUTE FUNCTION "p1c_result_insert_guard"();--> statement-breakpoint
CREATE TRIGGER "stat_tables_write_once" BEFORE UPDATE ON "stat_tables" FOR EACH ROW EXECUTE FUNCTION "p1c_write_once"();--> statement-breakpoint
CREATE TRIGGER "stat_tables_no_delete" BEFORE DELETE ON "stat_tables" FOR EACH ROW EXECUTE FUNCTION "p1c_no_direct_delete"();--> statement-breakpoint
CREATE TRIGGER "stat_figures_insert_guard" BEFORE INSERT ON "stat_figures" FOR EACH ROW EXECUTE FUNCTION "p1c_result_insert_guard"();--> statement-breakpoint
CREATE TRIGGER "stat_figures_write_once" BEFORE UPDATE ON "stat_figures" FOR EACH ROW EXECUTE FUNCTION "p1c_write_once"();--> statement-breakpoint
CREATE TRIGGER "stat_figures_no_delete" BEFORE DELETE ON "stat_figures" FOR EACH ROW EXECUTE FUNCTION "p1c_no_direct_delete"();
--> statement-breakpoint
-- A run is created queued, with no outcome: nothing can be inserted already running or finished (P1-C review).
CREATE FUNCTION "stat_runs_insert_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'queued' OR NEW.result_hash IS NOT NULL OR NEW.payload IS NOT NULL OR NEW.parameters IS NOT NULL
     OR NEW.method IS NOT NULL OR NEW.n_used IS NOT NULL OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL OR NEW.graph_run_node_id IS NOT NULL THEN
    RAISE EXCEPTION 'stat_runs: a run is created queued, with no outcome' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "stat_runs_insert_guard" BEFORE INSERT ON "stat_runs" FOR EACH ROW EXECUTE FUNCTION "stat_runs_insert_guard"();--> statement-breakpoint
CREATE FUNCTION "p1c_no_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is part of the provenance record and cannot be truncated', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "dataset_versions_no_truncate" BEFORE TRUNCATE ON "dataset_versions" FOR EACH STATEMENT EXECUTE FUNCTION "p1c_no_truncate"();--> statement-breakpoint
CREATE TRIGGER "dataset_transformations_no_truncate" BEFORE TRUNCATE ON "dataset_transformations" FOR EACH STATEMENT EXECUTE FUNCTION "p1c_no_truncate"();--> statement-breakpoint
CREATE TRIGGER "stat_specs_no_truncate" BEFORE TRUNCATE ON "stat_specs" FOR EACH STATEMENT EXECUTE FUNCTION "p1c_no_truncate"();--> statement-breakpoint
CREATE TRIGGER "stat_runs_no_truncate" BEFORE TRUNCATE ON "stat_runs" FOR EACH STATEMENT EXECUTE FUNCTION "p1c_no_truncate"();--> statement-breakpoint
CREATE TRIGGER "stat_estimates_no_truncate" BEFORE TRUNCATE ON "stat_estimates" FOR EACH STATEMENT EXECUTE FUNCTION "p1c_no_truncate"();--> statement-breakpoint
CREATE TRIGGER "stat_tables_no_truncate" BEFORE TRUNCATE ON "stat_tables" FOR EACH STATEMENT EXECUTE FUNCTION "p1c_no_truncate"();--> statement-breakpoint
CREATE TRIGGER "stat_figures_no_truncate" BEFORE TRUNCATE ON "stat_figures" FOR EACH STATEMENT EXECUTE FUNCTION "p1c_no_truncate"();
