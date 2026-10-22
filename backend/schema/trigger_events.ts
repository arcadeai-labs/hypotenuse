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
import { agentSessions } from "./agent_sessions";
import { integrations, type TriggerType } from "./integrations";
import { workItems } from "./work_items";

/** Every outcome a recorded delivery can reach. */
export const TRIGGER_EVENT_OUTCOMES = [
  "pending",
  "handled",
  // A `created` for a session a manager's dispatch had already recorded.
  "duplicate_of_dispatch",
  "ignored",
  "unknown_integration",
  "failed",
  // `AppUserNotification`s (see `handleAppUserNotification`): seen and
  // recorded, nothing to do — or a check is still due (`checkAfter`).
  "noted",
  // A mention Linear started no session for: the app has likely lost
  // `app:mentionable`.
  "mention_without_session",
  // The issue was *assigned* to the app user; Hypotenuse works by delegation.
  "assigned_not_delegated",
  // The notification ended live work: unassigned, or the issue closed.
  "disengaged",
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
 * - **It is the project's event log** (`trigger-event:list`): every delivery,
 *   what it did (`summary`), and the session and turn it touched, whose
 *   routing is read live from those rows.
 *
 * Retention is `LINEAR_EVENT_RETENTION_DAYS` (14 by default): the session
 * mirror is the lasting record; this is the recent one.
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
    /**
     * When a processed notification is checked again by the
     * `triggers:check-notifications` clock — a mention that should have
     * started a session, a status change whose new state must be read from
     * Linear. Null when nothing is due.
     */
    checkAfter: timestamp("check_after", { withTimezone: true }),
    /**
     * What processing did, in one sentence for the event log: "Started a
     * session on ENG-123 and queued its first turn", "Ignored: …".
     */
    summary: text("summary"),
    /** The agent session the delivery was about, once processing knows it. */
    agentSessionId: integer("agent_session_id").references(
      () => agentSessions.id,
      { onDelete: "set null" },
    ),
    /** The turn it queued, joined, answered, or cancelled, when there is one. */
    workItemId: integer("work_item_id").references(() => workItems.id, {
      onDelete: "set null",
    }),
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
    // The notification clock's only query.
    checkIndex: index("trigger_events_check_idx")
      .on(t.checkAfter)
      .where(sql`${t.checkAfter} IS NOT NULL`),
    // Retention deletes by age.
    receivedIndex: index("trigger_events_received_idx").on(t.receivedAt),
    // The event log: one integration's deliveries, newest first.
    integrationReceivedIndex: index(
      "trigger_events_integration_received_idx",
    ).on(t.integrationId, t.receivedAt),
  }),
);

export type TriggerEvent = typeof triggerEvents.$inferSelect;
export type NewTriggerEvent = typeof triggerEvents.$inferInsert;
