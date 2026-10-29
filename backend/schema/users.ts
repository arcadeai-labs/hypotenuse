import { pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * A `user` is a person who signs in to Hypotenuse. Email is the only identity
 * constraint: it is unique, and every action lowercases it before it reaches the
 * database, so the constraint is case-insensitive in practice. `name` is
 * deliberately **not** unique — it is a display name.
 *
 * A platform sender (someone posting in a Slack channel) is never a `users` row;
 * `userId` always means a Hypotenuse user.
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 256 }).notNull(),
  email: text("email").notNull().unique(),
  password_hash: text("password_hash").notNull(),
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
