import {
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";

/**
 * A project's settings — one row per project, inserted with the project itself
 * by `createProjectForOwner`.
 *
 * It holds no setting yet. Each feature that needs one adds its own column by
 * migration rather than this table guessing them in advance; the row exists now
 * so that adding the first column never has to backfill a row per project.
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
  (t) => [uniqueIndex("project_settings_project_idx").on(t.projectId)],
);

export type ProjectSettings = typeof projectSettings.$inferSelect;
export type NewProjectSettings = typeof projectSettings.$inferInsert;
