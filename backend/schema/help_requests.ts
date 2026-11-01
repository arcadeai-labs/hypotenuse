import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { conversations } from "./conversations";
import { projects } from "./projects";
import { users } from "./users";

/** Every status a help request can be in. */
export const HELP_STATUSES = [
  "pending",
  "answered",
  "expired",
  "cancelled",
] as const;

/** One of {@link HELP_STATUSES}. */
export type HelpStatus = (typeof HELP_STATUSES)[number];

/** How soon a person should look. */
export const HELP_URGENCIES = ["low", "normal", "high"] as const;

/** One of {@link HELP_URGENCIES}. */
export type HelpUrgency = (typeof HELP_URGENCIES)[number];

/**
 * A `help_request` is a bot escalating to the project's people
 * (`escalate_to_human`): a question it could not answer in its channel,
 * shown in the Help inbox and sent to the holders of the bot's
 * `helpNotifyTag` (else the admins). The answer (`help:answer`) reaches the
 * conversation as a system message; a `blocking` request parks the
 * conversation on `waiting` / `answer` until then. `entryId` is the
 * `escalate_to_human` intent that raised it.
 *
 * A request raised from inside a sandbox (`sandbox:request-help`) has no
 * intent: `entryId` is null and `sandboxQuestionId` names the job's question
 * the answer goes back to, instead of the conversation.
 */
export const helpRequests = pgTable(
  "help_requests",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    botId: integer("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    entryId: integer("entry_id"),
    sandboxQuestionId: integer("sandbox_question_id"),
    question: text("question").notNull(),
    context: text("context").notNull().default(""),
    urgency: text("urgency").$type<HelpUrgency>().notNull().default("normal"),
    blocking: boolean("blocking").notNull().default(true),
    status: text("status").$type<HelpStatus>().notNull().default("pending"),
    answer: text("answer"),
    answeredByUserId: integer("answered_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (t) => [
    index("help_requests_project_status_idx").on(t.projectId, t.status, t.id),
    index("help_requests_conversation_idx").on(t.conversationId),
  ],
);

export type HelpRequest = typeof helpRequests.$inferSelect;
export type NewHelpRequest = typeof helpRequests.$inferInsert;
