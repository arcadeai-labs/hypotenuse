import {
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * The spend ledger: one row per model step. Attribution is **copied, not
 * joined**, and no id carries a foreign key, so the ledger outlives a deleted
 * bot or project and never takes a key-share lock on a hot row.
 *
 * Token counts are exactly what the provider reported. `costUsd` is set only
 * when the provider reports a cost; pricing the rest is later work.
 */
export const costRecords = pgTable(
  "cost_records",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id").notNull(),
    botId: integer("bot_id").notNull(),
    channelId: integer("channel_id").notNull(),
    conversationId: integer("conversation_id").notNull(),
    epoch: integer("epoch").notNull(),
    stepId: text("step_id").notNull(),
    modelConnectionId: integer("model_connection_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("cost_records_bot_created_idx").on(t.botId, t.createdAt),
    index("cost_records_conversation_idx").on(t.conversationId),
  ],
);

export type CostRecord = typeof costRecords.$inferSelect;
export type NewCostRecord = typeof costRecords.$inferInsert;
