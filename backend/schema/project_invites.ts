import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { projects } from "./projects";
import { users } from "./users";

/**
 * A `project_invite` invites an email address into an organization, and
 * optionally into one of its projects with a set of tags.
 *
 * - With a `projectId` it is a **project invite**, written by a project admin.
 *   Accepting it creates the organization membership too, when it is missing.
 * - Without one it is an **organization invite**, written by an owner, that
 *   grants only the organization membership.
 *
 * One table rather than two because both kinds share one lifecycle: accepted by
 * email match, idempotent, expired after five days, collected by one sweep.
 * No email is sent; an invite surfaces in-app to the invitee on their next
 * sign-in, keyed on the lowercased email, so a brand-new signup sees it at once.
 *
 * `inviterEmail`, `organizationName`, and `projectName` are denormalized so the
 * invitee's card renders without joins into tenants they cannot read yet.
 * `tagIds` is a typed `jsonb` array rather than a join table: invites are
 * short-lived and never queried by tag.
 */
export const projectInvites = pgTable(
  "project_invites",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: integer("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    inviterUserId: integer("inviter_user_id")
      .notNull()
      .references(() => users.id),
    inviteeEmail: text("invitee_email").notNull(),
    tagIds: jsonb("tag_ids").$type<number[]>().notNull().default([]),
    status: text("status").notNull().default("pending"),
    inviterEmail: text("inviter_email").notNull(),
    organizationName: text("organization_name").notNull(),
    projectName: text("project_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("invite_invitee_email_idx").on(t.inviteeEmail),
    index("invite_organization_idx").on(t.organizationId),
    index("invite_project_idx").on(t.projectId),
  ],
);

export type ProjectInvite = typeof projectInvites.$inferSelect;
export type NewProjectInvite = typeof projectInvites.$inferInsert;
