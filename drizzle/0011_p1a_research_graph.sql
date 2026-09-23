CREATE TYPE "public"."project_role" AS ENUM('OWNER', 'EDITOR', 'COMMENTER', 'VIEWER');--> statement-breakpoint
CREATE TABLE "graph_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"src_id" text NOT NULL,
	"rel" varchar(40) NOT NULL,
	"dst_id" text NOT NULL,
	"dst_version" integer,
	"dependency" boolean NOT NULL,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_by_run_id" text,
	"origin" varchar(16) DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"type" varchar(40) NOT NULL,
	"label" text,
	"data" jsonb NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"provenance" varchar(16),
	"frozen_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_by_run_id" text,
	"origin" varchar(16) DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Referenced by the composite (project_id, node_id) foreign keys below, so it comes first.
CREATE UNIQUE INDEX "graph_nodes_project_id_unique" ON "graph_nodes" USING btree ("project_id","id");--> statement-breakpoint
CREATE TABLE "node_versions" (
	"project_id" text NOT NULL,
	"node_id" text NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"hash" varchar(64) NOT NULL,
	"change_kind" varchar(16),
	"change_note" text,
	"impact_report_hash" varchar(64),
	"created_by_user_id" text,
	"created_by_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_versions_node_id_version_pk" PRIMARY KEY("node_id","version")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "project_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "stale_marks" (
	"project_id" text NOT NULL,
	"node_id" text NOT NULL,
	"cause_node_id" text NOT NULL,
	"cause_version" integer NOT NULL,
	"kind" varchar(16) DEFAULT 'stale' NOT NULL,
	"node_version" integer NOT NULL,
	"path" text[] NOT NULL,
	"severity" varchar(16) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" text,
	"resolution" varchar(16),
	CONSTRAINT "stale_marks_node_id_cause_node_id_cause_version_kind_pk" PRIMARY KEY("node_id","cause_node_id","cause_version","kind")
);
--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_src_fk" FOREIGN KEY ("project_id","src_id") REFERENCES "public"."graph_nodes"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_dst_fk" FOREIGN KEY ("project_id","dst_id") REFERENCES "public"."graph_nodes"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_node_fk" FOREIGN KEY ("project_id","node_id") REFERENCES "public"."graph_nodes"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stale_marks" ADD CONSTRAINT "stale_marks_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stale_marks" ADD CONSTRAINT "stale_marks_node_fk" FOREIGN KEY ("project_id","node_id") REFERENCES "public"."graph_nodes"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stale_marks" ADD CONSTRAINT "stale_marks_cause_fk" FOREIGN KEY ("project_id","cause_node_id") REFERENCES "public"."graph_nodes"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "graph_edges_unique" ON "graph_edges" USING btree ("src_id","rel","dst_id");--> statement-breakpoint
CREATE INDEX "graph_edges_dst_idx" ON "graph_edges" USING btree ("dst_id");--> statement-breakpoint
CREATE INDEX "graph_edges_project_rel_idx" ON "graph_edges" USING btree ("project_id","rel");--> statement-breakpoint
CREATE INDEX "graph_nodes_project_idx" ON "graph_nodes" USING btree ("project_id","type","status");--> statement-breakpoint
CREATE INDEX "project_members_user_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stale_marks_open_idx" ON "stale_marks" USING btree ("node_id","resolved_at");--> statement-breakpoint
CREATE INDEX "stale_marks_project_idx" ON "stale_marks" USING btree ("project_id","resolved_at");--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_provenance_check" CHECK ("provenance" IS NULL OR "provenance" IN ('computed', 'manual'));--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_status_check" CHECK ("status" IN ('draft', 'active', 'stale', 'superseded', 'archived'));--> statement-breakpoint
ALTER TABLE "stale_marks" ADD CONSTRAINT "stale_marks_severity_check" CHECK ("severity" IN ('info', 'review', 'invalidates'));--> statement-breakpoint
ALTER TABLE "stale_marks" ADD CONSTRAINT "stale_marks_kind_check" CHECK ("kind" IN ('stale', 'untraced', 'stale_input'));--> statement-breakpoint
-- Versions are history: never rewritten, removed only with their node (a cascade runs at trigger depth > 1).
CREATE FUNCTION "node_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'node_versions rows are immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "node_versions_immutable" BEFORE UPDATE OR DELETE ON "node_versions"
  FOR EACH ROW EXECUTE FUNCTION "node_versions_immutable"();--> statement-breakpoint
-- A computed statistical output is what its run produced: its content and its provenance never change.
CREATE FUNCTION "graph_nodes_computed_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."provenance" IS DISTINCT FROM OLD."provenance"
     OR (OLD."provenance" = 'computed'
         AND (NEW."data" IS DISTINCT FROM OLD."data" OR NEW."current_version" <> OLD."current_version")) THEN
    RAISE EXCEPTION 'computed results and node provenance are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "graph_nodes_computed_immutable" BEFORE UPDATE ON "graph_nodes"
  FOR EACH ROW EXECUTE FUNCTION "graph_nodes_computed_immutable"();--> statement-breakpoint
-- Every existing project's creator becomes its OWNER member. Idempotent.
INSERT INTO "project_members" ("project_id", "user_id", "role")
SELECT "id", "user_id", 'OWNER' FROM "research_projects"
ON CONFLICT DO NOTHING;
