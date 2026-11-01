import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sandboxJobs } from "./sandbox_jobs";

/** Who sent a message to a job. */
export const SANDBOX_MESSAGE_SOURCES = [
  "bot",
  "participant",
  "system",
] as const;

/** One of {@link SANDBOX_MESSAGE_SOURCES}. */
export type SandboxMessageSource = (typeof SANDBOX_MESSAGE_SOURCES)[number];

/**
 * How a message reaches the coding agent: `queue` is the next turn of an
 * interactive job; `steer` interrupts the running turn and resumes with it.
 */
export const SANDBOX_MESSAGE_DELIVERIES = ["queue", "steer"] as const;

/** One of {@link SANDBOX_MESSAGE_DELIVERIES}. */
export type SandboxMessageDelivery =
  (typeof SANDBOX_MESSAGE_DELIVERIES)[number];

/**
 * A message for a running job, handed to the supervisor by the heartbeat — the
 * only server → sandbox control. A heartbeat claims the oldest undelivered
 * row and stamps `deliveredAt` in the same statement, so a claimed message is
 * never handed out twice (delivery after a claim is at-most-once).
 * `deliveryKey` is the sender's dedupe key: a replayed `sandbox_message` is
 * one row.
 */
export const sandboxJobMessages = pgTable(
  "sandbox_job_messages",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => sandboxJobs.id, { onDelete: "cascade" }),
    source: text("source").$type<SandboxMessageSource>().notNull(),
    delivery: text("delivery").$type<SandboxMessageDelivery>().notNull(),
    body: text("body").notNull(),
    deliveryKey: text("delivery_key").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("sandbox_job_messages_key_idx").on(t.deliveryKey),
    index("sandbox_job_messages_job_idx").on(t.jobId, t.id),
  ],
);

export type SandboxJobMessage = typeof sandboxJobMessages.$inferSelect;
