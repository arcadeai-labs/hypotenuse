import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { projects } from "./projects";

/** The kinds of channel a conversation can belong to. Only `api` exists yet. */
export const CHANNEL_TYPES = ["api"] as const;

/** One of {@link CHANNEL_TYPES}. */
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/**
 * A `channel` is a place a bot works in, and the memory boundary of
 * everything said there. For now there is one kind: the **API channel**, one
 * per bot and caller-chosen key (`externalId` is `bot:<botId>:<key>`), which
 * holds the conversations created over HTTP. Platform channels (a Slack
 * channel, a Linear project, a Pylon account) arrive with the channel
 * framework and share this table, keyed by `(projectId, type, externalId)`
 * so a replayed event is an upsert.
 *
 * `botId` is set for an API channel, which belongs to one bot; a platform
 * channel is shared by every bot bound to it and leaves it null.
 */
export const channels = pgTable(
  "channels",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    externalId: text("external_id").notNull(),
    botId: integer("bot_id").references(() => bots.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("channels_project_type_external_idx").on(
      t.projectId,
      t.type,
      t.externalId,
    ),
  ],
);

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
