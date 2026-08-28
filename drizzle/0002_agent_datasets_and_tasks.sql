CREATE TABLE "agent_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text,
	"project_id" text,
	"kind" varchar(64) NOT NULL,
	"intent" varchar(64),
	"status" varchar(16) DEFAULT 'RUNNING' NOT NULL,
	"period_key" varchar(7) NOT NULL,
	"declared_units" integer DEFAULT 0 NOT NULL,
	"charged_units" integer DEFAULT 0 NOT NULL,
	"stages_planned" integer DEFAULT 0 NOT NULL,
	"stages_completed" integer DEFAULT 0 NOT NULL,
	"ai_request_count" integer DEFAULT 0 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"generated_words" integer DEFAULT 0 NOT NULL,
	"dataset_rows" integer,
	"duration_ms" integer,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"dataset_id" text NOT NULL,
	"project_id" text,
	"section_key" varchar(64),
	"conversation_id" text,
	"test_key" varchar(64) NOT NULL,
	"spec" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"conversation_id" text,
	"kind" varchar(16) DEFAULT 'ORIGINAL' NOT NULL,
	"parent_dataset_id" text,
	"original_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" varchar(128),
	"byte_size" integer DEFAULT 0 NOT NULL,
	"checksum" varchar(64),
	"row_count" integer DEFAULT 0 NOT NULL,
	"column_count" integer DEFAULT 0 NOT NULL,
	"truncated_to" integer,
	"profile" jsonb,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "mode" varchar(32);--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "max_ai_tasks" integer;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_parent_dataset_id_datasets_id_fk" FOREIGN KEY ("parent_dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_tasks_user_period_idx" ON "agent_tasks" USING btree ("user_id","period_key");--> statement-breakpoint
CREATE INDEX "agent_tasks_started_idx" ON "agent_tasks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_conversation_idx" ON "agent_tasks" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "analysis_runs_user_idx" ON "analysis_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "analysis_runs_dataset_idx" ON "analysis_runs" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "analysis_runs_project_idx" ON "analysis_runs" USING btree ("project_id","section_key");--> statement-breakpoint
CREATE INDEX "datasets_user_idx" ON "datasets" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "datasets_project_idx" ON "datasets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "datasets_parent_idx" ON "datasets" USING btree ("parent_dataset_id");