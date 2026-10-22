ALTER TABLE "agent_sessions" ADD COLUMN "parent_agent_session_id" integer;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "dispatch_mode" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "review_round" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "manager" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_parent_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("parent_agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_parent_idx" ON "agent_sessions" USING btree ("parent_agent_session_id");