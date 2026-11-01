CREATE TABLE "sandbox_job_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"tool_name" text,
	"text" text,
	"payload" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_job_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"source" text NOT NULL,
	"delivery" text NOT NULL,
	"body" text NOT NULL,
	"delivery_key" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_job_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"kind" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb,
	"blocking" boolean DEFAULT true NOT NULL,
	"urgency" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" text,
	"answered_by" jsonb,
	"help_request_id" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sandbox_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"bot_id" integer NOT NULL,
	"parent_conversation_id" integer NOT NULL,
	"intent_entry_id" integer,
	"triggered_by_participant_id" integer,
	"triggered_by_user_id" integer,
	"title" text NOT NULL,
	"task" text NOT NULL,
	"briefing" text,
	"repository" jsonb,
	"interactive" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"provider" text,
	"reported_status" text,
	"status_message" text,
	"closing_text" text,
	"artifacts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"token_hash" text,
	"cli_session_id" text,
	"exit_code" integer,
	"end_reason" text,
	"error" text,
	"usage" jsonb DEFAULT '{"inputTokens":0,"outputTokens":0,"requests":0}'::jsonb NOT NULL,
	"cli_usage" jsonb,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"budget_tokens" integer,
	"max_duration_ms" integer NOT NULL,
	"idle_timeout_ms" integer NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"awaiting_input_since" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"job_id" integer,
	"provider" text NOT NULL,
	"external_id" text,
	"status" text NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"destroyed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "help_requests" ALTER COLUMN "entry_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "sandbox_policy" text DEFAULT 'approve' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "sandbox_job_token_budget" integer;--> statement-breakpoint
ALTER TABLE "help_requests" ADD COLUMN "sandbox_question_id" integer;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "sandbox_provider" text;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "sandbox_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "sandbox_concurrency" integer;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "sandbox_max_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "sandbox_job_events" ADD CONSTRAINT "sandbox_job_events_job_id_sandbox_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."sandbox_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_job_messages" ADD CONSTRAINT "sandbox_job_messages_job_id_sandbox_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."sandbox_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_job_questions" ADD CONSTRAINT "sandbox_job_questions_job_id_sandbox_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."sandbox_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_jobs" ADD CONSTRAINT "sandbox_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_jobs" ADD CONSTRAINT "sandbox_jobs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_jobs" ADD CONSTRAINT "sandbox_jobs_parent_conversation_id_conversations_id_fk" FOREIGN KEY ("parent_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_job_events_job_seq_idx" ON "sandbox_job_events" USING btree ("job_id","seq");--> statement-breakpoint
CREATE INDEX "sandbox_job_events_job_idx" ON "sandbox_job_events" USING btree ("job_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_job_messages_key_idx" ON "sandbox_job_messages" USING btree ("delivery_key");--> statement-breakpoint
CREATE INDEX "sandbox_job_messages_job_idx" ON "sandbox_job_messages" USING btree ("job_id","id");--> statement-breakpoint
CREATE INDEX "sandbox_job_questions_job_idx" ON "sandbox_job_questions" USING btree ("job_id","id");--> statement-breakpoint
CREATE INDEX "sandbox_jobs_status_project_idx" ON "sandbox_jobs" USING btree ("status","project_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_jobs_parent_idx" ON "sandbox_jobs" USING btree ("parent_conversation_id");--> statement-breakpoint
CREATE INDEX "sandbox_jobs_project_created_idx" ON "sandbox_jobs" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "sandbox_jobs_token_idx" ON "sandbox_jobs" USING btree ("token_hash") WHERE "sandbox_jobs"."token_hash" is not null;--> statement-breakpoint
CREATE INDEX "sandboxes_status_created_idx" ON "sandboxes" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "sandboxes_external_id_idx" ON "sandboxes" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "sandboxes_job_idx" ON "sandboxes" USING btree ("job_id") WHERE "sandboxes"."job_id" is not null;