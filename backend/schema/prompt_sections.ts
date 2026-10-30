import { sql } from "drizzle-orm";
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
  varchar,
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { projects } from "./projects";
import { users } from "./users";

/** Where a section applies: one bot, or every bot of the project. */
export const PROMPT_SECTION_SCOPES = ["bot", "project"] as const;
export type PromptSectionScope = (typeof PROMPT_SECTION_SCOPES)[number];

/** When a section is included: every step, or when its keywords match. */
export const PROMPT_SECTION_LOADINGS = ["always", "contextual"] as const;
export type PromptSectionLoading = (typeof PROMPT_SECTION_LOADINGS)[number];

/** Who wrote a section's version. */
export const PROMPT_VERSION_SOURCES = [
  "seed",
  "person",
  "agent",
  "revert",
] as const;
export type PromptVersionSource = (typeof PROMPT_VERSION_SOURCES)[number];

/**
 * A `prompt_section` is one titled part of a bot's system prompt, or of every
 * bot's in a project. Its text lives in `prompt_section_versions`; the row
 * holds what decides whether and where the text is included.
 *
 * - `scope` `bot` carries a `botId`; `project` leaves it null and is included
 *   in every bot of the project, and no bot can change it.
 * - `key` is unique per bot (or per project, for project sections). The seed
 *   keys are `identity`, `how-i-work`, and `things-i-have-learned`; `identity`
 *   is never editable by the bot and cannot be deleted.
 * - `loading` `always` is included in every step; `contextual` only when one of
 *   its `keywords` (its title's words when empty) matches the turn's context
 *   terms.
 * - `agentEditable` lets the bot itself change the section with `prompt_edit`.
 * - `origin` is who created it: `seed` (every new bot's three), `person`, or
 *   `agent` (`prompt_create`, capped per bot by `bots.maxAgentSections`).
 * - `currentVersion` names the version in use; `archived` hides a deleted
 *   section while keeping every version it had.
 */
export const promptSections = pgTable(
  "prompt_sections",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scope: text("scope").$type<PromptSectionScope>().notNull(),
    botId: integer("bot_id").references(() => bots.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 64 }).notNull(),
    title: varchar("title", { length: 120 }).notNull(),
    loading: text("loading").$type<PromptSectionLoading>().notNull(),
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    agentEditable: boolean("agent_editable").notNull().default(false),
    position: integer("position").notNull().default(0),
    origin: text("origin").$type<"seed" | "person" | "agent">().notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("prompt_sections_owner_key_idx").on(
      t.projectId,
      sql`coalesce(${t.botId}, 0)`,
      t.key,
    ),
    index("prompt_sections_bot_idx").on(t.botId),
  ],
);

export type PromptSection = typeof promptSections.$inferSelect;
export type NewPromptSection = typeof promptSections.$inferInsert;

/**
 * One version of a section: its title and body as they were, who wrote it,
 * and — for a bot's own edit — the conversation and the intent entry that
 * caused it (copied ids, not foreign keys, as a ledger keeps them). Rows are
 * never changed; a revert writes a new version with the old text.
 */
export const promptSectionVersions = pgTable(
  "prompt_section_versions",
  {
    id: serial("id").primaryKey(),
    sectionId: integer("section_id")
      .notNull()
      .references(() => promptSections.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: varchar("title", { length: 120 }).notNull(),
    body: text("body").notNull(),
    source: text("source").$type<PromptVersionSource>().notNull(),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    conversationId: integer("conversation_id"),
    entryId: integer("entry_id"),
    changeNote: text("change_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("prompt_section_versions_section_version_idx").on(
      t.sectionId,
      t.version,
    ),
    index("prompt_section_versions_entry_idx").on(t.entryId),
  ],
);

export type PromptSectionVersion = typeof promptSectionVersions.$inferSelect;
export type NewPromptSectionVersion = typeof promptSectionVersions.$inferInsert;
