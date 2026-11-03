import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { schedules } from "./schedules";

/**
 * Every status a schedule run moves through.
 *
 * | Status | Meaning |
 * |---|---|
 * | `pending` | written by `schedules:due` (or `schedule:run-now`), not yet fired |
 * | `guarding` | the guard is being asked |
 * | `skipped` | the guard said no, or the target is disengaged; `reason` says which |
 * | `woken` | the inbox row is written; the conversation has not finished the turn that reads it |
 * | `silent` | the bot ended that turn with nothing to say |
 * | `posted` | the bot ended that turn having said something |
 * | `failed` | the turn failed, or the run could not be fired; `reason` says why |
 */
export const SCHEDULE_RUN_STATUSES = [
  "pending",
  "guarding",
  "skipped",
  "woken",
  "silent",
  "posted",
  "failed",
] as const;
/** One of {@link SCHEDULE_RUN_STATUSES}. */
export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUSES)[number];

/** What wrote a run: the clock at a slot, or a person's `schedule:run-now`. */
export const SCHEDULE_RUN_TRIGGERS = ["cron", "manual"] as const;
/** One of {@link SCHEDULE_RUN_TRIGGERS}. */
export type ScheduleRunTrigger = (typeof SCHEDULE_RUN_TRIGGERS)[number];

/** The guard's answer, kept on the run. */
export interface GuardDecision {
  act: boolean;
  reason: string;
}

/**
 * A `schedule_run` is one slot of a schedule: **unique per
 * `(scheduleId, slot)`**, so overlapping clock ticks, retries, and several
 * workers write it once. `projectId` and `botId` are copied, so the history
 * reads without a join.
 *
 * - `conversationId` / `inboxId` — the conversation woken and the inbox row
 *   it was woken with; the turn that delivers that row settles the run.
 * - `guard` — the guard's `{ act, reason }`, when the schedule has one.
 * - `costUsd` — what the guard and the turn cost, where the provider reports
 *   a cost.
 * - `startedAt` — when a fire took the run; a run left `pending` or
 *   `guarding` past the sweep's window is fired again.
 */
export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: serial("id").primaryKey(),
    scheduleId: integer("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull(),
    botId: integer("bot_id").notNull(),
    slot: timestamp("slot", { withTimezone: true }).notNull(),
    trigger: text("trigger")
      .$type<ScheduleRunTrigger>()
      .notNull()
      .default("cron"),
    status: text("status")
      .$type<ScheduleRunStatus>()
      .notNull()
      .default("pending"),
    reason: text("reason"),
    conversationId: integer("conversation_id"),
    inboxId: integer("inbox_id"),
    guard: jsonb("guard").$type<GuardDecision>(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 }),
    triggeredByUserId: integer("triggered_by_user_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("schedule_runs_schedule_slot_idx").on(t.scheduleId, t.slot),
    index("schedule_runs_conversation_idx").on(t.conversationId, t.status),
    index("schedule_runs_open_idx").on(t.status, t.createdAt),
  ],
);

export type ScheduleRun = typeof scheduleRuns.$inferSelect;
export type NewScheduleRun = typeof scheduleRuns.$inferInsert;
