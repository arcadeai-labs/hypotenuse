import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { botInstallations } from "./bot_installations";
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

/**
 * Where an outbox row goes: the API channel's signed callback, the dashboard
 * (`web`, which reads Postgres, so there is nothing to post), or a platform
 * adapter's address — the channel, and the thread, session, or issue in it.
 */
export type OutboxTarget =
  | { type: "api-callback"; url: string }
  | { type: "web" }
  | {
      type: "platform";
      platform: string;
      channelExternalId: string;
      conversationKey: string | null;
    };

/**
 * What an outbox row is, on the interactive surface. `status`, `stream`, and
 * `plan` are ephemeral; the API channel's callbacks keep their own kinds
 * (`reply`, `complete`, `fail`, `question`, `error`).
 */
export const SURFACE_KINDS = [
  "status",
  "stream",
  "plan",
  "message",
  "question",
  "approval",
] as const;

/** One of {@link SURFACE_KINDS}. */
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** Delivery priority: `ack` rows go first and draw on a reserve. */
export const OUTBOX_PRIORITIES = ["ack", "normal", "bulk"] as const;

/** One of {@link OUTBOX_PRIORITIES}. */
export type OutboxPriority = (typeof OUTBOX_PRIORITIES)[number];

/**
 * Everything a bot writes to the world, written in the same transaction as
 * the step that decided it and delivered after commit by `outbox:deliver`
 * (with `outbox:deliver-due` sweeping what that missed). The row id is the
 * delivery id the receiver dedupes on, so a retry after a lost response is
 * harmless. `seq` is the transcript entry the message came from (for a
 * `stream` row, the newest entry when the stream began).
 *
 * A conversation's rows deliver in `id` order, one deliverer at a time (a
 * Redis lease per conversation). A new ephemeral row supersedes every older
 * undelivered row with the same `supersedesKey`.
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
    botInstallationId: integer("bot_installation_id").references(
      () => botInstallations.id,
      { onDelete: "set null" },
    ),
    priority: text("priority")
      .$type<OutboxPriority>()
      .notNull()
      .default("normal"),
    supersedesKey: text("supersedes_key"),
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
