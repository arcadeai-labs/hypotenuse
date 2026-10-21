CREATE TABLE "runner_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"runner_id" integer NOT NULL,
	"type" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_last_four" text NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"last_connected_at" timestamp with time zone,
	"protocol_version" integer,
	"daemon_version" text,
	"platform" text,
	"hostname" text,
	"machine_id" text,
	"limits" jsonb,
	"active_count" integer DEFAULT 0 NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repositories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capability_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
ALTER TABLE "runner_subscriptions" ADD CONSTRAINT "runner_subscriptions_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_subscriptions_unique_idx" ON "runner_subscriptions" USING btree ("runner_id","type","kind","value");--> statement-breakpoint
CREATE INDEX "runner_subscriptions_value_idx" ON "runner_subscriptions" USING btree ("type","kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "runners_token_hash_idx" ON "runners" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "runners_project_name_idx" ON "runners" USING btree ("project_id","name") WHERE "runners"."status" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "runners_live_machine_idx" ON "runners" USING btree ("machine_id") WHERE "runners"."status" IN ('online', 'draining');--> statement-breakpoint
CREATE INDEX "runners_project_user_idx" ON "runners" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "runners_status_heartbeat_idx" ON "runners" USING btree ("status","last_heartbeat_at");