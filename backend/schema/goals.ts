import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { projects } from "./projects";
import { users } from "./users";

/** A goal's state. */
export const GOAL_STATUSES = ["active", "achieved", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** A goal's priority, which orders goals in the prompt. */
export const GOAL_PRIORITIES = ["high", "medium", "low"] as const;
export type GoalPriority = (typeof GOAL_PRIORITIES)[number];

/**
 * A `goal` is something a bot works toward. People create, retitle, and delete
 * goals; the bot reads its active goals in its prompt and may change only
 * `status` and `notes` (`goal_update`).
 *
 * - `reviewEverySeconds` — when set, the goal is due for review once that long
 *   has passed since `lastReviewedAt` (or since it was created), and the
 *   prompt asks the bot to review it. `goal_update` marks it reviewed.
 * - `position` orders goals of the same priority.
 */
export const goals = pgTable(
  "goals",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    botId: integer("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<GoalStatus>().notNull().default("active"),
    priority: text("priority")
      .$type<GoalPriority>()
      .notNull()
      .default("medium"),
    notes: text("notes").notNull().default(""),
    reviewEverySeconds: integer("review_every_seconds"),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    position: integer("position").notNull().default(0),
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index("goals_bot_idx").on(t.botId)],
);

export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;
