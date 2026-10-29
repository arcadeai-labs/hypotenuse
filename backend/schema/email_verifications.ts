import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * One emailed proof-of-address link: a person's sign-up address, or an address
 * they asked to change to. Only the token's SHA-256 is stored, so a read of this
 * table cannot verify anyone. A token works once, until `expiresAt`, and only
 * for the address it was sent to — if the person's address changed since, it no
 * longer matches and is refused.
 */
export const emailVerifications = pgTable(
  "email_verifications",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The address the link was sent to, lowercased. */
    email: text("email").notNull(),
    /** Hex SHA-256 of the token in the link. */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("email_verification_user_idx").on(t.userId)],
);

export type EmailVerification = typeof emailVerifications.$inferSelect;
