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
import { linearInstallations } from "./linear_installations";
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
 * An `agent_session` mirrors one Linear agent session: the conversation
 * between a person and `@hypotenuse` on one issue.
 *
 * - **Keyed by Linear's id** (`linearSessionId` unique), so a replayed
 *   `created` is an upsert and a session Hypotenuse started itself is found
 *   when Linear's `created` for it arrives.
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
    installationId: integer("installation_id")
      .notNull()
      .references(() => linearInstallations.id, { onDelete: "cascade" }),
    linearSessionId: text("linear_session_id").notNull(),
    /** Linear's own page for the session. */
    linearUrl: text("linear_url"),
    linearIssueId: text("linear_issue_id").notNull(),
    issueIdentifier: text("issue_identifier"),
    issueTitle: text("issue_title"),
    issueUrl: text("issue_url"),
    teamId: text("team_id"),
    teamKey: text("team_key"),
    /** The thread's root comment, when a mention started the session. */
    linearCommentId: text("linear_comment_id"),
    /** The comment that mentioned the agent (a child, for a mid-thread mention). */
    sourceCommentId: text("source_comment_id"),
    creatorLinearUserId: text("creator_linear_user_id"),
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
    linearSessionIndex: uniqueIndex("agent_sessions_linear_session_idx").on(
      t.linearSessionId,
    ),
    // `agent-session:list` by project, filtered by status.
    projectStatusIndex: index("agent_sessions_project_status_idx").on(
      t.projectId,
      t.status,
    ),
    // Issue events find the sessions on an issue.
    issueIndex: index("agent_sessions_issue_idx").on(t.linearIssueId),
  }),
);

export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;
