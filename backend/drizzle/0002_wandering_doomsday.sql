ALTER TABLE "audit_logs" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "actor_type" text NOT NULL DEFAULT 'user';--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "participant_id" integer;--> statement-breakpoint
-- Rows written before these columns existed. Every one was a person's
-- decision except the sign-up bootstrap's synthetic rows, which become
-- `system` rows naming the owner they were made for in their metadata; the
-- sign-up row itself, written while its caller was anonymous, gains the
-- account it created as its actor.
UPDATE "audit_logs" SET "actor_type" = 'system', "metadata" = "metadata" || jsonb_build_object('ownerUserId', "user_id"), "user_id" = NULL WHERE "metadata" ? 'bootstrappedBy';--> statement-breakpoint
UPDATE "audit_logs" SET "user_id" = "users"."id" FROM "users" WHERE "audit_logs"."action" = 'user:create' AND "audit_logs"."user_id" IS NULL AND "users"."email" = "audit_logs"."target_path";--> statement-breakpoint
UPDATE "audit_logs" SET "organization_id" = ("metadata"->>'organizationId')::integer WHERE "metadata" ? 'organizationId' AND jsonb_typeof("metadata"->'organizationId') = 'number';--> statement-breakpoint
UPDATE "audit_logs" SET "organization_id" = "projects"."organization_id" FROM "projects" WHERE "audit_logs"."organization_id" IS NULL AND "projects"."id" = "audit_logs"."project_id";--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "actor_type" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "audit_logs_organization_created_at_idx" ON "audit_logs" USING btree ("organization_id","created_at");
