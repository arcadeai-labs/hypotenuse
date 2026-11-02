import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import type { EncryptedSecret } from "../ops/CryptoOps";
import { projects } from "./projects";
import { users } from "./users";

/** Whether a connection last probed: never checked, worked, or failed. */
export const PROJECT_CONNECTION_STATUSES = [
  "unverified",
  "ok",
  "error",
] as const;

/** One of {@link PROJECT_CONNECTION_STATUSES}. */
export type ProjectConnectionStatus =
  (typeof PROJECT_CONNECTION_STATUSES)[number];

/**
 * A `project_connection` is an account on a service a project pays for that
 * is not a model provider — today, a hosted sandbox provider. Its `kind` names
 * an entry in `connections/registry.ts`, which says which fields it takes,
 * which one is the secret, and how to probe it.
 *
 * `config` holds the kind's non-secret fields (a team id, a project id), and
 * is returned. The secret is sealed with AES-256-GCM into `secret` and never
 * returned: `serializeProjectConnection` has no field it fits in, and
 * `lastFour` is all any answer carries of it. It is decrypted in the process
 * that calls the service, at the call.
 *
 * One connection per kind per project: a project's sandbox provider names a
 * kind, and the kind finds its connection.
 */
export const projectConnections = pgTable(
  "project_connections",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    config: jsonb("config")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    secret: jsonb("secret").$type<EncryptedSecret>().notNull(),
    lastFour: varchar("last_four", { length: 4 }).notNull(),
    status: text("status")
      .$type<ProjectConnectionStatus>()
      .notNull()
      .default("unverified"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
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
    uniqueIndex("project_connections_project_kind_idx").on(t.projectId, t.kind),
  ],
);

export type ProjectConnection = typeof projectConnections.$inferSelect;
export type NewProjectConnection = typeof projectConnections.$inferInsert;
