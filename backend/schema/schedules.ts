import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { channels } from "./channels";
import { conversations } from "./conversations";
import { projects } from "./projects";
import { users } from "./users";

/**
 * What a schedule wakes the bot to do: follow its instruction, or review its
 * goals (`goal-review`, which adds the goals and recent conversations).
 */
export const SCHEDULE_KINDS = ["instruction", "goal-review"] as const;
/** One of {@link SCHEDULE_KINDS}. */
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/**
 * Where a slot's work happens: a new conversation in a channel each slot, a
 * turn in one existing conversation, or an internal conversation that posts
 * nowhere (`none`).
 */
export const SCHEDULE_TARGET_TYPES = [
  "channel",
  "conversation",
  "none",
] as const;
/** One of {@link SCHEDULE_TARGET_TYPES}. */
export type ScheduleTargetType = (typeof SCHEDULE_TARGET_TYPES)[number];

/**
 * What happens to slots missed while nothing ran: `latest` runs the newest
 * one, `none` runs none. Never a burst.
 */
export const SCHEDULE_CATCH_UPS = ["latest", "none"] as const;
/** One of {@link SCHEDULE_CATCH_UPS}. */
export type ScheduleCatchUp = (typeof SCHEDULE_CATCH_UPS)[number];

/**
 * A `schedule` wakes a bot at the slots of a cron expression, in an IANA
 * time zone, with an instruction. People create, edit, enable, and delete
 * schedules (audited); a bot may only propose one, which is written
 * disabled (`proposedByBot`) for a person to enable.
 *
 * - `cron` — five fields (minute to weekday); `timeZone` — the zone the
 *   fields are read in. `nextRunAt` is the next slot, in UTC; the
 *   `schedules:due` clock claims rows whose `nextRunAt` has passed.
 * - `guard` — an optional question the bot's `fast` model answers once per
 *   slot before the bot is woken; a "no" skips the slot.
 * - `channelId` / `conversationId` — the target, by `targetType`.
 * - `lastRunAt` — the newest slot a run was written for.
 */
export const schedules = pgTable(
  "schedules",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    botId: integer("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    kind: text("kind").$type<ScheduleKind>().notNull().default("instruction"),
    targetType: text("target_type").$type<ScheduleTargetType>().notNull(),
    channelId: integer("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    conversationId: integer("conversation_id").references(
      () => conversations.id,
      { onDelete: "cascade" },
    ),
    cron: text("cron").notNull(),
    timeZone: text("time_zone").notNull(),
    instruction: text("instruction").notNull().default(""),
    guard: text("guard"),
    catchUp: text("catch_up")
      .$type<ScheduleCatchUp>()
      .notNull()
      .default("latest"),
    enabled: boolean("enabled").notNull().default(true),
    proposedByBot: boolean("proposed_by_bot").notNull().default(false),
    proposedInConversationId: integer("proposed_in_conversation_id"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
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
  (t) => [
    index("schedules_bot_idx").on(t.botId),
    index("schedules_due_idx").on(t.nextRunAt).where(sql`${t.enabled}`),
  ],
);

export type Schedule = typeof schedules.$inferSelect;
export type NewSchedule = typeof schedules.$inferInsert;
