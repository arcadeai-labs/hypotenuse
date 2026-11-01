import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";

/** Per-provider sandbox configuration: an image to run, today. */
export interface SandboxConfig {
  image?: string;
}

/**
 * A project's settings — one row per project, inserted with the project itself
 * by `createProjectForOwner`. Each feature that needs a setting adds its own
 * column by migration rather than this table guessing them in advance.
 *
 * - `sandboxProvider` — where the project's sandbox jobs run; null means the
 *   deployment's `SANDBOX_DEFAULT_PROVIDER`. `docker` is refused in
 *   production, here and when a job starts.
 * - `sandboxConfig` — that provider's options (`image`).
 * - `sandboxConcurrency` — jobs in flight at once; null means the
 *   deployment's default.
 * - `sandboxMaxDurationMs` — the longest one job may run; null means the
 *   deployment's ceiling, which this may only lower.
 */
export const projectSettings = pgTable(
  "project_settings",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sandboxProvider: text("sandbox_provider"),
    sandboxConfig: jsonb("sandbox_config")
      .$type<SandboxConfig>()
      .notNull()
      .default({}),
    sandboxConcurrency: integer("sandbox_concurrency"),
    sandboxMaxDurationMs: integer("sandbox_max_duration_ms"),
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
