CREATE TABLE "bots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(80) NOT NULL,
	"slug" varchar(64) NOT NULL,
	"description" varchar(280) DEFAULT '' NOT NULL,
	"display_name" varchar(80) NOT NULL,
	"avatar" "bytea",
	"avatar_mime_type" text,
	"persona" text NOT NULL,
	"model_alias" varchar(64) DEFAULT 'default' NOT NULL,
	"fast_model_alias" varchar(64) DEFAULT 'fast' NOT NULL,
	"access_read" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_write" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"help_notify_tag" varchar(256),
	"monthly_budget_usd" numeric(10, 2),
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(64) NOT NULL,
	"kind" text DEFAULT 'language' NOT NULL,
	"connection_id" integer NOT NULL,
	"model_id" varchar(256) NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(80) NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"secret" jsonb NOT NULL,
	"last_four" varchar(4) NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_connection_id_model_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."model_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bots_project_slug_idx" ON "bots" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "model_aliases_project_name_idx" ON "model_aliases" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "model_aliases_connection_idx" ON "model_aliases" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_connections_project_name_idx" ON "model_connections" USING btree ("project_id","name");