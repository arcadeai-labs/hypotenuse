import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { integrations, type TriggerType } from "./integrations";
import { users } from "./users";

/** How a trigger-system user came to be linked to a Hypotenuse user. */
export const IDENTITY_LINKED_VIA = ["email", "oauth", "admin"] as const;

/** One of {@link IDENTITY_LINKED_VIA}. */
export type IdentityLinkedVia = (typeof IDENTITY_LINKED_VIA)[number];

/**
 * An `external_identity` says which Hypotenuse user a person in a trigger
 * system is — a Linear user, in one workspace. Routing reads it to prefer the
 * issuer's own runners.
 *
 * It is a **preference, never an authorization**: it only reorders runners
 * that are already eligible in the same project. That is why an e-mail match
 * (`linkedVia = email`) is recorded without the person proving anything, and
 * why it is visible and removable.
 */
export const externalIdentities = pgTable(
  "external_identities",
  {
    id: serial("id").primaryKey(),
    type: text("type").$type<TriggerType>().notNull(),
    integrationId: integer("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    externalUserId: text("external_user_id").notNull(),
    externalName: text("external_name"),
    externalEmail: text("external_email"),
    linkedVia: text("linked_via").$type<IdentityLinkedVia>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    externalUserIndex: uniqueIndex("external_identities_external_user_idx").on(
      t.integrationId,
      t.externalUserId,
    ),
    userIndex: index("external_identities_user_idx").on(t.userId),
  }),
);

export type ExternalIdentity = typeof externalIdentities.$inferSelect;
export type NewExternalIdentity = typeof externalIdentities.$inferInsert;
