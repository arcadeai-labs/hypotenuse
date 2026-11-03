CREATE TABLE "schedule_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"schedule_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"bot_id" integer NOT NULL,
	"slot" timestamp with time zone NOT NULL,
	"trigger" text DEFAULT 'cron' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"conversation_id" integer,
	"inbox_id" integer,
	"guard" jsonb,
	"cost_usd" numeric(14, 6),
	"triggered_by_user_id" integer,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"bot_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"kind" text DEFAULT 'instruction' NOT NULL,
	"target_type" text NOT NULL,
	"channel_id" integer,
	"conversation_id" integer,
	"cron" text NOT NULL,
	"time_zone" text NOT NULL,
	"instruction" text DEFAULT '' NOT NULL,
	"guard" text,
	"catch_up" text DEFAULT 'latest' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"proposed_by_bot" boolean DEFAULT false NOT NULL,
	"proposed_in_conversation_id" integer,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_runs_schedule_slot_idx" ON "schedule_runs" USING btree ("schedule_id","slot");--> statement-breakpoint
CREATE INDEX "schedule_runs_conversation_idx" ON "schedule_runs" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "schedule_runs_open_idx" ON "schedule_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "schedules_bot_idx" ON "schedules" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("next_run_at") WHERE "schedules"."enabled";