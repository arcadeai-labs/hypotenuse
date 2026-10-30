import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { conversations } from "./conversations";
import { projects } from "./projects";

/** Every status an outbox row can be in. */
export const OUTBOX_STATUSES = [
  "pending",
  "sending",
  "sent",
  "failed",
  "undeliverable",
  "superseded",
] as const;

/** One of {@link OUTBOX_STATUSES}. */
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** Where an outbox row goes. Only the API channel's signed callback exists yet. */
export type OutboxTarget = { type: "api-callback"; url: string };

/**
 * Everything a bot writes to the world, written in the same transaction as
 * the step that decided it and delivered after commit by `outbox:deliver`
 * (with `outbox:deliver-due` sweeping what that missed). The row id is the
 * delivery id the receiver dedupes on, so a retry after a lost response is
 * harmless. `seq` is the transcript entry the message came from.
 */
export const outboxMessages = pgTable(
  "outbox_messages",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    target: jsonb("target").$type<OutboxTarget>().notNull(),
    status: text("status").$type<OutboxStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    externalMessageId: text("external_message_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    index("outbox_messages_due_idx").on(t.status, t.nextAttemptAt),
    index("outbox_messages_conversation_idx").on(t.conversationId),
  ],
);

export type OutboxMessage = typeof outboxMessages.$inferSelect;
export type NewOutboxMessage = typeof outboxMessages.$inferInsert;
