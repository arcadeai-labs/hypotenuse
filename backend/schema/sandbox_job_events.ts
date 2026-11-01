import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sandboxJobs } from "./sandbox_jobs";

/**
 * A sandbox job's transcript: the coding CLI's JSONL, parsed by the
 * supervisor and posted in batches to `sandbox:events`. `seq` is the
 * supervisor's own number, stamped when an event is queued, so a retried
 * batch is an upsert on `(jobId, seq)` rather than a duplicate.
 */
export const sandboxJobEvents = pgTable(
  "sandbox_job_events",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => sandboxJobs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    toolName: text("tool_name"),
    text: text("text"),
    payload: jsonb("payload").$type<unknown>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("sandbox_job_events_job_seq_idx").on(t.jobId, t.seq),
    index("sandbox_job_events_job_idx").on(t.jobId, t.id),
  ],
);

export type SandboxJobEvent = typeof sandboxJobEvents.$inferSelect;
