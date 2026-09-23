CREATE TABLE "research_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"intent" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plan" jsonb,
	"status" varchar(24) DEFAULT 'QUEUED' NOT NULL,
	"stop_reason" varchar(40),
	"tier" varchar(16) NOT NULL,
	"limits" jsonb NOT NULL,
	"spent" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"replans" integer DEFAULT 0 NOT NULL,
	"planner" jsonb,
	"cancel_requested_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" varchar(200),
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"action_hash" varchar(64) NOT NULL,
	"action" jsonb NOT NULL,
	"reason" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" varchar(40) NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"tool" varchar(80) NOT NULL,
	"tool_version" varchar(20) NOT NULL,
	"label" varchar(200) NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"validated_input" jsonb,
	"input_hash" varchar(64),
	"status" varchar(24) DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"policy" jsonb,
	"approval_id" text,
	"idempotency_key" varchar(64),
	"claim_token" varchar(64),
	"output" jsonb,
	"output_ref" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD COLUMN "step_id" text;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD COLUMN "step_id" text;--> statement-breakpoint
ALTER TABLE "dataset_transformations" ADD COLUMN "idempotency_key" varchar(64);--> statement-breakpoint
ALTER TABLE "graph_edges" ADD COLUMN "created_by_step_id" text;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD COLUMN "created_by_step_id" text;--> statement-breakpoint
ALTER TABLE "node_versions" ADD COLUMN "created_by_step_id" text;--> statement-breakpoint
ALTER TABLE "stat_specs" ADD COLUMN "idempotency_key" varchar(64);--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_approvals" ADD CONSTRAINT "run_approvals_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_approvals" ADD CONSTRAINT "run_approvals_step_id_run_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."run_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_approvals" ADD CONSTRAINT "run_approvals_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_approvals" ADD CONSTRAINT "run_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_approvals" ADD CONSTRAINT "run_approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_runs_project_idx" ON "research_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "research_runs_user_status_idx" ON "research_runs" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "research_runs_idempotency_idx" ON "research_runs" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "run_approvals_run_idx" ON "run_approvals" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "run_approvals_step_open_idx" ON "run_approvals" USING btree ("step_id") WHERE status in ('PENDING', 'APPROVED');--> statement-breakpoint
CREATE INDEX "run_events_run_idx" ON "run_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_seq_idx" ON "run_steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_idempotency_idx" ON "run_steps" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_transformations_idempotency_idx" ON "dataset_transformations" USING btree ("input_version_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_nodes_step_type_unique" ON "graph_nodes" USING btree ("project_id","created_by_step_id","type") WHERE created_by_step_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "stat_specs_idempotency_idx" ON "stat_specs" USING btree ("idempotency_key");--> statement-breakpoint
/* ------------------------------------------------------------------------
 * P1-D: research runs are enforced by the database, not only by the service.
 *  - legal status transitions for runs, steps and approvals; terminal frozen;
 *  - identity, tool and input columns immutable once written;
 *  - cancellation monotonic (set once, never cleared; a cancelled run never succeeds);
 *  - run_events insert-only;
 *  - no direct DELETE (only foreign-key cascades) and no TRUNCATE;
 *  - size limits on every free-form column.
 * ---------------------------------------------------------------------- */
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_status_check" CHECK ("status" IN ('QUEUED','PLANNING','RUNNING','WAITING_APPROVAL','SUCCEEDED','FAILED','CANCELLED'));--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_size_check" CHECK (char_length("intent") BETWEEN 1 AND 4000 AND octet_length("context"::text) <= 8192 AND octet_length(coalesce("plan"::text, '')) <= 65536 AND octet_length("limits"::text) <= 4096 AND octet_length("spent"::text) <= 4096 AND octet_length(coalesce("planner"::text, '')) <= 4096 AND octet_length(coalesce("error"::text, '')) <= 4096);--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_status_check" CHECK ("status" IN ('QUEUED','AUTHORIZED','WAITING_APPROVAL','RUNNING','SUCCEEDED','FAILED','CANCELLED','SKIPPED'));--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_size_check" CHECK ("seq" >= 0 AND "attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 10 AND octet_length("input"::text) <= 16384 AND octet_length(coalesce("validated_input"::text, '')) <= 16384 AND octet_length(coalesce("output"::text, '')) <= 65536 AND octet_length(coalesce("output_ref"::text, '')) <= 1024 AND octet_length(coalesce("policy"::text, '')) <= 4096 AND octet_length(coalesce("error"::text, '')) <= 4096 AND jsonb_array_length("depends_on") <= 20);--> statement-breakpoint
ALTER TABLE "run_approvals" ADD CONSTRAINT "run_approvals_status_check" CHECK ("status" IN ('PENDING','APPROVED','REJECTED','EXPIRED','CONSUMED'));--> statement-breakpoint
ALTER TABLE "run_approvals" ADD CONSTRAINT "run_approvals_size_check" CHECK (octet_length("action"::text) <= 16384 AND "action_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_size_check" CHECK (octet_length("data"::text) <= 4096);--> statement-breakpoint

CREATE OR REPLACE FUNCTION p1d_research_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  legal boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'QUEUED' OR NEW.finished_at IS NOT NULL OR NEW.cancel_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'research_runs: a run is created QUEUED';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id OR NEW.user_id <> OLD.user_id OR NEW.intent <> OLD.intent
     OR NEW.context <> OLD.context OR NEW.tier <> OLD.tier OR NEW.limits <> OLD.limits
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'research_runs: identity, intent and limits are immutable';
  END IF;
  IF OLD.plan IS NOT NULL AND NEW.plan IS DISTINCT FROM OLD.plan THEN
    RAISE EXCEPTION 'research_runs: a recorded plan is immutable';
  END IF;
  IF OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at THEN
    RAISE EXCEPTION 'research_runs: cancellation is monotonic';
  END IF;
  IF OLD.status IN ('SUCCEEDED','FAILED','CANCELLED') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'research_runs: a finished run is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status THEN
    legal := (OLD.status, NEW.status) IN (
      ('QUEUED','PLANNING'), ('QUEUED','CANCELLED'), ('QUEUED','FAILED'),
      ('PLANNING','RUNNING'), ('PLANNING','FAILED'), ('PLANNING','CANCELLED'), ('PLANNING','QUEUED'),
      ('RUNNING','WAITING_APPROVAL'), ('RUNNING','SUCCEEDED'), ('RUNNING','FAILED'), ('RUNNING','CANCELLED'), ('RUNNING','QUEUED'),
      ('WAITING_APPROVAL','QUEUED'), ('WAITING_APPROVAL','RUNNING'), ('WAITING_APPROVAL','FAILED'), ('WAITING_APPROVAL','CANCELLED'));
    IF NOT legal THEN
      RAISE EXCEPTION 'research_runs: illegal status transition % -> %', OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'SUCCEEDED' AND NEW.cancel_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'research_runs: a cancelled run cannot succeed';
    END IF;
    IF NEW.status IN ('SUCCEEDED','FAILED','CANCELLED') AND NEW.finished_at IS NULL THEN
      RAISE EXCEPTION 'research_runs: a finished run records finished_at';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER research_runs_guard BEFORE INSERT OR UPDATE ON "research_runs" FOR EACH ROW EXECUTE FUNCTION p1d_research_runs_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION p1d_run_steps_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  legal boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'QUEUED' OR NEW.output IS NOT NULL OR NEW.output_ref IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'run_steps: a step is created QUEUED, with no outcome';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.run_id <> OLD.run_id OR NEW.seq <> OLD.seq OR NEW.tool <> OLD.tool
     OR NEW.tool_version <> OLD.tool_version OR NEW.input <> OLD.input OR NEW.depends_on <> OLD.depends_on
     OR NEW.max_attempts <> OLD.max_attempts OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'run_steps: identity, tool and input are immutable';
  END IF;
  IF OLD.validated_input IS NOT NULL AND NEW.validated_input IS DISTINCT FROM OLD.validated_input THEN
    RAISE EXCEPTION 'run_steps: the validated input is written once';
  END IF;
  IF OLD.idempotency_key IS NOT NULL AND NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'run_steps: the idempotency key is written once';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'run_steps: attempts never decrease';
  END IF;
  IF OLD.status IN ('SUCCEEDED','CANCELLED','SKIPPED') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'run_steps: a settled step is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status THEN
    legal := (OLD.status, NEW.status) IN (
      ('QUEUED','AUTHORIZED'), ('QUEUED','WAITING_APPROVAL'), ('QUEUED','SKIPPED'), ('QUEUED','CANCELLED'),
      ('WAITING_APPROVAL','AUTHORIZED'), ('WAITING_APPROVAL','SKIPPED'), ('WAITING_APPROVAL','CANCELLED'), ('WAITING_APPROVAL','QUEUED'),
      ('AUTHORIZED','RUNNING'), ('AUTHORIZED','CANCELLED'), ('AUTHORIZED','QUEUED'), ('AUTHORIZED','SKIPPED'),
      ('RUNNING','SUCCEEDED'), ('RUNNING','FAILED'), ('RUNNING','CANCELLED'), ('RUNNING','QUEUED'),
      ('FAILED','QUEUED'));
    IF NOT legal THEN
      RAISE EXCEPTION 'run_steps: illegal status transition % -> %', OLD.status, NEW.status;
    END IF;
    IF OLD.status = 'FAILED' AND NEW.attempts >= NEW.max_attempts THEN
      RAISE EXCEPTION 'run_steps: no attempts left';
    END IF;
    IF NEW.status = 'SUCCEEDED' AND (NEW.output_ref IS NULL AND NEW.output IS NULL) THEN
      RAISE EXCEPTION 'run_steps: a succeeded step records its output';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER run_steps_guard BEFORE INSERT OR UPDATE ON "run_steps" FOR EACH ROW EXECUTE FUNCTION p1d_run_steps_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION p1d_run_approvals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  legal boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.decided_by IS NOT NULL OR NEW.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'run_approvals: a request is created PENDING';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.run_id <> OLD.run_id OR NEW.step_id <> OLD.step_id OR NEW.project_id <> OLD.project_id
     OR NEW.user_id <> OLD.user_id OR NEW.action_hash <> OLD.action_hash OR NEW.action <> OLD.action
     OR NEW.reason <> OLD.reason OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'run_approvals: what was asked is immutable';
  END IF;
  IF OLD.status IN ('REJECTED','EXPIRED','CONSUMED') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'run_approvals: a settled approval is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status THEN
    legal := (OLD.status, NEW.status) IN (('PENDING','APPROVED'), ('PENDING','REJECTED'), ('PENDING','EXPIRED'), ('APPROVED','CONSUMED'), ('APPROVED','EXPIRED'));
    IF NOT legal THEN
      RAISE EXCEPTION 'run_approvals: illegal status transition % -> %', OLD.status, NEW.status;
    END IF;
    IF NEW.status IN ('APPROVED','REJECTED') AND (NEW.decided_by IS NULL OR NEW.decided_at IS NULL) THEN
      RAISE EXCEPTION 'run_approvals: a decision records who and when';
    END IF;
    IF NEW.status = 'APPROVED' AND OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'run_approvals: the request has expired';
    END IF;
    IF NEW.status = 'CONSUMED' AND NEW.consumed_at IS NULL THEN
      RAISE EXCEPTION 'run_approvals: consumption records when';
    END IF;
  ELSIF OLD.decided_by IS DISTINCT FROM NEW.decided_by OR OLD.decided_at IS DISTINCT FROM NEW.decided_at THEN
    RAISE EXCEPTION 'run_approvals: a decision changes the status';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER run_approvals_guard BEFORE INSERT OR UPDATE ON "run_approvals" FOR EACH ROW EXECUTE FUNCTION p1d_run_approvals_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION p1d_insert_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE TRIGGER run_events_insert_only BEFORE UPDATE ON "run_events" FOR EACH ROW EXECUTE FUNCTION p1d_insert_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION p1d_no_direct_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are part of the execution record and cannot be deleted', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE TRIGGER research_runs_no_delete BEFORE DELETE ON "research_runs" FOR EACH ROW EXECUTE FUNCTION p1d_no_direct_delete();--> statement-breakpoint
CREATE TRIGGER run_steps_no_delete BEFORE DELETE ON "run_steps" FOR EACH ROW EXECUTE FUNCTION p1d_no_direct_delete();--> statement-breakpoint
CREATE TRIGGER run_approvals_no_delete BEFORE DELETE ON "run_approvals" FOR EACH ROW EXECUTE FUNCTION p1d_no_direct_delete();--> statement-breakpoint
CREATE TRIGGER run_events_no_delete BEFORE DELETE ON "run_events" FOR EACH ROW EXECUTE FUNCTION p1d_no_direct_delete();--> statement-breakpoint

CREATE OR REPLACE FUNCTION p1d_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is part of the execution record and cannot be truncated', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE TRIGGER research_runs_no_truncate BEFORE TRUNCATE ON "research_runs" FOR EACH STATEMENT EXECUTE FUNCTION p1d_no_truncate();--> statement-breakpoint
CREATE TRIGGER run_steps_no_truncate BEFORE TRUNCATE ON "run_steps" FOR EACH STATEMENT EXECUTE FUNCTION p1d_no_truncate();--> statement-breakpoint
CREATE TRIGGER run_approvals_no_truncate BEFORE TRUNCATE ON "run_approvals" FOR EACH STATEMENT EXECUTE FUNCTION p1d_no_truncate();--> statement-breakpoint
CREATE TRIGGER run_events_no_truncate BEFORE TRUNCATE ON "run_events" FOR EACH STATEMENT EXECUTE FUNCTION p1d_no_truncate();
