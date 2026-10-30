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
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { channels } from "./channels";
import { projects } from "./projects";
import { users } from "./users";

/** Every state a conversation can be in. */
export const CONVERSATION_STATES = [
  "working",
  "hibernating",
  "waiting",
  "ended",
] as const;

/** One of {@link CONVERSATION_STATES}. */
export type ConversationState = (typeof CONVERSATION_STATES)[number];

/** How an ended conversation ended. */
export const CONVERSATION_OUTCOMES = [
  "completed",
  "failed",
  "cancelled",
] as const;

/** One of {@link CONVERSATION_OUTCOMES}. */
export type ConversationOutcome = (typeof CONVERSATION_OUTCOMES)[number];

/**
 * What a `waiting` conversation waits on. Always typed, never free text, so
 * the clock that ends a wait can find it from the row alone.
 *
 * - `answer`: an `ask_question` was posted; the next inbound message is the
 *   answer. `timeoutAt`, when set, is when `agents:wake-due` gives up on it.
 * - `timer`: `wait_for` asked to sleep until `at` (epoch ms).
 * - `approval`, `sandbox`: reserved for the approval gate and sandbox jobs,
 *   which do not exist yet; nothing writes them.
 */
export type WaitingOn =
  | { kind: "answer"; questionEntryId: number; timeoutAt: number | null }
  | { kind: "timer"; at: number }
  | { kind: "approval"; approvalIds: number[] }
  | { kind: "sandbox"; sandboxJobId: number };

/**
 * A `conversation` is one thread of work between a bot and a channel. The row
 * is the orchestration state of the agent loop: what a tick reads to decide
 * whether it may run, and what every clock sweeps when a queued job was lost.
 *
 * - `state` / `waitingOn` / `outcome` — the state machine. `waitingOn` is set
 *   only in `waiting`; `outcome` only in `ended`.
 * - `leaseOwner` / `leaseExpiresAt` — the one tick allowed to write this
 *   conversation's entries. Claimed and extended by conditional `UPDATE`s.
 * - `wakeRequestedAt` — the durable "a tick is owed" flag. Every queued tick
 *   is an accelerant; `agents:wake-due` finds what one missed from this.
 * - `turnBoundary` — the next step starts a turn, or resumes from a wait, so
 *   every pending inbox row is delivered (between steps only `steer` rows are).
 * - `epoch` counts turns; `stepsThisTurn` and `nudgedThisTurn` bound one.
 * - `lastSeq` is the last transcript `seq` handed out: incrementing it under
 *   the row lock is how two writers (a tick and a compaction) never collide.
 * - `lastInputTokens` — the newest step's prompt size, which decides when a
 *   background compaction is due.
 * - `requestId` — the client's dedupe key for `conversation:create`.
 * - `forkedFrom*` — reserved for forking a conversation; nothing writes them.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    botId: integer("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    externalConversationKey: text("external_conversation_key"),
    title: text("title"),
    state: text("state").$type<ConversationState>().notNull(),
    waitingOn: jsonb("waiting_on").$type<WaitingOn>(),
    outcome: text("outcome").$type<ConversationOutcome>(),
    epoch: integer("epoch").notNull().default(0),
    wakeRequestedAt: timestamp("wake_requested_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", {
      withTimezone: true,
    }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    turnBoundary: boolean("turn_boundary").notNull().default(true),
    stepsThisTurn: integer("steps_this_turn").notNull().default(0),
    nudgedThisTurn: boolean("nudged_this_turn").notNull().default(false),
    lastSeq: integer("last_seq").notNull().default(0),
    lastInputTokens: integer("last_input_tokens"),
    requestId: text("request_id"),
    callbackUrl: text("callback_url"),
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    forkedFromConversationId: integer("forked_from_conversation_id"),
    forkedFromSeq: integer("forked_from_seq"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("conversations_channel_external_idx").on(
      t.channelId,
      t.externalConversationKey,
    ),
    uniqueIndex("conversations_bot_request_idx").on(t.botId, t.requestId),
    index("conversations_project_activity_idx").on(
      t.projectId,
      t.lastActivityAt,
    ),
    index("conversations_working_idx")
      .on(t.state, t.wakeRequestedAt)
      .where(sql`${t.state} in ('working', 'waiting')`),
  ],
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
