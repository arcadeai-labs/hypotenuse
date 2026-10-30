CREATE TABLE "bot_skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"skill_id" integer NOT NULL,
	"pinned_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"bot_id" integer NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"review_every_seconds" integer,
	"last_reviewed_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_section_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"section_id" integer NOT NULL,
	"version" integer NOT NULL,
	"title" varchar(120) NOT NULL,
	"body" text NOT NULL,
	"source" text NOT NULL,
	"user_id" integer,
	"conversation_id" integer,
	"entry_id" integer,
	"change_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_sections" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"scope" text NOT NULL,
	"bot_id" integer,
	"key" varchar(64) NOT NULL,
	"title" varchar(120) NOT NULL,
	"loading" text NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_editable" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"origin" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"skill_id" integer NOT NULL,
	"version" integer NOT NULL,
	"description" varchar(280) NOT NULL,
	"arguments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"body" text NOT NULL,
	"user_id" integer,
	"change_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(64) NOT NULL,
	"description" varchar(280) NOT NULL,
	"arguments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"access_read" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_write" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "prompt_budget_tokens" integer DEFAULT 8000 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "max_agent_sections" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_skills" ADD CONSTRAINT "bot_skills_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_skills" ADD CONSTRAINT "bot_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_section_versions" ADD CONSTRAINT "prompt_section_versions_section_id_prompt_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."prompt_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_section_versions" ADD CONSTRAINT "prompt_section_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_sections" ADD CONSTRAINT "prompt_sections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_sections" ADD CONSTRAINT "prompt_sections_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_skills_bot_skill_idx" ON "bot_skills" USING btree ("bot_id","skill_id");--> statement-breakpoint
CREATE INDEX "goals_bot_idx" ON "goals" USING btree ("bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_section_versions_section_version_idx" ON "prompt_section_versions" USING btree ("section_id","version");--> statement-breakpoint
CREATE INDEX "prompt_section_versions_entry_idx" ON "prompt_section_versions" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_sections_owner_key_idx" ON "prompt_sections" USING btree ("project_id",coalesce("bot_id", 0),"key");--> statement-breakpoint
CREATE INDEX "prompt_sections_bot_idx" ON "prompt_sections" USING btree ("bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_version_idx" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_project_name_idx" ON "skills" USING btree ("project_id","name");