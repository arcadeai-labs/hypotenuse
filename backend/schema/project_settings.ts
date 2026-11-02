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

/** How a sandbox's network egress is held while its agent runs. */
export const SANDBOX_EGRESS_MODES = ["open-world", "allowlist"] as const;

/** One of {@link SANDBOX_EGRESS_MODES}. */
export type SandboxEgressMode = (typeof SANDBOX_EGRESS_MODES)[number];

/**
 * Per-provider sandbox configuration. Each field is read only by a provider
 * that can use it: `image` by one that boots images, `runtime` by one that
 * boots stock runtimes, `vcpus` by one that sizes its sandboxes, and
 * `egressMode` by one whose capabilities include a domain allowlist.
 */
export interface SandboxConfig {
  /** The image a job's sandbox boots, for a provider that boots images. */
  image?: string;
  /** The stock runtime a job's sandbox boots, for one that boots runtimes. */
  runtime?: string;
  /** Virtual CPUs per sandbox. */
  vcpus?: number;
  /**
   * `open-world` (the default) leaves egress open, except a repository job's,
   * which is narrowed where the provider can; `allowlist` narrows every job
   * to this API and its git hosts before the agent starts.
   */
  egressMode?: SandboxEgressMode;
}

/**
 * A project's settings — one row per project, inserted with the project itself
 * by `createProjectForOwner`. Each feature that needs a setting adds its own
 * column by migration rather than this table guessing them in advance.
 *
 * - `sandboxProvider` — where the project's sandbox jobs run; null means the
 *   deployment's `SANDBOX_DEFAULT_PROVIDER`. `docker` is refused in
 *   production, here and when a job starts.
 * - `sandboxConfig` — that provider's options ({@link SandboxConfig}).
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
