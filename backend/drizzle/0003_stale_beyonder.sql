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
	"external_activity_id" text,
	"external_source_comment_id" text,
	"external_user_id" text,
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
	"type" text NOT NULL,
	"integration_id" integer NOT NULL,
	"external_session_id" text NOT NULL,
	"external_url" text,
	"external_issue_id" text NOT NULL,
	"issue_identifier" text,
	"issue_title" text,
	"issue_url" text,
	"external_team_id" text,
	"team_key" text,
	"external_comment_id" text,
	"external_source_comment_id" text,
	"creator_external_user_id" text,
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
CREATE TABLE "integrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"type" text NOT NULL,
	"external_workspace_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"workspace_url_key" text NOT NULL,
	"external_app_user_id" text NOT NULL,
	"app_user_name" text NOT NULL,
	"details" jsonb NOT NULL,
	"oauth_client_id" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"access_token_encrypted" jsonb,
	"refresh_token_encrypted" jsonb,
	"access_token_last_four" text DEFAULT '' NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"refresh_failed_at" timestamp with time zone,
	"refresh_error" text,
	"status" text DEFAULT 'active' NOT NULL,
	"connected_by_user_id" integer,
	"rate_limit" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"delivery_id" text NOT NULL,
	"integration_id" integer,
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
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD CONSTRAINT "trigger_events_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_activities_session_seq_idx" ON "agent_activities" USING btree ("agent_session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_activities_client_id_idx" ON "agent_activities" USING btree ("client_activity_id");--> statement-breakpoint
CREATE INDEX "agent_activities_pending_idx" ON "agent_activities" USING btree ("next_attempt_at") WHERE "agent_activities"."delivery_status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_external_session_idx" ON "agent_sessions" USING btree ("type","external_session_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_project_status_idx" ON "agent_sessions" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "agent_sessions_issue_idx" ON "agent_sessions" USING btree ("type","external_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_project_type_idx" ON "integrations" USING btree ("project_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_workspace_live" ON "integrations" USING btree ("type","external_workspace_id") WHERE "integrations"."status" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_events_delivery_idx" ON "trigger_events" USING btree ("type","delivery_id");--> statement-breakpoint
CREATE INDEX "trigger_events_unprocessed_idx" ON "trigger_events" USING btree ("processed_at") WHERE "trigger_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "trigger_events_received_idx" ON "trigger_events" USING btree ("received_at");--> statement-breakpoint
-- Carry any connected Linear workspace over from `linear_installations`, keeping
-- ids so nothing that points at the row changes meaning. Linear's own columns
-- move into `details`.
INSERT INTO "integrations" ("id", "project_id", "type", "external_workspace_id", "workspace_name", "workspace_url_key", "external_app_user_id", "app_user_name", "details", "oauth_client_id", "scopes", "access_token_encrypted", "refresh_token_encrypted", "access_token_last_four", "access_token_expires_at", "connected_at", "last_refreshed_at", "refresh_failed_at", "refresh_error", "status", "connected_by_user_id", "rate_limit", "created_at", "updated_at")
SELECT "id", "project_id", 'linear', "organization_id", "organization_name", "url_key", "app_user_id", "app_user_name", jsonb_build_object('appUserCapabilities', "app_user_capabilities", 'teamIds', "team_ids", 'canAccessAllPublicTeams', "can_access_all_public_teams"), "oauth_client_id", "scopes", "access_token_encrypted", "refresh_token_encrypted", "access_token_last_four", "access_token_expires_at", "connected_at", "last_refreshed_at", "refresh_failed_at", "refresh_error", "status", "installed_by_user_id", "rate_limit", "created_at", "updated_at"
FROM "linear_installations";
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('integrations', 'id'), GREATEST((SELECT COALESCE(MAX("id"), 0) FROM "integrations"), 1), (SELECT COUNT(*) > 0 FROM "integrations"));
