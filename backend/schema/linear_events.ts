import { sql } from "drizzle-orm";
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
import { linearInstallations } from "./linear_installations";

/** Every outcome a recorded delivery can reach. */
export const LINEAR_EVENT_OUTCOMES = [
  "pending",
  "handled",
  "ignored",
  "unknown_installation",
  "failed",
] as const;

/** One of {@link LINEAR_EVENT_OUTCOMES}. */
export type LinearEventOutcome = (typeof LINEAR_EVENT_OUTCOMES)[number];

/**
 * A `linear_event` is one verified webhook delivery from Linear, exactly as it
 * arrived, and what processing it did.
 *
 * - **The row is the delivery.** `webhooks:linear` writes it and answers 200;
 *   the `linear:process-event` job that follows is an accelerant, and the
 *   `linear:process-pending` clock finds any row a lost enqueue left
 *   unprocessed.
 * - **`deliveryId` is unique**, because Linear's `Linear-Delivery` is constant
 *   across its retries: a retry is an insert that conflicts, and is answered
 *   200 without doing anything twice.
 * - **`installationId` is null** when the delivery was verified but belongs to
 *   no live installation (`outcome = unknown_installation`) — answered 200 all
 *   the same, because one webhook serves every workspace and Linear disables a
 *   webhook that keeps failing.
 *
 * Retention is short (`LINEAR_EVENT_RETENTION_DAYS`): the session mirror, not
 * this table, is the record.
 */
export const linearEvents = pgTable(
  "linear_events",
  {
    id: serial("id").primaryKey(),
    deliveryId: text("delivery_id").notNull(),
    installationId: integer("installation_id").references(
      () => linearInstallations.id,
      { onDelete: "set null" },
    ),
    /** The body's `type`: `AgentSessionEvent`, `PermissionChange`, `OAuthApp`, `Issue`, … */
    eventType: text("event_type").notNull(),
    /** The body's `action`: `created`, `prompted`, `revoked`, `update`, a notification type, … */
    action: text("action").notNull(),
    /** The signed `webhookTimestamp`. */
    webhookTimestamp: timestamp("webhook_timestamp", {
      withTimezone: true,
    }).notNull(),
    /** The verified body. Linear sends no secrets; it is capped before it is read. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    outcome: text("outcome")
      .$type<LinearEventOutcome>()
      .notNull()
      .default("pending"),
    /** Why processing failed, for `failed`. */
    error: text("error"),
  },
  (t) => ({
    deliveryIndex: uniqueIndex("linear_events_delivery_idx").on(t.deliveryId),
    // The sweep's only query: what nobody has processed yet.
    unprocessedIndex: index("linear_events_unprocessed_idx")
      .on(t.processedAt)
      .where(sql`${t.processedAt} IS NULL`),
    // Retention deletes by age.
    receivedIndex: index("linear_events_received_idx").on(t.receivedAt),
  }),
);

export type LinearEvent = typeof linearEvents.$inferSelect;
export type NewLinearEvent = typeof linearEvents.$inferInsert;
