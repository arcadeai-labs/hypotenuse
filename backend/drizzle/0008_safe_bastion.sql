CREATE TABLE "approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"bot_id" integer NOT NULL,
	"conversation_id" integer NOT NULL,
	"entry_id" integer,
	"step_id" text,
	"tool_call_id" text,
	"code_run_id" integer,
	"interruption_id" text,
	"call_key" text NOT NULL,
	"server" text NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"reason" text DEFAULT 'not-allowlisted' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" integer,
	"requested_by_participant_id" integer,
	"decided_by_user_id" integer,
	"decided_by_participant_id" integer,
	"decided_via" text,
	"note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"executing_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_mcp_servers" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"mcp_server_id" integer NOT NULL,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_allow_read_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "large_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"conversation_id" integer NOT NULL,
	"entry_id" integer,
	"mime_type" text DEFAULT 'application/json' NOT NULL,
	"content" text NOT NULL,
	"total_chars" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(64) NOT NULL,
	"url" text NOT NULL,
	"transport" text DEFAULT 'streamable-http' NOT NULL,
	"auth_mode" text NOT NULL,
	"credentials" jsonb,
	"header_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_four" varchar(4),
	"oauth_client" jsonb,
	"oauth_tokens" jsonb,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"timeout_ms" integer,
	"status" text DEFAULT 'ok' NOT NULL,
	"last_error" text,
	"tools_cache" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_refreshed_at" timestamp with time zone,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "approver_tag" varchar(256);--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "approval_ttl_seconds" integer DEFAULT 86400 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "capabilities" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "capabilities_hash" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_mcp_servers" ADD CONSTRAINT "bot_mcp_servers_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_mcp_servers" ADD CONSTRAINT "bot_mcp_servers_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "large_results" ADD CONSTRAINT "large_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "large_results" ADD CONSTRAINT "large_results_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_entry_idx" ON "approvals" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "approvals_project_status_idx" ON "approvals" USING btree ("project_id","status","id");--> statement-breakpoint
CREATE INDEX "approvals_conversation_idx" ON "approvals" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "approvals_pending_expiry_idx" ON "approvals" USING btree ("expires_at") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "bot_mcp_servers_bot_server_idx" ON "bot_mcp_servers" USING btree ("bot_id","mcp_server_id");--> statement-breakpoint
CREATE INDEX "large_results_conversation_idx" ON "large_results" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_project_name_idx" ON "mcp_servers" USING btree ("project_id","name");