ALTER TABLE "ai_conversations" DROP CONSTRAINT "ai_conversations_project_id_research_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE set null ON UPDATE no action;