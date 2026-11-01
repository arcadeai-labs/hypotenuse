import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";

/** The lifecycle states a `sandboxes` row moves through. */
export const SANDBOX_STATUSES = [
  "creating",
  "running",
  "stopped",
  "destroyed",
  "failed",
] as const;

/** One of {@link SANDBOX_STATUSES}. */
export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

/**
 * The sandbox ledger: every sandbox Hypotenuse has asked a provider for.
 *
 * A **ledger, not a cache**. A row is inserted `creating` *before* the
 * provider call and updated after; every destroy stamps `destroyedAt`. A
 * provider listing says what exists; only the ledger says what *should*, and
 * the gap between the two is the definition of a leak. A crash between the
 * insert and the provider's answer leaves a `creating` row with no
 * `externalId`, which `sandbox:orphan-sweep` reads as exactly that.
 *
 * `jobId` is nullable so a sandbox created outside a job (a provider test) is
 * still ledgered. It carries no foreign key: a ledger row outlives its job.
 */
export const sandboxes = pgTable(
  "sandboxes",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    jobId: integer("job_id"),
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    status: text("status").$type<SandboxStatus>().notNull(),
    labels: jsonb("labels")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index("sandboxes_status_created_idx").on(t.status, t.createdAt),
    index("sandboxes_external_id_idx").on(t.externalId),
    index("sandboxes_job_idx").on(t.jobId).where(sql`${t.jobId} is not null`),
  ],
);

export type SandboxRecord = typeof sandboxes.$inferSelect;
export type NewSandboxRecord = typeof sandboxes.$inferInsert;
