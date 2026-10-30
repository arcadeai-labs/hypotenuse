CREATE TABLE "memory_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"breadcrumb" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"search_text" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED NOT NULL,
	"embedding" vector(1536),
	"embedding_revision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"scope" text NOT NULL,
	"bot_id" integer,
	"channel_id" integer,
	"logical_path" text NOT NULL,
	"version_id" timestamp (3) with time zone NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"tombstone" boolean DEFAULT false NOT NULL,
	"content" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"change_note" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" jsonb NOT NULL,
	"author_user_id" integer,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "memory_channel_half_life_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "memory_project_half_life_days" integer DEFAULT 180 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "memory_consolidated_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_document_id_memory_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."memory_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_chunks_document_idx" ON "memory_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "memory_chunks_project_revision_idx" ON "memory_chunks" USING btree ("project_id","embedding_revision");--> statement-breakpoint
CREATE INDEX "memory_chunks_tsv_idx" ON "memory_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "memory_chunks_embedding_idx" ON "memory_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "memory_documents_version_idx" ON "memory_documents" USING btree ("project_id","scope",coalesce("bot_id", 0),coalesce("channel_id", 0),"logical_path","version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_documents_current_idx" ON "memory_documents" USING btree ("project_id","scope",coalesce("bot_id", 0),coalesce("channel_id", 0),"logical_path") WHERE "memory_documents"."is_current";--> statement-breakpoint
CREATE INDEX "memory_documents_channel_idx" ON "memory_documents" USING btree ("bot_id","channel_id");