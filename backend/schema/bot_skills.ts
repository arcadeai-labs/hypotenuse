import {
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { skills } from "./skills";

/**
 * A `bot_skill` attaches one of the project's skills to a bot. The bot uses
 * the skill's current version, or `pinnedVersion` when it is set.
 */
export const botSkills = pgTable(
  "bot_skills",
  {
    id: serial("id").primaryKey(),
    botId: integer("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    skillId: integer("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    pinnedVersion: integer("pinned_version"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("bot_skills_bot_skill_idx").on(t.botId, t.skillId)],
);

export type BotSkill = typeof botSkills.$inferSelect;
export type NewBotSkill = typeof botSkills.$inferInsert;
