import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { channels } from "./channels";
import { projects } from "./projects";
import { users } from "./users";

/** How a bound bot listens in a channel. */
export const BINDING_MODES = ["mentions", "all", "dm"] as const;
/** One of {@link BINDING_MODES}. */
export type BindingMode = (typeof BINDING_MODES)[number];

/** Who may decide a tool-call approval from inside the channel. */
export const APPROVAL_POLICIES = [
  "dashboard",
  "participants",
  "listed",
] as const;
/** One of {@link APPROVAL_POLICIES}. */
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

/**
 * A `channel_binding` is where a bot listens, and how: the one decision that
 * lets a platform channel talk to a bot. Being in the channel is the
 * permission to talk; the binding is a person's decision (or the bot's
 * `autoBind` default for public channels, `autoBound: true`) that the bot
 * listens there — and that the bot's readers in the dashboard may read what
 * the channel says to it.
 *
 * - `mode` — `mentions`: only messages that address the bot (and replies in a
 *   thread it is already in); `all`: every message; `dm`: a direct message.
 * - `defaultDelivery` — how a message enters a running turn (`steer` / `queue`).
 * - `approvalPolicy` — `dashboard` (no in-channel decision), `participants`
 *   (anyone in the channel), or `listed` (`approverExternalIds` only).
 * - `allowPromotion` — whether facts from this channel may be promoted to
 *   project memory; `allowShared` — whether an externally shared channel is
 *   served.
 */
export const channelBindings = pgTable(
  "channel_bindings",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    botId: integer("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    mode: text("mode").$type<BindingMode>().notNull().default("mentions"),
    defaultDelivery: text("default_delivery")
      .$type<"steer" | "queue">()
      .notNull()
      .default("steer"),
    approvalPolicy: text("approval_policy")
      .$type<ApprovalPolicy>()
      .notNull()
      .default("dashboard"),
    approverExternalIds: jsonb("approver_external_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    allowPromotion: boolean("allow_promotion").notNull().default(false),
    allowShared: boolean("allow_shared").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    autoBound: boolean("auto_bound").notNull().default(false),
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("channel_bindings_bot_channel_idx").on(t.botId, t.channelId),
    index("channel_bindings_project_idx").on(t.projectId),
  ],
);

export type ChannelBinding = typeof channelBindings.$inferSelect;
export type NewChannelBinding = typeof channelBindings.$inferInsert;
