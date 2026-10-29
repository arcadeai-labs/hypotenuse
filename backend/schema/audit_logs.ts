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

/** Who made the decision an audit row records. */
export const AUDIT_ACTOR_TYPES = ["user", "participant", "system"] as const;

/** One of {@link AUDIT_ACTOR_TYPES}. */
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * An `audit_log` records one decision: who made it (`actorType`, plus `userId`
 * for a Hypotenuse user or `participantId` for a person on a platform), in
 * which organization and project, what action (`action`, e.g. `"tag:edit"`), the scrubbed
 * action params (`metadata`), and before/after snapshots of the affected entity.
 * Rows are written inside the **same transaction** as the change they describe
 * (see `AuditedAction`), so a log entry can never disagree with what was actually
 * persisted.
 *
 * Four deliberate choices:
 *
 * - **No foreign key on `organizationId`, `projectId`, or `participantId`**, and
 *   a nullable, non-cascading `userId`. Deleting an organization, a project, or
 *   a user is exactly the event you most want a record of, so the record must
 *   outlive its subject. A cascade would erase the evidence along with the
 *   thing.
 * - **No `updatedAt`** — rows are immutable. Nothing in the app updates one.
 * - **`withTimezone`** on `createdAt`, like every other timestamp in the schema.
 *   Audit queries are time-range queries, so an offset bug here is not cosmetic.
 * - **Three indexes.** `audit:sweep` sweeps by `createdAt` alone, while
 *   `audit:list` always filters by project first and `organization:audit-list`
 *   by organization — a `createdAt`-only index makes those scan every tenant's
 *   rows in the window instead of one tenant's.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id"),
    projectId: integer("project_id"),
    actorType: text("actor_type").$type<AuditActorType>().notNull(),
    userId: integer("user_id").references(() => users.id),
    /** A platform sender; `participants` arrives with the channel framework. */
    participantId: integer("participant_id"),
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
  (t) => [
    index("audit_logs_created_at_idx").on(t.createdAt),
    index("audit_logs_project_created_at_idx").on(t.projectId, t.createdAt),
    index("audit_logs_organization_created_at_idx").on(
      t.organizationId,
      t.createdAt,
    ),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
