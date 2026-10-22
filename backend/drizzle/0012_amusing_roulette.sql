ALTER TABLE "agent_sessions" ADD COLUMN "routing_rule_id" integer;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "routing_rule_name" text;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD COLUMN "agent_session_id" integer;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD COLUMN "work_item_id" integer;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_routing_rule_id_routing_rules_id_fk" FOREIGN KEY ("routing_rule_id") REFERENCES "public"."routing_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD CONSTRAINT "trigger_events_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD CONSTRAINT "trigger_events_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trigger_events_integration_received_idx" ON "trigger_events" USING btree ("integration_id","received_at");