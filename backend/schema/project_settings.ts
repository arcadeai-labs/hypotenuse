import {
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";

/**
 * A project's settings — one row per project, inserted by the signup bootstrap
 * and by `project:create` alongside the project itself.
 *
 * It carries no setting yet. Each feature that needs one adds its own column by
 * migration (the routing rules, for instance) rather than this table guessing
 * them in advance; the row exists now so that those migrations alter a table
 * every project already has a row in.
 */
export const projectSettings = pgTable(
  "project_settings",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
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
