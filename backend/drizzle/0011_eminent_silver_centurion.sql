CREATE TABLE "code_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"bot_id" integer NOT NULL,
	"conversation_id" integer NOT NULL,
	"entry_id" integer NOT NULL,
	"source_sha256" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"continuation" jsonb,
	"interruption_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"host_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" jsonb,
	"invocations" integer DEFAULT 0 NOT NULL,
	"bridge_requests" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"result_bytes" integer,
	"error_type" text,
	"lease_owner" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "approvals_entry_idx";--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "code_mode_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "code_limits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "code_continuation_key" jsonb;--> statement-breakpoint
ALTER TABLE "code_runs" ADD CONSTRAINT "code_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_runs" ADD CONSTRAINT "code_runs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_runs" ADD CONSTRAINT "code_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "code_runs_entry_idx" ON "code_runs" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "code_runs_conversation_idx" ON "code_runs" USING btree ("conversation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_interruption_idx" ON "approvals" USING btree ("code_run_id","interruption_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_entry_idx" ON "approvals" USING btree ("entry_id") WHERE "approvals"."interruption_id" is null;