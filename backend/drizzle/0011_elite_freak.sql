ALTER TABLE "work_items" ADD COLUMN "waiting_code" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "cancelled_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;