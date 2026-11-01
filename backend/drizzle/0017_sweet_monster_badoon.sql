CREATE TABLE "github_installations" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"installation_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attached_by_user_id" integer,
	"suspended_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"github_installation_id" integer NOT NULL,
	"host" text DEFAULT 'github.com' NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"push" boolean DEFAULT false NOT NULL,
	"branch_prefix" text,
	"bot_ids" integer[],
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_job_git_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"repository" text NOT NULL,
	"permission" text,
	"outcome" text NOT NULL,
	"reason" text,
	"token_hash" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_job_pull_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"job_id" integer NOT NULL,
	"conversation_id" integer NOT NULL,
	"host" text DEFAULT 'github.com' NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"head_ref" text,
	"state" text DEFAULT 'open' NOT NULL,
	"relayed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "github_wake_events" text[] DEFAULT '{"changes_requested","check_failed"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_attached_by_user_id_users_id_fk" FOREIGN KEY ("attached_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_grants" ADD CONSTRAINT "repository_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_grants" ADD CONSTRAINT "repository_grants_github_installation_id_github_installations_id_fk" FOREIGN KEY ("github_installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_grants" ADD CONSTRAINT "repository_grants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_job_pull_requests" ADD CONSTRAINT "sandbox_job_pull_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_job_pull_requests" ADD CONSTRAINT "sandbox_job_pull_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_project_installation_idx" ON "github_installations" USING btree ("project_id","installation_id");--> statement-breakpoint
CREATE INDEX "github_installations_installation_idx" ON "github_installations" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_grants_repo_idx" ON "repository_grants" USING btree ("project_id","host","owner","name");--> statement-breakpoint
CREATE INDEX "repository_grants_installation_idx" ON "repository_grants" USING btree ("github_installation_id");--> statement-breakpoint
CREATE INDEX "sandbox_job_git_tokens_job_idx" ON "sandbox_job_git_tokens" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_job_pull_requests_repo_number_idx" ON "sandbox_job_pull_requests" USING btree ("project_id","host","owner","name","number");--> statement-breakpoint
CREATE INDEX "sandbox_job_pull_requests_job_idx" ON "sandbox_job_pull_requests" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "sandbox_job_pull_requests_conversation_idx" ON "sandbox_job_pull_requests" USING btree ("conversation_id");