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
import { conversations } from "./conversations";
import { users } from "./users";

/** Every kind of transcript entry. */
export const ENTRY_KINDS = [
  "message",
  "thinking",
  "tool_call_intent",
  "tool_result",
  "context_update",
  "status_change",
  "compaction",
] as const;

/** One of {@link ENTRY_KINDS}. */
export type EntryKind = (typeof ENTRY_KINDS)[number];

/**
 * The transcript: **append-only**, ordered by `seq`, one row per message,
 * model step part, tool intent, tool result, and state change. Hydration
 * rebuilds the model's whole message list from these rows, tool calls and
 * results included; nothing about a conversation lives in a worker's memory.
 *
 * `content` is per kind (see `TranscriptOps`). A `tool_call_intent` is written
 * **before** its tool runs, carrying `replay`, so recovery can tell a call
 * that may have had effects from one that can be run again. Entries are never
 * edited or deleted; a `compaction` adds a summary and hides nothing from
 * `search_history`.
 */
export const conversationEntries = pgTable(
  "conversation_entries",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    epoch: integer("epoch").notNull(),
    stepId: text("step_id"),
    kind: text("kind").$type<EntryKind>().notNull(),
    role: text("role"),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    replay: text("replay"),
    promptHash: text("prompt_hash"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms"),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    participantId: integer("participant_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("conversation_entries_seq_idx").on(t.conversationId, t.seq),
    index("conversation_entries_intent_idx")
      .on(t.conversationId, t.kind)
      .where(sql`${t.kind} = 'tool_call_intent'`),
  ],
);

export type ConversationEntry = typeof conversationEntries.$inferSelect;
export type NewConversationEntry = typeof conversationEntries.$inferInsert;
