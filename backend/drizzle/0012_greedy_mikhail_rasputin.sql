CREATE TABLE "bot_installations" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"bot_id" integer NOT NULL,
	"type" text NOT NULL,
	"external_workspace_id" text NOT NULL,
	"external_app_id" text,
	"external_bot_user_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials" jsonb,
	"credential_version" integer DEFAULT 0 NOT NULL,
	"routing_key_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"installed_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_bindings" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"bot_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"mode" text DEFAULT 'mentions' NOT NULL,
	"default_delivery" text DEFAULT 'steer' NOT NULL,
	"approval_policy" text DEFAULT 'dashboard' NOT NULL,
	"approver_external_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allow_promotion" boolean DEFAULT false NOT NULL,
	"allow_shared" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auto_bound" boolean DEFAULT false NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "help_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"bot_id" integer NOT NULL,
	"conversation_id" integer NOT NULL,
	"entry_id" integer NOT NULL,
	"question" text NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"blocking" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" text,
	"answered_by_user_id" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"type" text NOT NULL,
	"external_workspace_id" text NOT NULL,
	"external_user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer,
	"type" text NOT NULL,
	"bot_installation_id" integer NOT NULL,
	"external_event_id" text NOT NULL,
	"message_key" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"check_after" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "conversations_channel_external_idx";--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "auto_bind" jsonb DEFAULT '{"public":true,"private":false,"dm":false}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "participant_rate_limit" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "channel_rate_limit" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "bot_installation_id" integer;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "parent_external_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "is_shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN "bot_installation_id" integer;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN "supersedes_key" text;--> statement-breakpoint
ALTER TABLE "bot_installations" ADD CONSTRAINT "bot_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_installations" ADD CONSTRAINT "bot_installations_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_installations" ADD CONSTRAINT "bot_installations_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_answered_by_user_id_users_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_installations_routing_idx" ON "bot_installations" USING btree ("routing_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_installations_bot_workspace_idx" ON "bot_installations" USING btree ("bot_id","type","external_workspace_id");--> statement-breakpoint
CREATE INDEX "bot_installations_project_idx" ON "bot_installations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_bindings_bot_channel_idx" ON "channel_bindings" USING btree ("bot_id","channel_id");--> statement-breakpoint
CREATE INDEX "channel_bindings_project_idx" ON "channel_bindings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "help_requests_project_status_idx" ON "help_requests" USING btree ("project_id","status","id");--> statement-breakpoint
CREATE INDEX "help_requests_conversation_idx" ON "help_requests" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_external_idx" ON "participants" USING btree ("project_id","type","external_workspace_id","external_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_events_external_idx" ON "trigger_events" USING btree ("type","bot_installation_id","external_event_id");--> statement-breakpoint
CREATE INDEX "trigger_events_pending_idx" ON "trigger_events" USING btree ("status","check_after");--> statement-breakpoint
CREATE INDEX "trigger_events_project_idx" ON "trigger_events" USING btree ("project_id","id");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_bot_installation_id_bot_installations_id_fk" FOREIGN KEY ("bot_installation_id") REFERENCES "public"."bot_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_bot_installation_id_bot_installations_id_fk" FOREIGN KEY ("bot_installation_id") REFERENCES "public"."bot_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_bot_channel_external_idx" ON "conversations" USING btree ("bot_id","channel_id","external_conversation_key");