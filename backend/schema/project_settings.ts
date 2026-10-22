import {
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";

/** Work routing's per-project timers and thresholds. */
export interface RoutingSettings {
  /** A turn no runner takes within this long expires, with an `error`. */
  queueTimeoutMs: number;
  /** How long a follow-up waits for the runner holding its worktree. `0` never waits. */
  stickyTimeoutMs: number;
  /** How long an offer stands before it goes to the next runner. */
  offerTtlMs: number;
  /** The confidence Linear's top repository suggestion needs to be taken. */
  repositoryConfidence: number;
  /** How long a stopped turn's runner has to confirm before the server answers. */
  stopGraceMs: number;
  /** How many review rounds a manager runs on one dispatch. */
  maxReviewRounds: number;
}

/** What a project lets its manager sessions do. */
export interface ManagerSettings {
  /** Whether a manager may move an issue to a completed or canceled state. */
  canCompleteIssues: boolean;
  /** How many dispatched sessions one manager session may have under way. */
  maxParallelDispatch: number;
}

/**
 * A project's settings — one row per project, inserted by the signup bootstrap
 * and by `project:create` alongside the project itself.
 *
 * Each feature that needs a setting adds its own column by migration rather
 * than this table guessing them in advance.
 *
 * - **`routing`** — work routing's timers and thresholds, sparse: a key that is
 *   absent takes its default (`ROUTING_DEFAULTS` in `ops/ProjectSettingsOps.ts`),
 *   so a default can change without rewriting every row.
 * - **`manager`** — what manager sessions may do, sparse the same way
 *   (`MANAGER_DEFAULTS`).
 */
export const projectSettings = pgTable(
  "project_settings",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    routing: jsonb("routing")
      .$type<Partial<RoutingSettings>>()
      .notNull()
      .default({}),
    manager: jsonb("manager")
      .$type<Partial<ManagerSettings>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    // 1:1 with the project. Two concurrent lazy creations race, and the unique
    // index is what makes the loser's insert fail rather than leave a duplicate.
    projectIndex: uniqueIndex("project_settings_project_idx").on(t.projectId),
  }),
);

export type ProjectSettings = typeof projectSettings.$inferSelect;
export type NewProjectSettings = typeof projectSettings.$inferInsert;
