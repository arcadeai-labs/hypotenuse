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

/** Whether a connection's key last worked: never checked, worked, or failed. */
export const MODEL_CONNECTION_STATUSES = ["unverified", "ok", "error"] as const;

/** One of {@link MODEL_CONNECTION_STATUSES}. */
export type ModelConnectionStatus = (typeof MODEL_CONNECTION_STATUSES)[number];

/**
 * A `model_connection` is one model provider a project pays for: a provider
 * kind from `models/registry.ts`, an optional base URL, and an API key.
 *
 * The key is sealed with AES-256-GCM (`CryptoOps.encryptSecret`) into `secret`
 * and is never returned: `serializeModelConnection` has no field it fits in,
 * and `lastFour` is the only part of it any answer carries. It is decrypted at
 * the call that uses it, in the process making that call.
 *
 * `status`, `lastCheckedAt`, and `lastError` record the last probe
 * (`model-connection:test`, and every create or key rotation). A bot never names
 * a connection; it names a `model_aliases` row, which names one of these.
 */
export const modelConnections = pgTable(
  "model_connections",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    provider: text("provider").notNull(),
    baseUrl: text("base_url"),
    secret: jsonb("secret").$type<EncryptedSecret>().notNull(),
    lastFour: varchar("last_four", { length: 4 }).notNull(),
    status: text("status")
      .$type<ModelConnectionStatus>()
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
    uniqueIndex("model_connections_project_name_idx").on(t.projectId, t.name),
  ],
);

export type ModelConnection = typeof modelConnections.$inferSelect;
export type NewModelConnection = typeof modelConnections.$inferInsert;
