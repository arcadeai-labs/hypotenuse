CREATE TABLE "channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"type" text NOT NULL,
	"external_id" text NOT NULL,
	"bot_id" integer,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"epoch" integer NOT NULL,
	"step_id" text,
	"kind" text NOT NULL,
	"role" text,
	"content" jsonb NOT NULL,
	"tool_call_id" text,
	"tool_name" text,
	"replay" text,
	"prompt_hash" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"user_id" integer,
	"participant_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_inbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"delivery_key" text NOT NULL,
	"delivery" text NOT NULL,
	"source" text NOT NULL,
	"user_id" integer,
	"participant_id" integer,
	"text" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"bot_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"external_conversation_key" text,
	"title" text,
	"state" text NOT NULL,
	"waiting_on" jsonb,
	"outcome" text,
	"epoch" integer DEFAULT 0 NOT NULL,
	"wake_requested_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"turn_boundary" boolean DEFAULT true NOT NULL,
	"steps_this_turn" integer DEFAULT 0 NOT NULL,
	"nudged_this_turn" boolean DEFAULT false NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"last_input_tokens" integer,
	"request_id" text,
	"callback_url" text,
	"created_by_user_id" integer,
	"forked_from_conversation_id" integer,
	"forked_from_seq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"bot_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"conversation_id" integer NOT NULL,
	"epoch" integer NOT NULL,
	"step_id" text NOT NULL,
	"model_connection_id" integer,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"conversation_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"external_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "max_steps_per_turn" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "api_callback_secret" jsonb;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_entries" ADD CONSTRAINT "conversation_entries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_entries" ADD CONSTRAINT "conversation_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_inbox" ADD CONSTRAINT "conversation_inbox_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_inbox" ADD CONSTRAINT "conversation_inbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_project_type_external_idx" ON "channels" USING btree ("project_id","type","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_entries_seq_idx" ON "conversation_entries" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "conversation_entries_intent_idx" ON "conversation_entries" USING btree ("conversation_id","kind") WHERE "conversation_entries"."kind" = 'tool_call_intent';--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_inbox_delivery_key_idx" ON "conversation_inbox" USING btree ("conversation_id","delivery_key");--> statement-breakpoint
CREATE INDEX "conversation_inbox_pending_idx" ON "conversation_inbox" USING btree ("conversation_id","delivered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_external_idx" ON "conversations" USING btree ("channel_id","external_conversation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_bot_request_idx" ON "conversations" USING btree ("bot_id","request_id");--> statement-breakpoint
CREATE INDEX "conversations_project_activity_idx" ON "conversations" USING btree ("project_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "conversations_working_idx" ON "conversations" USING btree ("state","wake_requested_at") WHERE "conversations"."state" in ('working', 'waiting');--> statement-breakpoint
CREATE INDEX "cost_records_bot_created_idx" ON "cost_records" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "cost_records_conversation_idx" ON "cost_records" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "outbox_messages_due_idx" ON "outbox_messages" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbox_messages_conversation_idx" ON "outbox_messages" USING btree ("conversation_id");