import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * A `cli_token` is one signed-in `hypotenuse` CLI: the credential a person's
 * terminal presents as `Authorization: Bearer hyp_cli_…` after they approved it
 * in the dashboard. It acts as its person on every human action and on nothing
 * else.
 *
 * Only the sha256 of the token is stored. The plaintext exists once, in the
 * `cli-auth:exchange` response, and then only in the CLI's `credentials.json`.
 * `lastFour` is what the Account page shows so a person can tell two sign-ins on
 * the same machine apart.
 *
 * Expiry slides: each use more than a day after the last one moves `expiresAt`
 * forward by the configured lifetime, so a CLI that is used stays signed in and
 * one that is forgotten lapses on its own. `revokedAt` is set by
 * `cli-token:revoke` (and so by `hypotenuse logout`); a revoked row is kept so the
 * audit trail's target still resolves.
 */
export const cliTokens = pgTable(
  "cli_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    device: varchar("device", { length: 256 }).notNull(),
    tokenHash: text("token_hash").notNull(),
    lastFour: varchar("last_four", { length: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    tokenHashIndex: uniqueIndex("cli_tokens_token_hash_idx").on(t.tokenHash),
    userIndex: index("cli_tokens_user_idx").on(t.userId),
  }),
);

export type CliToken = typeof cliTokens.$inferSelect;
export type NewCliToken = typeof cliTokens.$inferInsert;
