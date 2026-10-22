import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { AgentSessionRole } from "./agent_sessions";
import { projects } from "./projects";

/**
 * What a routing rule matches. Every present field must match (AND); an absent
 * field matches anything.
 */
export interface RoutingMatch {
  /** The issue carries any of these labels (case-insensitive). */
  labels?: string[];
  /** The issue's team key is one of these. */
  teamKeys?: string[];
  /** The issue is in one of these trigger-system projects. */
  projectIds?: string[];
  /** The triggering text starts with this token, e.g. `/manage`. */
  promptPrefix?: string;
  /** The issue is (or is not) a sub-issue. */
  hasParent?: boolean;
  /**
   * The issue's project has (or has not) any content — the long description
   * a PRD is written in. An issue in no project matches neither.
   */
  projectHasContent?: boolean;
  /** How the session started. */
  origin?: "delegation" | "mention";
}

/**
 * A `routing_rule` decides which role answers a new session. A project's
 * enabled rules are evaluated in `position` order and the first that matches
 * wins; when none does, the role is `worker`. Four rules are seeded when a
 * project first connects Linear (`SEEDED_RULES` in `ops/RoutingOps.ts`), so
 * the whole decision is one list an admin can read and edit.
 *
 * `repository` optionally pins the repository too, bypassing repository
 * selection.
 */
export const routingRules = pgTable(
  "routing_rules",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    match: jsonb("match").$type<RoutingMatch>().notNull().default({}),
    role: text("role").$type<AgentSessionRole>().notNull(),
    /** `hostname/owner/name`, or null. */
    repository: text("repository"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    projectPositionIndex: index("routing_rules_project_position_idx").on(
      t.projectId,
      t.position,
    ),
  }),
);

export type RoutingRule = typeof routingRules.$inferSelect;
export type NewRoutingRule = typeof routingRules.$inferInsert;
