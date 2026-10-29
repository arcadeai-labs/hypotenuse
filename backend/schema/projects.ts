import {
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * A `project` is the tenant inside an organization: a team's own bots, platform
 * installs, memory, and members. Everything a bot touches belongs to a project.
 *
 * `organizationId` does not cascade: `organization:delete` refuses while an
 * organization still has projects, so deleting a project is always its own,
 * audited decision. `slug` is unique within the organization.
 */
export const projects = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: varchar("name", { length: 256 }).notNull(),
    slug: varchar("slug", { length: 256 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index("project_organization_idx").on(t.organizationId),
    uniqueIndex("project_organization_slug_idx").on(t.organizationId, t.slug),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
