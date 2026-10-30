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
import { conversations } from "./conversations";
import { users } from "./users";

/** How an inbound message enters a running turn. */
export const INBOX_DELIVERIES = ["queue", "steer"] as const;

/** One of {@link INBOX_DELIVERIES}. */
export type InboxDelivery = (typeof INBOX_DELIVERIES)[number];

/** Who wrote an inbound message. */
export const INBOX_SOURCES = [
  "user",
  "participant",
  "system",
  "event",
] as const;

/** One of {@link INBOX_SOURCES}. */
export type InboxSource = (typeof INBOX_SOURCES)[number];

/**
 * Inbound messages the transcript has not taken in yet. A tick claims rows
 * (`FOR UPDATE SKIP LOCKED`), stamps `deliveredAt`, and appends each as a
 * `message` entry in the same transaction, so a message is in the transcript
 * exactly once.
 *
 * - `deliveryKey` is unique per conversation: a retried submission (the
 *   caller's `requestId`) collapses to one row.
 * - `delivery`: a `steer` row enters a running turn at its next step; a
 *   `queue` row waits for the turn to end.
 * - `userId` is a Hypotenuse user; `participantId` is reserved for a platform
 *   sender, which the channel framework adds.
 */
export const conversationInbox = pgTable(
  "conversation_inbox",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    deliveryKey: text("delivery_key").notNull(),
    delivery: text("delivery").$type<InboxDelivery>().notNull(),
    source: text("source").$type<InboxSource>().notNull(),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    participantId: integer("participant_id"),
    text: text("text").notNull(),
    attachments: jsonb("attachments").$type<unknown[]>().notNull().default([]),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("conversation_inbox_delivery_key_idx").on(
      t.conversationId,
      t.deliveryKey,
    ),
    index("conversation_inbox_pending_idx").on(t.conversationId, t.deliveredAt),
  ],
);

export type ConversationInboxRow = typeof conversationInbox.$inferSelect;
export type NewConversationInboxRow = typeof conversationInbox.$inferInsert;
