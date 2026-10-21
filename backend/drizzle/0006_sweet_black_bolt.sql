CREATE TABLE "external_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"integration_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"external_user_id" text NOT NULL,
	"external_name" text,
	"external_email" text,
	"linked_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"match" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"role" text NOT NULL,
	"repository" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"agent_session_id" integer NOT NULL,
	"kind" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"repository" text,
	"repository_resolved" boolean DEFAULT false NOT NULL,
	"prompt" jsonb,
	"preferred_user_id" integer,
	"sticky_runner_id" integer,
	"offered_to_runner_id" integer,
	"offer_expires_at" timestamp with time zone,
	"lapsed_offers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runner_id" integer,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"agent_id" text,
	"fresh" boolean,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"waiting_reason" text,
	"cancel_requested_at" timestamp with time zone,
	"cancel_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_event_seq" integer DEFAULT 0 NOT NULL,
	"answered_at" timestamp with time zone,
	"daemon_state" text,
	"usage" jsonb,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "instruction" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "issue_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "pending_repository_choice" jsonb;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "routing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_sticky_runner_id_runners_id_fk" FOREIGN KEY ("sticky_runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_offered_to_runner_id_runners_id_fk" FOREIGN KEY ("offered_to_runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_external_user_idx" ON "external_identities" USING btree ("integration_id","external_user_id");--> statement-breakpoint
CREATE INDEX "external_identities_user_idx" ON "external_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "routing_rules_project_position_idx" ON "routing_rules" USING btree ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_one_active_idx" ON "work_items" USING btree ("agent_session_id") WHERE "work_items"."status" IN ('offered', 'claimed', 'running');--> statement-breakpoint
CREATE INDEX "work_items_status_idx" ON "work_items" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "work_items_session_idx" ON "work_items" USING btree ("agent_session_id","id");--> statement-breakpoint
CREATE INDEX "work_items_offered_runner_idx" ON "work_items" USING btree ("offered_to_runner_id") WHERE "work_items"."status" = 'offered';--> statement-breakpoint
CREATE INDEX "work_items_held_runner_idx" ON "work_items" USING btree ("runner_id") WHERE "work_items"."status" IN ('claimed', 'running');--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;