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
import { integrations, type TriggerType } from "./integrations";
import { projects } from "./projects";

/**
 * Every status Linear gives an agent session. Linear derives it from the last
 * activity; the mirror copies what Linear reports and what our own delivered
 * activities imply, and never asserts one of its own.
 */
export const AGENT_SESSION_STATUSES = [
  "pending",
  "active",
  "awaitingInput",
  "error",
  "complete",
  "stale",
  "stopping",
] as const;

/** One of {@link AGENT_SESSION_STATUSES}. */
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

/** How a session came to exist. */
export const AGENT_SESSION_ORIGINS = [
  "delegation",
  "mention",
  "proactive",
] as const;

/** One of {@link AGENT_SESSION_ORIGINS}. */
export type AgentSessionOrigin = (typeof AGENT_SESSION_ORIGINS)[number];

/** The two roles one Linear app plays. */
export const AGENT_SESSION_ROLES = ["manager", "worker"] as const;

/** One of {@link AGENT_SESSION_ROLES}. */
export type AgentSessionRole = (typeof AGENT_SESSION_ROLES)[number];

/** One piece of workspace or team guidance, as Linear sends it. */
export interface AgentSessionGuidance {
  body: string;
  origin: { type: string; team?: Record<string, unknown> } | null;
}

/** One step of a session's plan, in Linear's shape. */
export interface AgentSessionPlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

/** One external link on a session. */
export interface AgentSessionExternalUrl {
  label: string;
  url: string;
}

/**
 * An `agent_session` mirrors one agent session in a trigger system — today a
 * Linear agent session: the conversation between a person and `@hypotenuse`
 * on one issue. `type` says which system; every id that system owns is in an
 * `external*` column.
 *
 * - **Keyed by the trigger's id** (`(type, externalSessionId)` unique), so a
 *   replayed `created` is an upsert and a session Hypotenuse started itself is
 *   found when Linear's `created` for it arrives.
 * - **The creator is null** when an automation or another agent started the
 *   session — a fact routing and issue hygiene both read.
 * - **`role`, `repository`, and `runnerId` are routing's**, null until routing
 *   chooses them; `runnerId` is the sticky runner holding the worktree.
 * - **`summary`, `plan`, `externalUrls`** are the last values Hypotenuse wrote.
 *
 * Its activities, both directions, are `agent_activities`.
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").$type<TriggerType>().notNull(),
    integrationId: integer("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    /** The session's id in the trigger system. */
    externalSessionId: text("external_session_id").notNull(),
    /** The trigger system's own page for the session. */
    externalUrl: text("external_url"),
    externalIssueId: text("external_issue_id").notNull(),
    issueIdentifier: text("issue_identifier"),
    issueTitle: text("issue_title"),
    issueUrl: text("issue_url"),
    externalTeamId: text("external_team_id"),
    teamKey: text("team_key"),
    /** The thread's root comment, when a mention started the session. */
    externalCommentId: text("external_comment_id"),
    /** The comment that mentioned the agent (a child, for a mid-thread mention). */
    externalSourceCommentId: text("external_source_comment_id"),
    creatorExternalUserId: text("creator_external_user_id"),
    creatorName: text("creator_name"),
    creatorEmail: text("creator_email"),
    origin: text("origin").$type<AgentSessionOrigin>().notNull(),
    /** Linear's context block, verbatim. */
    promptContext: text("prompt_context"),
    guidance: jsonb("guidance").$type<AgentSessionGuidance[] | null>(),
    /** Present only for a mention in a child comment. */
    previousComments: jsonb("previous_comments").$type<
      Record<string, unknown>[] | null
    >(),
    role: text("role").$type<AgentSessionRole | null>(),
    /** `hostname/owner/name`. */
    repository: text("repository"),
    runnerId: integer("runner_id"),
    status: text("status")
      .$type<AgentSessionStatus>()
      .notNull()
      .default("pending"),
    summary: text("summary"),
    plan: jsonb("plan").$type<AgentSessionPlanStep[] | null>(),
    externalUrls: jsonb("external_urls")
      .$type<AgentSessionExternalUrl[]>()
      .notNull()
      .default([]),
    /**
     * When a person removed `@hypotenuse` as the issue's delegate — which is
     * also what dismissing a session does. Read by cancellation, which stops
     * the live turn.
     */
    delegateRemovedAt: timestamp("delegate_removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => ({
    externalSessionIndex: uniqueIndex("agent_sessions_external_session_idx").on(
      t.type,
      t.externalSessionId,
    ),
    // `agent-session:list` by project, filtered by status.
    projectStatusIndex: index("agent_sessions_project_status_idx").on(
      t.projectId,
      t.status,
    ),
    // Issue events find the sessions on an issue.
    issueIndex: index("agent_sessions_issue_idx").on(t.type, t.externalIssueId),
  }),
);

export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;
