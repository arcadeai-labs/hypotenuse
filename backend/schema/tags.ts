import { sql } from "drizzle-orm";
import {
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";

/**
 * A `tag` is a named, project-scoped role. There is no role ladder: access is
 * granted to sets of tags, and a tag means nothing until an object's
 * `accessRead` / `accessWrite` list names it. The reserved `admin` tag, created
 * with every project, confers administrative rights; the tag actions refuse to
 * create, rename, or delete it.
 *
 * Names are unique per project **after normalization** (trimmed, lowercased),
 * because every comparison in the app is normalized: `Finance` and ` finance`
 * would otherwise be two tags that one access list cannot tell apart.
 */
export const tags = pgTable(
  "tags",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 256 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("tag_project_normalized_name_idx").on(
      t.projectId,
      sql`lower(btrim(${t.name}))`,
    ),
  ],
);

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
