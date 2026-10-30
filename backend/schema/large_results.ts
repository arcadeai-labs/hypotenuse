import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { conversations } from "./conversations";
import { projects } from "./projects";

/**
 * A `large_result` is a tool output too long to put in front of the model
 * whole. The model gets a preview and the id (`lr_<id>`), and pages the rest
 * with `read_large_result`. It belongs to the conversation whose call
 * produced it (`entryId` is that call's intent) and is deleted 30 days after
 * the conversation ends, by `large-results:sweep`.
 */
export const largeResults = pgTable(
  "large_results",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    entryId: integer("entry_id"),
    mimeType: text("mime_type").notNull().default("application/json"),
    content: text("content").notNull(),
    totalChars: integer("total_chars").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("large_results_conversation_idx").on(t.conversationId)],
);

export type LargeResult = typeof largeResults.$inferSelect;
