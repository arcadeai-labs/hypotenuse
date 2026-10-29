import {
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
import { modelConnections } from "./model_connections";
import { projects } from "./projects";

/**
 * What a model alias is for. Only `language` exists; memory adds `embedding`
 * to this same table when it needs an embedding model.
 */
export const MODEL_ALIAS_KINDS = ["language"] as const;

/** One of {@link MODEL_ALIAS_KINDS}. */
export type ModelAliasKind = (typeof MODEL_ALIAS_KINDS)[number];

/** Per-alias call options, applied to every call made through the alias. */
export interface ModelAliasOptions {
  maxOutputTokens?: number;
  temperature?: number;
  /** Passed through to the provider untouched, e.g. Anthropic's thinking budget. */
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * A `model_alias` is a name a project gives a model — `default`, `fast`,
 * `reasoning` — and what the name means: which connection, which of that
 * provider's model ids, and the call options.
 *
 * Bots name aliases, never connections or model ids, so moving the project's
 * `default` to another model is one audited edit every bot follows.
 * `default` and `fast` are reserved and required before a bot can run.
 *
 * A connection an alias uses cannot be deleted: `model-connection:delete`
 * refuses first, naming the aliases, and the foreign key is the backstop.
 */
export const modelAliases = pgTable(
  "model_aliases",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    kind: text("kind").$type<ModelAliasKind>().notNull().default("language"),
    connectionId: integer("connection_id")
      .notNull()
      // `no action`, not `restrict`: it is checked at the end of the statement,
      // so deleting the project cascades through both tables.
      .references(() => modelConnections.id, { onDelete: "no action" }),
    modelId: varchar("model_id", { length: 256 }).notNull(),
    options: jsonb("options").$type<ModelAliasOptions>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("model_aliases_project_name_idx").on(t.projectId, t.name),
    index("model_aliases_connection_idx").on(t.connectionId),
  ],
);

export type ModelAlias = typeof modelAliases.$inferSelect;
export type NewModelAlias = typeof modelAliases.$inferInsert;
