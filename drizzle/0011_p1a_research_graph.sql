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
	"created_by_user_id" text,
	"created_by_run_id" text,
	"origin" varchar(16) DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_versions" (
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
	"node_id" text NOT NULL,
	"cause_node_id" text NOT NULL,
	"cause_version" integer NOT NULL,
	"path" text[] NOT NULL,
	"severity" varchar(16) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" text,
	"resolution" varchar(16),
	CONSTRAINT "stale_marks_node_id_cause_node_id_cause_version_pk" PRIMARY KEY("node_id","cause_node_id","cause_version")
);
--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_src_id_graph_nodes_id_fk" FOREIGN KEY ("src_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_dst_id_graph_nodes_id_fk" FOREIGN KEY ("dst_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_node_id_graph_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stale_marks" ADD CONSTRAINT "stale_marks_node_id_graph_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stale_marks" ADD CONSTRAINT "stale_marks_cause_node_id_graph_nodes_id_fk" FOREIGN KEY ("cause_node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stale_marks" ADD CONSTRAINT "stale_marks_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "graph_edges_unique" ON "graph_edges" USING btree ("src_id","rel","dst_id");--> statement-breakpoint
CREATE INDEX "graph_edges_dst_idx" ON "graph_edges" USING btree ("dst_id");--> statement-breakpoint
CREATE INDEX "graph_edges_project_rel_idx" ON "graph_edges" USING btree ("project_id","rel");--> statement-breakpoint
CREATE INDEX "graph_nodes_project_idx" ON "graph_nodes" USING btree ("project_id","type","status");--> statement-breakpoint
CREATE INDEX "project_members_user_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stale_marks_open_idx" ON "stale_marks" USING btree ("node_id","resolved_at");--> statement-breakpoint
-- Every existing project's creator becomes its OWNER member. Idempotent.
INSERT INTO "project_members" ("project_id", "user_id", "role")
SELECT "id", "user_id", 'OWNER' FROM "research_projects"
ON CONFLICT DO NOTHING;
