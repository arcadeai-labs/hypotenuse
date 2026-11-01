ALTER TABLE "memory_documents" DROP CONSTRAINT "memory_documents_bot_id_bots_id_fk";
--> statement-breakpoint
DROP INDEX "memory_documents_version_idx";--> statement-breakpoint
DROP INDEX "memory_documents_current_idx";--> statement-breakpoint
DROP INDEX "memory_documents_channel_idx";--> statement-breakpoint
-- Channel memory becomes one per channel, shared by every bot working there.
-- Where two bots kept a document at the same path in the same channel, the
-- newest live version stays current (a live one before a tombstone), the
-- others become history, and the document keeps a pin any of them had.
WITH ranked AS (
  SELECT "id", bool_or("pinned") OVER w AS "any_pinned",
    row_number() OVER (w ORDER BY "tombstone" ASC, "version_id" DESC, "id" DESC) AS "rank"
  FROM "memory_documents"
  WHERE "scope" = 'channel' AND "is_current"
  WINDOW w AS (PARTITION BY "project_id", "channel_id", "logical_path")
)
UPDATE "memory_documents" d
SET "is_current" = (r."rank" = 1), "pinned" = CASE WHEN r."rank" = 1 THEN r."any_pinned" ELSE d."pinned" END
FROM ranked r
WHERE d."id" = r."id";--> statement-breakpoint
DELETE FROM "memory_chunks" c USING "memory_documents" d
WHERE c."document_id" = d."id" AND NOT d."is_current";--> statement-breakpoint
-- Two bots' versions written in the same millisecond: move the later rows
-- apart by a millisecond each, so every version of a document has its own id.
WITH clashing AS (
  SELECT "id", row_number() OVER (PARTITION BY "project_id", "scope", coalesce("channel_id", 0), "logical_path", "version_id" ORDER BY "id") - 1 AS "shift"
  FROM "memory_documents"
)
UPDATE "memory_documents" d
SET "version_id" = d."version_id" + make_interval(secs => c."shift" / 1000.0)
FROM clashing c
WHERE d."id" = c."id" AND c."shift" > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_documents_version_idx" ON "memory_documents" USING btree ("project_id","scope",coalesce("channel_id", 0),"logical_path","version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_documents_current_idx" ON "memory_documents" USING btree ("project_id","scope",coalesce("channel_id", 0),"logical_path") WHERE "memory_documents"."is_current";--> statement-breakpoint
CREATE INDEX "memory_documents_channel_idx" ON "memory_documents" USING btree ("channel_id");--> statement-breakpoint
ALTER TABLE "memory_documents" DROP COLUMN "bot_id";