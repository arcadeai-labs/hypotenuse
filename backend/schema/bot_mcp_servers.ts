import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { mcpServers } from "./mcp_servers";

/**
 * A `bot_mcp_server` gives one bot one of its project's MCP servers.
 *
 * - `allowedTools` — patterns (`server/tool`, `server/*`, `*\/tool`, a bare
 *   `tool`, or `/regex/`) naming the calls that run without a person's
 *   approval. Empty is the default: every call waits for one.
 * - `autoAllowReadOnly` — a call to a tool whose server annotates it
 *   `readOnlyHint` runs without approval. Off by default, because an
 *   annotation is the server's claim, not a guarantee.
 */
export const botMcpServers = pgTable(
  "bot_mcp_servers",
  {
    id: serial("id").primaryKey(),
    botId: integer("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    mcpServerId: integer("mcp_server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    allowedTools: jsonb("allowed_tools")
      .$type<string[]>()
      .notNull()
      .default([]),
    autoAllowReadOnly: boolean("auto_allow_read_only").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("bot_mcp_servers_bot_server_idx").on(t.botId, t.mcpServerId),
  ],
);

export type BotMcpServer = typeof botMcpServers.$inferSelect;
export type NewBotMcpServer = typeof botMcpServers.$inferInsert;
