import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";
import { users } from "./users";

/** One argument a skill takes. */
export interface SkillArgument {
  name: string;
  description?: string;
  required: boolean;
  default?: string;
}

/**
 * A `skill` is a project-wide procedure — a name, a one-line description, the
 * arguments it takes, and a template body — that people write and bots
 * follow. Its text lives in `skill_versions`; the row carries the current
 * version's description and arguments for listing.
 *
 * - `name` is unique per project and is what `/<name>` and `use_skill` call.
 * - `accessRead` / `accessWrite` are tag-name lists read only through
 *   `AccessOps`: who may see the skill (and attach it), and who may change it.
 */
export const skills = pgTable(
  "skills",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    description: varchar("description", { length: 280 }).notNull(),
    arguments: jsonb("arguments")
      .$type<SkillArgument[]>()
      .notNull()
      .default([]),
    currentVersion: integer("current_version").notNull().default(1),
    accessRead: jsonb("access_read").$type<string[]>().notNull().default([]),
    accessWrite: jsonb("access_write").$type<string[]>().notNull().default([]),
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
  (t) => [uniqueIndex("skills_project_name_idx").on(t.projectId, t.name)],
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;

/** One version of a skill: its description, arguments, and body as they were. */
export const skillVersions = pgTable(
  "skill_versions",
  {
    id: serial("id").primaryKey(),
    skillId: integer("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    description: varchar("description", { length: 280 }).notNull(),
    arguments: jsonb("arguments")
      .$type<SkillArgument[]>()
      .notNull()
      .default([]),
    body: text("body").notNull(),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    changeNote: text("change_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("skill_versions_skill_version_idx").on(t.skillId, t.version),
  ],
);

export type SkillVersion = typeof skillVersions.$inferSelect;
export type NewSkillVersion = typeof skillVersions.$inferInsert;
