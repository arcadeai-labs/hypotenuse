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
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { channels } from "./channels";
import { projects } from "./projects";
import { users } from "./users";

/** The two places a memory lives. */
export const MEMORY_SCOPES = ["channel", "project"] as const;

/** One of {@link MEMORY_SCOPES}. */
export type MemoryScopeName = (typeof MEMORY_SCOPES)[number];

/** Who or what wrote a version. */
export const MEMORY_SOURCE_TYPES = [
  "agent",
  "person",
  "consolidation",
  "promotion",
  "decay",
] as const;

/** One of {@link MEMORY_SOURCE_TYPES}. */
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

/**
 * Where a version came from, by `sourceType`:
 *
 * - `agent`: the bot wrote it with a tool, in `conversationId`, from the call
 *   whose intent is entry `seq` (`toolCallId` dedupes a retried write).
 * - `consolidation`: facts drawn from `conversationId`'s entries `seqs`.
 * - `person`: `userId` wrote it from the explorer, the API, or the CLI.
 * - `promotion`: copied from the channel version `promotedFromId` (a
 *   `memory_documents.id`), by `userId`.
 * - `decay`: the decay clock tombstoned it; nothing more to say.
 */
export interface MemorySourceRef {
  conversationId?: number;
  seqs?: number[];
  toolCallId?: string;
  userId?: number;
  promotedFromId?: number;
  promotedFromBotId?: number;
  promotedFromChannelId?: number;
}

/**
 * A `memory_document` row is **one version** of a markdown document a bot
 * remembers, addressed by its scope and `logicalPath` (`people/alex.md`).
 *
 * - `scope = 'project'`: `botId` and `channelId` are null; every bot and
 *   channel of the project reads it.
 * - `scope = 'channel'`: both set; only that bot, in that channel, reads it.
 *   The pair is the memory boundary, and every query names it in its `WHERE`.
 *
 * History is append-only: a write or edit inserts a new row with a later
 * `versionId` and clears `isCurrent` on the one before; a forget inserts a
 * `tombstone`. Exactly one row per document is current (a partial unique
 * index). Only the decay clock deletes rows, and never a current one.
 *
 * `pinned`, `lastAccessedAt`, and `accessCount` belong to the document, so a
 * new version carries them over from the one it replaces; search reads them
 * from the current row.
 */
export const memoryDocuments = pgTable(
  "memory_documents",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scope: text("scope").$type<MemoryScopeName>().notNull(),
    botId: integer("bot_id").references(() => bots.id, {
      onDelete: "cascade",
    }),
    channelId: integer("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    logicalPath: text("logical_path").notNull(),
    versionId: timestamp("version_id", {
      withTimezone: true,
      precision: 3,
    }).notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    tombstone: boolean("tombstone").notNull().default(false),
    content: text("content").notNull(),
    description: text("description").notNull().default(""),
    changeNote: text("change_note"),
    pinned: boolean("pinned").notNull().default(false),
    sourceType: text("source_type").$type<MemorySourceType>().notNull(),
    sourceRef: jsonb("source_ref").$type<MemorySourceRef>().notNull(),
    authorUserId: integer("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    accessCount: integer("access_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("memory_documents_version_idx").on(
      t.projectId,
      t.scope,
      sql`coalesce(${t.botId}, 0)`,
      sql`coalesce(${t.channelId}, 0)`,
      t.logicalPath,
      t.versionId,
    ),
    uniqueIndex("memory_documents_current_idx")
      .on(
        t.projectId,
        t.scope,
        sql`coalesce(${t.botId}, 0)`,
        sql`coalesce(${t.channelId}, 0)`,
        t.logicalPath,
      )
      .where(sql`${t.isCurrent}`),
    index("memory_documents_channel_idx").on(t.botId, t.channelId),
  ],
);

export type MemoryDocument = typeof memoryDocuments.$inferSelect;
export type NewMemoryDocument = typeof memoryDocuments.$inferInsert;
