import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { botInstallations } from "./bot_installations";
import { bots } from "./bots";
import { projects } from "./projects";

/**
 * The kinds of channel a conversation can belong to: the HTTP API, the
 * dashboard chat (`web`), and each platform with an adapter.
 */
export const CHANNEL_TYPES = ["api", "web", "webhook"] as const;

/** One of {@link CHANNEL_TYPES}. */
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/**
 * A `channel` is a place a bot works in, and the memory boundary of
 * everything said there, keyed by `(projectId, type, externalId)` so a
 * replayed event is an upsert.
 *
 * | Type | `externalId` | `botId` | `botInstallationId` |
 * |---|---|---|---|
 * | `api` | `bot:<botId>:<key>` | the bot | null |
 * | `web` (the dashboard chat) | `bot:<botId>:dashboard` or `bot:<botId>:scratch-<8 hex>` | the bot | null |
 * | a platform (`webhook`, …) | `<externalWorkspaceId>/<the platform's channel id>` | null: shared by every bot bound to it | the installation that first saw it |
 *
 * `parentExternalId` is a platform's grouping (a Linear team above a
 * project). `isPrivate` and `isShared` (externally shared, Slack Connect)
 * decide `autoBind` and the shared-channel rule; `archived` is set when the
 * platform archives it. `details` is what the platform knows about the
 * channel beyond its name (a Pylon account's `domains`), refreshed on every
 * delivery that names it.
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
    botInstallationId: integer("bot_installation_id").references(
      () => botInstallations.id,
      { onDelete: "set null" },
    ),
    parentExternalId: text("parent_external_id"),
    name: text("name").notNull(),
    isPrivate: boolean("is_private").notNull().default(false),
    isShared: boolean("is_shared").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
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
