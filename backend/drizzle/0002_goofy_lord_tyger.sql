CREATE TABLE "linear_installations" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"organization_id" text NOT NULL,
	"organization_name" text NOT NULL,
	"url_key" text NOT NULL,
	"app_user_id" text NOT NULL,
	"app_user_name" text NOT NULL,
	"app_user_capabilities" jsonb NOT NULL,
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
	"can_access_all_public_teams" boolean DEFAULT false NOT NULL,
	"team_ids" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"installed_by_user_id" integer,
	"rate_limit" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linear_installations" ADD CONSTRAINT "linear_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_installations" ADD CONSTRAINT "linear_installations_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linear_installations_project_idx" ON "linear_installations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_installations_org_live" ON "linear_installations" USING btree ("organization_id") WHERE "linear_installations"."status" <> 'revoked';