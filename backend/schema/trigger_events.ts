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
import { integrations, type TriggerType } from "./integrations";

/** Every outcome a recorded delivery can reach. */
export const TRIGGER_EVENT_OUTCOMES = [
  "pending",
  "handled",
  "ignored",
  "unknown_integration",
  "failed",
] as const;

/** One of {@link TRIGGER_EVENT_OUTCOMES}. */
export type TriggerEventOutcome = (typeof TRIGGER_EVENT_OUTCOMES)[number];

/**
 * A `trigger_event` is one verified webhook delivery from a trigger system —
 * today Linear — exactly as it arrived, and what processing it did.
 *
 * - **The row is the delivery.** The type's webhook endpoint (`webhooks:linear`)
 *   writes it and answers 200; the `triggers:process-event` job that follows is
 *   an accelerant, and the `triggers:process-pending` clock finds any row a
 *   lost enqueue left unprocessed.
 * - **`(type, deliveryId)` is unique**, because Linear's `Linear-Delivery` is
 *   constant across its retries: a retry is an insert that conflicts, and is
 *   answered 200 without doing anything twice.
 * - **`integrationId` is null** when the delivery was verified but belongs to
 *   no live integration (`outcome = unknown_integration`) — answered 200 all
 *   the same, because one webhook serves every workspace and Linear disables a
 *   webhook that keeps failing.
 *
 * Retention is short (`LINEAR_EVENT_RETENTION_DAYS`): the session mirror, not
 * this table, is the record.
 */
export const triggerEvents = pgTable(
  "trigger_events",
  {
    id: serial("id").primaryKey(),
    type: text("type").$type<TriggerType>().notNull(),
    deliveryId: text("delivery_id").notNull(),
    integrationId: integer("integration_id").references(() => integrations.id, {
      onDelete: "set null",
    }),
    /** The body's event type: `AgentSessionEvent`, `PermissionChange`, `OAuthApp`, `Issue`, … */
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
      .$type<TriggerEventOutcome>()
      .notNull()
      .default("pending"),
    /** Why processing failed, for `failed`. */
    error: text("error"),
  },
  (t) => ({
    deliveryIndex: uniqueIndex("trigger_events_delivery_idx").on(
      t.type,
      t.deliveryId,
    ),
    // The sweep's only query: what nobody has processed yet.
    unprocessedIndex: index("trigger_events_unprocessed_idx")
      .on(t.processedAt)
      .where(sql`${t.processedAt} IS NULL`),
    // Retention deletes by age.
    receivedIndex: index("trigger_events_received_idx").on(t.receivedAt),
  }),
);

export type TriggerEvent = typeof triggerEvents.$inferSelect;
export type NewTriggerEvent = typeof triggerEvents.$inferInsert;
