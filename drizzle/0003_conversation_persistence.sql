ALTER TABLE "ai_conversations" ADD COLUMN "last_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "parent_message_id" text;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ai_conversations_recent_idx" ON "ai_conversations" USING btree ("user_id","last_message_at");--> statement-breakpoint
CREATE INDEX "ai_messages_parent_idx" ON "ai_messages" USING btree ("parent_message_id");--> statement-breakpoint
CREATE INDEX "ai_messages_active_idx" ON "ai_messages" USING btree ("conversation_id","is_active","created_at");