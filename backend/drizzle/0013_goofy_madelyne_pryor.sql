ALTER TABLE "trigger_events" ADD COLUMN "check_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "cancel_note" text;--> statement-breakpoint
CREATE INDEX "trigger_events_check_idx" ON "trigger_events" USING btree ("check_after") WHERE "trigger_events"."check_after" IS NOT NULL;