import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * An `audit_log` records one mutating action: who did it (`userId`), in which
 * project (`projectId`), what action (`action`, e.g. `"tag:edit"`), the scrubbed
 * action params (`metadata`), and before/after snapshots of the affected entity.
 * Rows are written inside the **same transaction** as the change they describe
 * (see `AuditedAction`), so a log entry can never disagree with what was actually
 * persisted.
 *
 * Four deliberate choices:
 *
 * - **No foreign key on `projectId`**, and a nullable, non-cascading `userId`.
 *   Deleting a project or a user is exactly the event you most want a record of,
 *   so the record must outlive its subject. A cascade would erase the evidence
 *   along with the thing.
 * - **No `updatedAt`** — rows are immutable. Nothing in the app updates one.
 * - **`withTimezone`** on `createdAt`, like every other timestamp in the schema.
 *   Audit queries are time-range queries, so an offset bug here is not cosmetic.
 * - **Two indexes.** `audit:sweep` sweeps by `createdAt` alone, while
 *   `audit:list` always filters by project first — a `createdAt`-only index makes
 *   that scan every project's rows in the window instead of one project's.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id),
    projectId: integer("project_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetPath: text("target_path"),
    metadata: jsonb("metadata")
      .notNull()
      .default({})
      .$type<Record<string, unknown>>(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    createdAtIndex: index("audit_logs_created_at_idx").on(t.createdAt),
    projectCreatedAtIndex: index("audit_logs_project_created_at_idx").on(
      t.projectId,
      t.createdAt,
    ),
  }),
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
