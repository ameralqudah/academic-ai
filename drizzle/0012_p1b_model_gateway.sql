CREATE TABLE "ai_quota_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"period_key" varchar(7) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"words" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"call_id" text NOT NULL,
	"tool_call_id" varchar(200) NOT NULL,
	"tool_name" varchar(64) NOT NULL,
	"arguments" jsonb,
	"raw_arguments" text,
	"status" varchar(16) NOT NULL,
	"error" text,
	"result_summary" jsonb,
	"latency_ms" integer,
	"provider" varchar(16) NOT NULL,
	"model" varchar(100) NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"run_id" text,
	"task_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"call_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"task_id" text,
	"job_id" text,
	"run_id" text,
	"purpose" varchar(64) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"provider" varchar(16) NOT NULL,
	"model" varchar(100) NOT NULL,
	"model_class" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"error_class" varchar(32),
	"finish_reason" varchar(32),
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"usage_estimated" boolean DEFAULT false NOT NULL,
	"cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"routing" jsonb,
	"reservation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_quota_reservations" ADD CONSTRAINT "ai_quota_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_quota_reservations_key" ON "ai_quota_reservations" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ai_quota_reservations_open_idx" ON "ai_quota_reservations" USING btree ("user_id","period_key","status");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_call_idx" ON "ai_tool_calls" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_user_idx" ON "ai_tool_calls" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_events_user_idx" ON "ai_usage_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_events_call_idx" ON "ai_usage_events" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "ai_usage_events_project_idx" ON "ai_usage_events" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_status_check" CHECK ("status" IN ('succeeded', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "ai_quota_reservations" ADD CONSTRAINT "ai_quota_reservations_status_check" CHECK ("status" IN ('reserved', 'committed', 'released'));--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_status_check" CHECK ("status" IN ('validated', 'rejected', 'succeeded', 'failed'));
