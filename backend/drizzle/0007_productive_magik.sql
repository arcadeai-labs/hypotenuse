ALTER TABLE "work_items" ADD COLUMN "awaiting_answer_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "answers" jsonb DEFAULT '[]'::jsonb NOT NULL;