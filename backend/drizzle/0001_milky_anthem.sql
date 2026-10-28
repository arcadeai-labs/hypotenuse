CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"project_id" integer,
	"action" text NOT NULL,
	"target_type" text,
	"target_path" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"channel" text NOT NULL,
	"template" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"read_at" timestamp with time zone,
	"link_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(256) NOT NULL,
	"slug" varchar(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "project_invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"project_id" integer,
	"inviter_user_id" integer NOT NULL,
	"invitee_email" text NOT NULL,
	"tag_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"inviter_email" text NOT NULL,
	"organization_name" text NOT NULL,
	"project_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" varchar(256) NOT NULL,
	"slug" varchar(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(256) NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invites" ADD CONSTRAINT "project_invites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invites" ADD CONSTRAINT "project_invites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invites" ADD CONSTRAINT "project_invites_inviter_user_id_users_id_fk" FOREIGN KEY ("inviter_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_settings" ADD CONSTRAINT "project_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tags" ADD CONSTRAINT "user_tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tags" ADD CONSTRAINT "user_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_project_created_at_idx" ON "audit_logs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_dispatch_idx" ON "notifications" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id","channel","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_membership_org_user_idx" ON "organization_memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "organization_membership_user_idx" ON "organization_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invite_invitee_email_idx" ON "project_invites" USING btree ("invitee_email");--> statement-breakpoint
CREATE INDEX "invite_organization_idx" ON "project_invites" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invite_project_idx" ON "project_invites" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_project_user_idx" ON "project_memberships" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_settings_project_idx" ON "project_settings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_organization_idx" ON "projects" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_organization_slug_idx" ON "projects" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_project_normalized_name_idx" ON "tags" USING btree ("project_id",lower(btrim("name")));--> statement-breakpoint
CREATE UNIQUE INDEX "user_tag_user_tag_idx" ON "user_tags" USING btree ("user_id","tag_id");