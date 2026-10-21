import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentSessions } from "./agent_sessions";

/** Which way an activity went. */
export const ACTIVITY_DIRECTIONS = ["inbound", "outbound"] as const;

/** One of {@link ACTIVITY_DIRECTIONS}. */
export type ActivityDirection = (typeof ACTIVITY_DIRECTIONS)[number];

/**
 * What a row sends: an `agentActivityCreate`, or an `agentSessionUpdate`
 * (plan, summary, external URLs).
 */
export const ACTIVITY_KINDS = ["activity", "session_update"] as const;

/** One of {@link ACTIVITY_KINDS}. */
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Linear's activity content types. `prompt` is a person's, and inbound only. */
export const ACTIVITY_CONTENT_TYPES = [
  "prompt",
  "thought",
  "action",
  "elicitation",
  "response",
  "error",
] as const;

/** One of {@link ACTIVITY_CONTENT_TYPES}. */
export type ActivityContentType = (typeof ACTIVITY_CONTENT_TYPES)[number];

/**
 * Who goes first when an installation's request budget is short. `ack` may
 * spend the reserved tokens; `bulk` (ephemeral chatter) yields the most.
 */
export const ACTIVITY_PRIORITIES = ["ack", "normal", "bulk"] as const;

/** One of {@link ACTIVITY_PRIORITIES}. */
export type ActivityPriority = (typeof ACTIVITY_PRIORITIES)[number];

/**
 * Where a row is. Outbound rows go `pending` → `sent` | `failed` |
 * `superseded`; inbound rows are `received`.
 */
export const ACTIVITY_DELIVERY_STATUSES = [
  "pending",
  "sent",
  "failed",
  "superseded",
  "received",
] as const;

/** One of {@link ACTIVITY_DELIVERY_STATUSES}. */
export type ActivityDeliveryStatus =
  (typeof ACTIVITY_DELIVERY_STATUSES)[number];

/** Linear's signals on an activity. */
export const ACTIVITY_SIGNALS = ["stop", "auth", "select", "continue"] as const;

/** One of {@link ACTIVITY_SIGNALS}. */
export type ActivitySignal = (typeof ACTIVITY_SIGNALS)[number];

/**
 * An `agent_activity` is one turn of a session's conversation, in either
 * direction — **one table because the conversation is one sequence**, and the
 * history an agent is given is rebuilt from activities, never from comments
 * (comments can be edited).
 *
 * - **Inbound** rows are the prompts a person typed (and their signals),
 *   recorded from `AgentSessionEvent` / `prompted`.
 * - **Outbound** rows are the outbox: everything Hypotenuse writes to Linear
 *   is enqueued here and sent by `activities:deliver`, in `seq` order per
 *   session, each `agentActivityCreate` carrying `clientActivityId` as its
 *   `id` so a retried send can never post twice.
 *
 * `seq` is assigned under the session's row lock, so it is gap-free per
 * session and is the delivery order.
 */
export const agentActivities = pgTable(
  "agent_activities",
  {
    id: serial("id").primaryKey(),
    agentSessionId: integer("agent_session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    direction: text("direction").$type<ActivityDirection>().notNull(),
    kind: text("kind").$type<ActivityKind>().notNull().default("activity"),
    /** Null for a `session_update`. */
    contentType: text("content_type").$type<ActivityContentType | null>(),
    /** The exact content sent or received; for `session_update`, the update's input. */
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    ephemeral: boolean("ephemeral").notNull().default(false),
    signal: text("signal").$type<ActivitySignal | null>(),
    signalMetadata: jsonb("signal_metadata").$type<Record<
      string,
      unknown
    > | null>(),
    /** Generated at enqueue; `agentActivityCreate`'s `id`, so sending twice is harmless. */
    clientActivityId: uuid("client_activity_id").notNull(),
    /** Linear's id: the client id once sent, or the inbound activity's id. */
    linearActivityId: text("linear_activity_id"),
    /** Inbound only: the thread comment Linear mirrored the prompt into. */
    sourceCommentId: text("source_comment_id"),
    /** Inbound only: the person who typed it. */
    linearUserId: text("linear_user_id"),
    priority: text("priority")
      .$type<ActivityPriority>()
      .notNull()
      .default("normal"),
    deliveryStatus: text("delivery_status")
      .$type<ActivityDeliveryStatus>()
      .notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    sessionSeqIndex: uniqueIndex("agent_activities_session_seq_idx").on(
      t.agentSessionId,
      t.seq,
    ),
    clientIdIndex: uniqueIndex("agent_activities_client_id_idx").on(
      t.clientActivityId,
    ),
    // The outbox clock's query: what is due to send.
    pendingIndex: index("agent_activities_pending_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.deliveryStatus} = 'pending'`),
  }),
);

export type AgentActivity = typeof agentActivities.$inferSelect;
export type NewAgentActivity = typeof agentActivities.$inferInsert;
