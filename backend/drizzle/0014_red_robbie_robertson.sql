CREATE TABLE "telemetry_exporters" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"endpoint" text NOT NULL,
	"protocol" text DEFAULT 'http/protobuf' NOT NULL,
	"headers_encrypted" jsonb,
	"header_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signals" jsonb DEFAULT '["traces","metrics","logs"]'::jsonb NOT NULL,
	"content" text DEFAULT 'metadata' NOT NULL,
	"agent_native" boolean DEFAULT true NOT NULL,
	"trace_sample_ratio" real DEFAULT 1 NOT NULL,
	"resource_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_export_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "telemetry" jsonb;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "traceparent" text;--> statement-breakpoint
UPDATE "work_items" SET "traceparent" = '00-' || md5(random()::text || "id"::text) || '-' || substr(md5(random()::text), 1, 16) || '-00';--> statement-breakpoint
ALTER TABLE "work_items" ALTER COLUMN "traceparent" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "telemetry" jsonb;--> statement-breakpoint
ALTER TABLE "telemetry_exporters" ADD CONSTRAINT "telemetry_exporters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telemetry_exporters_project_idx" ON "telemetry_exporters" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_exporters_project_name_idx" ON "telemetry_exporters" USING btree ("project_id","name");