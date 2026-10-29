import { pgTable, serial, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * An `organization` is the top of the tenancy tree: it holds **members and
 * projects, nothing else**. Platform installs, model keys, MCP servers, memory,
 * bots, and skills all belong to a project, so an organization adds two levels
 * of standing (member, owner) and a containment rule, and never touches the
 * project RBAC.
 *
 * `slug` is unique across the deployment, because it is how an organization is
 * named in a URL a person shares; `name` is a display name and is not.
 *
 * **Every timestamp column in this app is `{ withTimezone: true }`.** Drizzle
 * writes and reads a naked `timestamp` as UTC while `defaultNow()` resolves in
 * the server's zone, so on a machine that is not UTC a row reads back hours away
 * from when it was written. A `timestamptz` stores an instant.
 */
export const organizations = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 256 }).notNull(),
  slug: varchar("slug", { length: 256 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date()),
});

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
