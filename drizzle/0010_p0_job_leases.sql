ALTER TABLE "analysis_jobs" ADD COLUMN "lease_owner" varchar(128);--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "lease_owner" varchar(128);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "analysis_jobs_lease_idx" ON "analysis_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "tasks_lease_idx" ON "tasks" USING btree ("status","lease_expires_at");