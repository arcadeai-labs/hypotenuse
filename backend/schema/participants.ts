import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";

/**
 * A `participant` is a person (or another bot) on a platform who wrote to a
 * bot: recorded by the platform's own ids and display name, and **never
 * linked** to a Hypotenuse user. The platform's permissions are what let them
 * talk; this row is how the transcript, an approval, and an audit row name
 * them.
 */
export const participants = pgTable(
  "participants",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    externalWorkspaceId: text("external_workspace_id").notNull(),
    externalUserId: text("external_user_id").notNull(),
    displayName: text("display_name").notNull(),
    isBot: boolean("is_bot").notNull().default(false),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("participants_external_idx").on(
      t.projectId,
      t.type,
      t.externalWorkspaceId,
      t.externalUserId,
    ),
  ],
);

export type Participant = typeof participants.$inferSelect;
export type NewParticipant = typeof participants.$inferInsert;
