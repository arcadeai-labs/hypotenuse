import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/** The two organization roles, least to most privileged. */
export const ORGANIZATION_ROLES = ["member", "owner"] as const;

/** One of {@link ORGANIZATION_ROLES}. */
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/**
 * An `organization_membership` links a user to an organization with a role.
 *
 * - `member` sees the organization and only the projects they hold a project
 *   membership in. Organization membership alone grants no project visibility.
 * - `owner` additionally has admin standing in **every** project of the
 *   organization, creates projects, and administers the organization itself.
 *
 * Every project membership requires one of these in the project's organization;
 * removing this row removes those too, in the same transaction.
 */
export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").$type<OrganizationRole>().notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("organization_membership_org_user_idx").on(
      t.organizationId,
      t.userId,
    ),
    index("organization_membership_user_idx").on(t.userId),
  ],
);

export type OrganizationMembership =
  typeof organizationMemberships.$inferSelect;
export type NewOrganizationMembership =
  typeof organizationMemberships.$inferInsert;
