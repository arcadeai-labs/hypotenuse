import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { EncryptedSecret } from "../ops/CryptoOps";
import { bots } from "./bots";
import { projects } from "./projects";
import { users } from "./users";

/** Every status an installation can be in. */
export const INSTALLATION_STATUSES = [
  "pending",
  "active",
  "error",
  "uninstalled",
] as const;

/** One of {@link INSTALLATION_STATUSES}. */
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

/**
 * A `bot_installation` is one bot's own app on one platform workspace: each
 * bot is its own Slack app, its own Linear app, its own webhook endpoint.
 *
 * - `routingKeyHash` — the SHA-256 of the random routing key in the
 *   installation's webhook URL (`/api/webhooks/<type>/<routingKey>`). The key
 *   itself is shown once, when the manifest is minted, and never stored.
 * - `credentials` — the platform secrets (bot token, signing secret, OAuth
 *   tokens), sealed with `CryptoOps` as one JSON document, shaped by the
 *   adapter's `credentialSchema`. **Never serialized.** `credentialVersion`
 *   counts how many times they were replaced.
 * - `config` — the adapter's non-secret settings (`installationSchema`), such
 *   as the webhook platform's `deliveryUrl`.
 * - `externalBotUserId` — the bot's own identity on the platform, recorded by
 *   `bot-installation:test` and read by loop filtering.
 * - `status` — `pending` until credentials arrive, `active` once they do,
 *   `error` when a probe or a send says they no longer work, `uninstalled`
 *   when the platform or a person removed it. Only `active` takes deliveries.
 */
export const botInstallations = pgTable(
  "bot_installations",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    botId: integer("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    externalWorkspaceId: text("external_workspace_id").notNull(),
    externalAppId: text("external_app_id"),
    externalBotUserId: text("external_bot_user_id"),
    config: jsonb("config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    credentials: jsonb("credentials").$type<EncryptedSecret>(),
    credentialVersion: integer("credential_version").notNull().default(0),
    routingKeyHash: text("routing_key_hash").notNull(),
    status: text("status")
      .$type<InstallationStatus>()
      .notNull()
      .default("pending"),
    lastError: text("last_error"),
    installedByUserId: integer("installed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("bot_installations_routing_idx").on(t.routingKeyHash),
    uniqueIndex("bot_installations_bot_workspace_idx").on(
      t.botId,
      t.type,
      t.externalWorkspaceId,
    ),
    index("bot_installations_project_idx").on(t.projectId),
  ],
);

export type BotInstallation = typeof botInstallations.$inferSelect;
export type NewBotInstallation = typeof botInstallations.$inferInsert;
