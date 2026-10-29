import { pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * A `user` is a person who signs in to Hypotenuse. Email is the only identity
 * constraint: it is unique, and every action lowercases it before it reaches the
 * database, so the constraint is case-insensitive in practice. `name` is
 * deliberately **not** unique — it is a display name.
 *
 * A platform sender (someone posting in a Slack channel) is never a `users` row;
 * `userId` always means a Hypotenuse user.
 *
 * `emailVerifiedAt` is when the person proved they read `email`, by following a
 * link mailed to it; until then they cannot see or answer invitations, which
 * are addressed by email. `pendingEmail` is an address they asked to change to
 * and have not confirmed yet: `email` changes only when they do, so nobody can
 * take an address by switching to it.
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 256 }).notNull(),
  email: text("email").notNull().unique(),
  password_hash: text("password_hash").notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  pendingEmail: text("pending_email"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date()),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
