CREATE TABLE "agent_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_session_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"direction" text NOT NULL,
	"kind" text DEFAULT 'activity' NOT NULL,
	"content_type" text,
	"content" jsonb NOT NULL,
	"ephemeral" boolean DEFAULT false NOT NULL,
	"signal" text,
	"signal_metadata" jsonb,
	"client_activity_id" uuid NOT NULL,
	"linear_activity_id" text,
	"source_comment_id" text,
	"linear_user_id" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"delivery_status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"installation_id" integer NOT NULL,
	"linear_session_id" text NOT NULL,
	"linear_url" text,
	"linear_issue_id" text NOT NULL,
	"issue_identifier" text,
	"issue_title" text,
	"issue_url" text,
	"team_id" text,
	"team_key" text,
	"linear_comment_id" text,
	"source_comment_id" text,
	"creator_linear_user_id" text,
	"creator_name" text,
	"creator_email" text,
	"origin" text NOT NULL,
	"prompt_context" text,
	"guidance" jsonb,
	"previous_comments" jsonb,
	"role" text,
	"repository" text,
	"runner_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"summary" text,
	"plan" jsonb,
	"external_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delegate_removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "linear_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"installation_id" integer,
	"event_type" text NOT NULL,
	"action" text NOT NULL,
	"webhook_timestamp" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "agent_activities" ADD CONSTRAINT "agent_activities_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_installation_id_linear_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."linear_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_events" ADD CONSTRAINT "linear_events_installation_id_linear_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."linear_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_activities_session_seq_idx" ON "agent_activities" USING btree ("agent_session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_activities_client_id_idx" ON "agent_activities" USING btree ("client_activity_id");--> statement-breakpoint
CREATE INDEX "agent_activities_pending_idx" ON "agent_activities" USING btree ("next_attempt_at") WHERE "agent_activities"."delivery_status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_linear_session_idx" ON "agent_sessions" USING btree ("linear_session_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_project_status_idx" ON "agent_sessions" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "agent_sessions_issue_idx" ON "agent_sessions" USING btree ("linear_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_events_delivery_idx" ON "linear_events" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "linear_events_unprocessed_idx" ON "linear_events" USING btree ("processed_at") WHERE "linear_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "linear_events_received_idx" ON "linear_events" USING btree ("received_at");