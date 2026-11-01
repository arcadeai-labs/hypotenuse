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

/** Every status a trigger event can be in. */
export const TRIGGER_EVENT_STATUSES = [
  "pending",
  "processed",
  "ignored",
  "failed",
] as const;

/** One of {@link TRIGGER_EVENT_STATUSES}. */
export type TriggerEventStatus = (typeof TRIGGER_EVENT_STATUSES)[number];

/**
 * A `trigger_event` is one verified delivery from a platform, recorded by
 * ingress before it answers and processed after (`triggers:process-event`).
 * `(type, botInstallationId, externalEventId)` is unique, so a platform's
 * retry is one row; the inbox dedupes again on `messageKey`, so two events
 * carrying one message are one inbox row.
 *
 * `outcome` is the processing table's verdict (`ignored: loop`,
 * `processed: message`, …) and `detail` what it decided along the way (an
 * auto-created binding, the conversation it reached). A ledger row: ids are
 * copied, never foreign keys, so it takes part in no lock.
 *
 * For `type: "github"` — the deployment's GitHub App, which belongs to no
 * bot — `botInstallationId` holds the `github_installations` row the event
 * reached (one row per project that attached the installation), or `0` for
 * an installation no project attached.
 */
export const triggerEvents = pgTable(
  "trigger_events",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id"),
    type: text("type").notNull(),
    botInstallationId: integer("bot_installation_id").notNull(),
    externalEventId: text("external_event_id").notNull(),
    messageKey: text("message_key"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    status: text("status")
      .$type<TriggerEventStatus>()
      .notNull()
      .default("pending"),
    outcome: text("outcome"),
    detail: jsonb("detail")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    checkAfter: timestamp("check_after", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("trigger_events_external_idx").on(
      t.type,
      t.botInstallationId,
      t.externalEventId,
    ),
    index("trigger_events_pending_idx").on(t.status, t.checkAfter),
    index("trigger_events_project_idx").on(t.projectId, t.id),
  ],
);

export type TriggerEvent = typeof triggerEvents.$inferSelect;
export type NewTriggerEvent = typeof triggerEvents.$inferInsert;
